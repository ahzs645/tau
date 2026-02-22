/**
 * OpenSCAD Kernel Module
 *
 * Full defineKernel implementation for the OpenSCAD kernel.
 * Handles WASM initialisation, Emscripten filesystem mounting,
 * use/include dependency resolution, parameter extraction, and
 * geometry computation via the OpenSCAD WASM engine.
 *
 * A fresh WASM instance is created per-render because the OpenSCAD
 * WASM build does not support multiple `callMain()` invocations.
 */

import { createOpenSCAD } from 'openscad-wasm-prebuilt';
import type { OpenSCAD } from 'openscad-wasm-prebuilt';
import { jsonDefault } from 'json-schema-default';
import type { JSONSchema7 } from 'json-schema';
import type {
  CreateGeometryInput,
  ExportGeometryInput,
  ExportGeometryResult,
  GetDependenciesInput,
  GetParametersInput,
  GetParametersResult,
  GeometryGltf,
  KernelFilesystem,
  KernelIssue,
  KernelLogger,
  KernelRuntime,
  LogLevel,
} from '@taucad/types';
import { defineKernel } from '@taucad/types';
import { logLevels } from '@taucad/types/constants';
import { asBuffer } from '@taucad/utils/file';
import { joinPath } from '@taucad/utils/path';
import type { OpenScadParameterExport } from '#kernels/openscad/parse-parameters.js';
import { processOpenScadParameters, flattenParametersForInjection } from '#kernels/openscad/parse-parameters.js';
import { convertOffToGltf } from '#utils/off-to-gltf.js';
import { convertOffToStl } from '#utils/off-to-stl.js';
import { convertOffTo3mf } from '#utils/off-to-3mf.js';
import { createKernelError, createKernelSuccess } from '#framework/kernel-helpers.js';
import type { AddErrorFn, GetFileContentsFn } from '#kernels/openscad/parse-output.js';
import { OpenScadStderrParser } from '#kernels/openscad/parse-output.js';

const geistRegularUrl = new URL('fonts/Geist-Regular.ttf', import.meta.url).href;
const geistBoldUrl = new URL('fonts/Geist-Bold.ttf', import.meta.url).href;

// =============================================================================
// Types & constants
// =============================================================================

type OpenScadContext = {
  fontCache: Map<string, Uint8Array<ArrayBuffer>>;
};

const maxIncludeDepth = 50;
const useIncludeRegex = /^\s*(?:use|include)\s*[<"]([^>"]+)[>"]/gm;

const fontsConf = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
</fontconfig>
`;

const fontFiles = [
  { url: geistRegularUrl, filename: 'Geist-Regular.ttf' },
  { url: geistBoldUrl, filename: 'Geist-Bold.ttf' },
] as const;

// =============================================================================
// Path helpers
// =============================================================================

function resolveToRelative(absolutePath: string, basePath: string): string {
  const normalizedBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  if (absolutePath.startsWith(`${normalizedBase}/`)) {
    return absolutePath.slice(normalizedBase.length + 1);
  }

  return absolutePath;
}

function resolveFromRoot(relativePath: string, basePath: string): string {
  return joinPath(basePath, relativePath);
}

function getBasename(filename: string): string {
  const lastSlash = filename.lastIndexOf('/');
  return lastSlash === -1 ? filename : filename.slice(lastSlash + 1);
}

// =============================================================================
// OpenSCAD dependency resolution
// =============================================================================

function parseUseIncludeStatements(code: string): string[] {
  const paths: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- RegExp match returns null
  let match: RegExpExecArray | null;
  useIncludeRegex.lastIndex = 0;
  while ((match = useIncludeRegex.exec(code)) !== null) {
    if (match[1]) {
      paths.push(match[1]);
    }
  }

  return paths;
}

function resolveIncludePath(baseFilePath: string, relativePath: string): string {
  const lastSlash = baseFilePath.lastIndexOf('/');
  const baseDir = lastSlash === -1 ? '' : baseFilePath.slice(0, lastSlash);
  const combinedPath = baseDir ? joinPath(baseDir, relativePath) : relativePath;
  const segments = combinedPath.split('/');
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '..') {
      resolved.pop();
    } else if (segment !== '.' && segment !== '') {
      resolved.push(segment);
    }
  }

  return resolved.join('/');
}

async function getReferencedScadFiles(
  mainFile: string,
  basePath: string,
  filesystem: KernelFilesystem,
  logger: KernelLogger,
): Promise<string[]> {
  const visited = new Set<string>();
  const result: string[] = [];

  const resolveFile = async (filePath: string, depth: number): Promise<void> => {
    const normalizedPath = filePath.replace(/^\/+/, '');
    if (depth >= maxIncludeDepth) {
      logger.debug(`Max include depth (${maxIncludeDepth}) reached for ${normalizedPath}`);
      return;
    }

    if (visited.has(normalizedPath)) {
      return;
    }

    visited.add(normalizedPath);

    let code: string;
    try {
      code = await filesystem.readFile(resolveFromRoot(normalizedPath, basePath), 'utf8');
    } catch {
      logger.debug(`Could not read file ${normalizedPath} for dependency resolution`);
      return;
    }

    result.push(normalizedPath);

    const dependencies = parseUseIncludeStatements(code);
    for (const depPath of dependencies) {
      const resolvedPath = resolveIncludePath(normalizedPath, depPath);
      // eslint-disable-next-line no-await-in-loop -- sequential for depth tracking
      await resolveFile(resolvedPath, depth + 1);
    }
  };

  await resolveFile(mainFile, 0);
  return result;
}

// =============================================================================
// OpenSCAD WASM instance management
// =============================================================================

function parseLogLevel(message: string): LogLevel {
  if (message.includes('ERROR')) {
    return logLevels.error;
  }

  if (message.includes('WARNING')) {
    return logLevels.warn;
  }

  return logLevels.info;
}

async function createInstance(options: {
  logger: KernelLogger;
  addError?: AddErrorFn;
  getFileContents?: GetFileContentsFn;
  mainFilePath?: string;
}): Promise<OpenSCAD> {
  const { logger, addError, getFileContents, mainFilePath } = options;
  const stderrParser = addError ? new OpenScadStderrParser(addError, getFileContents, mainFilePath) : undefined;

  const instance = await createOpenSCAD({
    noInitialRun: true,
    print(message: string) {
      logger.custom(parseLogLevel(message), message, { data: { operation: 'internal' } });
    },
    printErr(message: string) {
      logger.custom(parseLogLevel(message), message, { data: { operation: 'internal' } });
      stderrParser?.parseLine(message);
    },
  });

  return instance.getInstance();
}

// =============================================================================
// Emscripten FS helpers
// =============================================================================

function ensureDirectoryForFile(instance: OpenSCAD, filePath: string): void {
  const lastSlashIndex = filePath.lastIndexOf('/');
  if (lastSlashIndex <= 0) {
    return;
  }

  const dirPath = filePath.slice(0, lastSlashIndex);
  const dirSegments = dirPath.split('/');
  let currentPath = '';
  for (const segment of dirSegments) {
    currentPath = currentPath ? joinPath(currentPath, segment) : segment;
    try {
      instance.FS.mkdir(currentPath);
    } catch {
      // Already exists
    }
  }
}

async function mountFilesystem(
  instance: OpenSCAD,
  options: {
    mainFile: string;
    basePath: string;
    filesystem: KernelFilesystem;
    logger: KernelLogger;
    fileContentCache: ReadonlyMap<string, Uint8Array<ArrayBuffer> | string>;
    fileContentsCache?: Map<string, string>;
  },
): Promise<void> {
  const { mainFile, basePath, filesystem, logger, fileContentCache, fileContentsCache } = options;

  (instance.FS as unknown as { chdir(path: string): void }).chdir('/');
  instance.FS.mkdir('/locale');

  const referencedFiles = await getReferencedScadFiles(mainFile, basePath, filesystem, logger);
  logger.debug(`Mounting ${referencedFiles.length} referenced files`);

  const uncachedAbsolutePaths = referencedFiles
    .map((rel) => resolveFromRoot(rel, basePath))
    .filter((abs) => !fileContentCache.has(abs));

  if (uncachedAbsolutePaths.length > 0) {
    logger.debug(`Batch-reading ${uncachedAbsolutePaths.length} uncached files`);
    await filesystem.readFiles(uncachedAbsolutePaths);
  }

  for (const relativePath of referencedFiles) {
    const absolutePath = resolveFromRoot(relativePath, basePath);
    const content =
      fileContentCache.get(absolutePath) ??
      // eslint-disable-next-line no-await-in-loop -- sequential fallback for cache misses
      (await filesystem.readFile(absolutePath));

    ensureDirectoryForFile(instance, relativePath);
    instance.FS.writeFile(relativePath, content);

    if (fileContentsCache && relativePath.endsWith('.scad')) {
      const textContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
      fileContentsCache.set(relativePath, textContent);
    }
  }
}

async function mountFonts(instance: OpenSCAD, ctx: OpenScadContext, logger: KernelLogger): Promise<void> {
  try {
    if (ctx.fontCache.size === 0) {
      logger.debug('Fetching fonts (first time)');
      const fontPromises = fontFiles.map(async ({ url, filename }) => {
        const response = await fetch(url, { cache: 'force-cache' });
        if (!response.ok) {
          throw new Error(`Failed to fetch font ${filename}: ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return { filename, data: new Uint8Array(arrayBuffer) };
      });

      const fonts = await Promise.all(fontPromises);
      for (const { filename, data } of fonts) {
        ctx.fontCache.set(filename, data);
      }
    }

    try {
      instance.FS.mkdir('/fonts');
    } catch {
      // Already exists
    }

    for (const [filename, data] of ctx.fontCache) {
      instance.FS.writeFile(`/fonts/${filename}`, data);
    }

    instance.FS.writeFile('/fonts/fonts.conf', fontsConf);
  } catch (error) {
    ctx.fontCache.clear();
    logger.warn('Failed to mount fonts - text() may not render correctly', { data: error });
  }
}

// =============================================================================
// Parameter helpers
// =============================================================================

async function getParametersFromFile(
  filePath: string,
  options: {
    basePath: string;
    filesystem: KernelFilesystem;
    logger: KernelLogger;
    fileContentCache: ReadonlyMap<string, Uint8Array<ArrayBuffer> | string>;
    fontCache: Map<string, Uint8Array<ArrayBuffer>>;
  },
): Promise<OpenScadParameterExport | undefined> {
  const { basePath, filesystem, logger, fileContentCache, fontCache } = options;
  const parameterFile = `${filePath}.params.json`;

  try {
    const instance = await createInstance({ logger });
    await mountFilesystem(instance, { mainFile: filePath, basePath, filesystem, logger, fileContentCache });
    await mountFonts(instance, { fontCache }, logger);

    const result = instance.callMain([filePath, '-o', parameterFile, '--export-format=param']);
    if (result !== 0) {
      logger.debug(`No parameters extracted from ${filePath} (exit code: ${result})`);
      return undefined;
    }

    const parameterData = instance.FS.readFile(parameterFile, { encoding: 'utf8' });
    const parsed = JSON.parse(parameterData) as OpenScadParameterExport;
    logger.debug(`Extracted ${parsed.parameters.length} parameters from ${filePath}`);
    return parsed;
  } catch (error) {
    logger.debug(`Failed to extract parameters from ${filePath}`, { data: error });
    return undefined;
  }
}

function getGroupNameFromPath(filePath: string): string {
  const fileName = getBasename(filePath);
  const nameWithoutExt = fileName.replace(/\.scad$/, '');
  return nameWithoutExt.charAt(0).toUpperCase() + nameWithoutExt.slice(1);
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return `"${value}"`;
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => formatValue(v)).join(', ')}]`;
  }

  return String(value);
}

// =============================================================================
// Kernel module definition
// =============================================================================

export default defineKernel<OpenScadContext, string>({
  name: 'OpenScadKernel',
  version: '1.0.0',

  async initialize() {
    return { fontCache: new Map() };
  },

  async canHandle({ extension }) {
    return extension === 'scad';
  },

  async getDependencies(
    { filePath, basePath }: GetDependenciesInput,
    { filesystem, logger }: KernelRuntime,
  ): Promise<string[]> {
    const relativeFilePath = resolveToRelative(filePath, basePath);
    const relativePaths = await getReferencedScadFiles(relativeFilePath, basePath, filesystem, logger);
    return relativePaths.map((relativePath) => resolveFromRoot(relativePath, basePath));
  },

  async getParameters(
    { filePath, basePath }: GetParametersInput,
    { filesystem, logger, fileContentCache }: KernelRuntime,
    ctx: OpenScadContext,
  ): Promise<GetParametersResult> {
    try {
      const mainFilePath = resolveToRelative(filePath, basePath);
      const referencedFiles = await getReferencedScadFiles(mainFilePath, basePath, filesystem, logger);

      const allParameters: OpenScadParameterExport['parameters'] = [];

      for (const scadFile of referencedFiles) {
        // eslint-disable-next-line no-await-in-loop -- sequential: each file needs its own WASM instance
        const extractedParameters = await getParametersFromFile(scadFile, {
          basePath,
          filesystem,
          logger,
          fileContentCache,
          fontCache: ctx.fontCache,
        });

        const parameters = extractedParameters?.parameters;
        if (!parameters || !Array.isArray(parameters)) {
          continue;
        }

        const isMainFile = scadFile === mainFilePath;
        for (const parameter of parameters) {
          if (parameter.name.startsWith('$')) {
            continue;
          }

          const needsFileGroup =
            !isMainFile && (!parameter.group || parameter.group === 'Global' || parameter.group === 'Parameters');

          if (needsFileGroup) {
            allParameters.push({ ...parameter, group: getGroupNameFromPath(scadFile) });
          } else {
            allParameters.push(parameter);
          }
        }
      }

      let jsonSchema: JSONSchema7 = { type: 'object' };
      let defaultParameters: Record<string, unknown> = {};

      if (allParameters.length > 0) {
        const mergedExport: OpenScadParameterExport = { parameters: allParameters, title: mainFilePath };
        jsonSchema = processOpenScadParameters(mergedExport);
        defaultParameters = jsonDefault(jsonSchema) as Record<string, unknown>;
      } else {
        jsonSchema = { type: 'object', properties: {}, additionalProperties: false };
      }

      return createKernelSuccess({ defaultParameters, jsonSchema });
    } catch (error) {
      logger.error('Error extracting parameters', { data: error });
      const relativeFilePath = resolveToRelative(filePath, basePath);
      return createKernelError([
        {
          message: error instanceof Error ? error.message : 'Unknown error',
          location: { fileName: relativeFilePath, startLineNumber: 1, startColumn: 1 },
          severity: 'error',
        },
      ]);
    }
  },

  async createGeometry(
    { filePath, basePath, parameters }: CreateGeometryInput,
    { filesystem, logger, fileContentCache, tracer }: KernelRuntime,
    ctx: OpenScadContext,
  ) {
    const relativeFilePath = resolveToRelative(filePath, basePath);
    const fileContentsCache = new Map<string, string>();
    const getFileContents: GetFileContentsFn = (fileName: string) => fileContentsCache.get(fileName);

    const collectedIssues: KernelIssue[] = [];
    const addError: AddErrorFn = (issue: KernelIssue) => {
      collectedIssues.push(issue);
    };

    try {
      const code = await filesystem.readFile(filePath, 'utf8');
      if (code.trim() === '') {
        return { geometry: [], nativeHandle: '' };
      }

      const wasmSpan = tracer.startSpan('openscad.wasm-init');
      const instance = await createInstance({ logger, addError, getFileContents, mainFilePath: relativeFilePath });
      wasmSpan.end();

      await mountFilesystem(instance, {
        mainFile: relativeFilePath,
        basePath,
        filesystem,
        logger,
        fileContentCache,
        fileContentsCache,
      });

      const fontSpan = tracer.startSpan('openscad.mount-fonts');
      await mountFonts(instance, ctx, logger);
      fontSpan.end();

      instance.FS.writeFile(relativeFilePath, code);

      const args = [relativeFilePath, '-o', `${relativeFilePath}.off`, '--backend=manifold'];
      const flattenedParameters = flattenParametersForInjection(parameters);
      for (const [key, value] of Object.entries(flattenedParameters)) {
        args.push(`-D${key}=${formatValue(value)}`);
      }

      const callMainSpan = tracer.startSpan('openscad.call-main', { phase: 'computingGeometry' });
      const result = instance.callMain(args);
      callMainSpan.end();

      if (result !== 0) {
        const hasActualErrors = collectedIssues.some((issue) => issue.severity === 'error');
        if (!hasActualErrors && collectedIssues.length > 0) {
          return { geometry: [], nativeHandle: '', issues: collectedIssues };
        }

        if (collectedIssues.length > 0) {
          throw new OpenScadBuildError(collectedIssues);
        }

        throw new Error('OpenSCAD build failed');
      }

      const offData = instance.FS.readFile(`${relativeFilePath}.off`, { encoding: 'utf8' });

      const convertSpan = tracer.startSpan('openscad.convert-geometry', { phase: 'computingGeometry' });
      const gltfBlob = await convertOffToGltf(offData, 'glb');
      convertSpan.end();

      const geometry: GeometryGltf = { format: 'gltf', content: gltfBlob };
      return { geometry: [geometry], nativeHandle: offData, issues: collectedIssues };
    } catch (error) {
      if (error instanceof OpenScadBuildError) {
        throw error;
      }

      if (collectedIssues.length > 0) {
        throw new OpenScadBuildError(collectedIssues);
      }

      throw error;
    }
  },

  async exportGeometry(
    { fileType }: ExportGeometryInput,
    _runtime: KernelRuntime,
    _ctx: OpenScadContext,
    nativeHandle: string,
  ): Promise<ExportGeometryResult> {
    if (!nativeHandle) {
      return createKernelError([
        { message: 'No geometry available for export. Please build geometries before exporting.', severity: 'error' },
      ]);
    }

    switch (fileType) {
      case 'glb': {
        const blob = await convertOffToGltf(nativeHandle, 'glb');
        return createKernelSuccess([{ blob: new Blob([asBuffer(blob.buffer)]), name: 'model.glb' }]);
      }

      case 'gltf': {
        const blob = await convertOffToGltf(nativeHandle, 'gltf');
        return createKernelSuccess([{ blob: new Blob([asBuffer(blob.buffer)]), name: 'model.gltf' }]);
      }

      case 'stl': {
        const blob = await convertOffToStl(nativeHandle, 'stl');
        return createKernelSuccess([{ blob, name: 'model.stl' }]);
      }

      case 'stl-binary': {
        const blob = await convertOffToStl(nativeHandle, 'stl-binary');
        return createKernelSuccess([{ blob, name: 'model.stl' }]);
      }

      case '3mf': {
        const blob = await convertOffTo3mf(nativeHandle);
        return createKernelSuccess([{ blob, name: 'model.3mf' }]);
      }

      default: {
        return createKernelError([{ message: `Unsupported export format: ${fileType}`, severity: 'error' }]);
      }
    }
  },
});

class OpenScadBuildError extends Error {
  public readonly issues: KernelIssue[];
  public constructor(issues: KernelIssue[]) {
    super(issues.map((i) => i.message).join('; '));
    this.issues = issues;
  }
}
