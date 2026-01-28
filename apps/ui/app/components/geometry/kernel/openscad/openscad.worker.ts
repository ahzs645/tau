import { createOpenSCAD } from 'openscad-wasm-prebuilt';
import type { OpenSCAD } from 'openscad-wasm-prebuilt';
import { jsonDefault } from 'json-schema-default';
import type { JSONSchema7 } from 'json-schema';
import type {
  CreateGeometryResult,
  ExportGeometryResult,
  GetParametersResult,
  ExportFormat,
  GeometryGltf,
  KernelIssue,
  KernelRuntime,
  KernelFilesystem,
  KernelLogger,
  CanHandleInput,
  GetDependenciesInput,
  GetParametersInput,
  CreateGeometryInput,
  ExportGeometryInput,
  LogLevel,
} from '@taucad/types';
import { logLevels } from '@taucad/types/constants';
import type { OpenScadParameterExport } from '#components/geometry/kernel/openscad/parse-parameters.js';
import { exposeWorker } from '#components/geometry/kernel/utils/comlink-worker.utils.js';
import {
  processOpenScadParameters,
  flattenParametersForInjection,
} from '#components/geometry/kernel/openscad/parse-parameters.js';
import { convertOffToGltf } from '#components/geometry/kernel/utils/off-to-gltf.js';
import { convertOffToStl } from '#components/geometry/kernel/utils/off-to-stl.js';
import { convertOffTo3mf } from '#components/geometry/kernel/utils/off-to-3mf.js';
import { asBuffer } from '#utils/file.utils.js';
import { joinPath } from '#utils/path.utils.js';
import { KernelWorker } from '#components/geometry/kernel/utils/kernel-worker.js';
import { createKernelError, createKernelSuccess } from '#components/geometry/kernel/utils/kernel-helpers.js';
import type { AddErrorFn, GetFileContentsFn } from '#components/geometry/kernel/openscad/parse-output.js';
import { parseStderrLine } from '#components/geometry/kernel/openscad/parse-output.js';
// Font files for OpenSCAD text() rendering (Vite ?url imports)
import geistRegularUrl from '#components/geometry/kernel/openscad/fonts/Geist-Regular.ttf?url';
import geistBoldUrl from '#components/geometry/kernel/openscad/fonts/Geist-Bold.ttf?url';
import { wrapForComlink } from '#components/geometry/kernel/utils/kernel-comlink-adapter.js';

/**
 * Options for creating an OpenSCAD WASM instance.
 */
type CreateInstanceOptions = {
  /** Logger for outputting print/printErr messages. Required. */
  logger: KernelLogger;
  /** Optional callback to receive parsed errors from stderr in real-time. */
  addError?: AddErrorFn;
  /** Optional function to lazily fetch file contents for error highlighting. */
  getFileContents?: GetFileContentsFn;
  /**
   * Optional full relative path of the main file (e.g., "site/backyard.scad").
   * Used to map basename errors back to full paths for FileLink navigation.
   */
  mainFilePath?: string;
};

/**
 * Font configuration for fontconfig.
 * Empty config - OpenSCAD WASM has default behavior that looks for fonts
 * in ./fonts relative to cwd (set via chdir('/')).
 */
const fontsConf = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
</fontconfig>
`;

/**
 * Font files to load for OpenSCAD text() rendering.
 * These use Vite's ?url imports for colocated font assets.
 */
const fontFiles = [
  { url: geistRegularUrl, filename: 'Geist-Regular.ttf' },
  { url: geistBoldUrl, filename: 'Geist-Bold.ttf' },
] as const;

export class OpenScadWorker extends KernelWorker {
  protected static override readonly supportedExportFormats: ExportFormat[] = [
    'stl',
    'stl-binary',
    'glb',
    'gltf',
    '3mf',
  ];

  /**
   * Maximum recursion depth for resolving use/include dependencies.
   * Prevents infinite loops in circular dependencies.
   */
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style -- Must be static to match useIncludeRegex pattern
  private static readonly maxIncludeDepth = 50;

  /**
   * Regex to match OpenSCAD use and include statements.
   * Matches: use <path/to/file.scad> or include <path/to/file.scad>
   * Also handles quoted paths: use "path/to/file.scad"
   */
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style -- Must be static; a getter would return a new regex instance each access, breaking exec() loop state tracking via lastIndex
  private static readonly useIncludeRegex = /^\s*(?:use|include)\s*[<"]([^>"]+)[>"]/gm;

  protected override readonly name: string = 'OpenScadWorker';

  private offDataMemory: Record<string, string> = {};

  /**
   * Cached font data to avoid re-fetching on every OpenSCAD instance.
   * Maps filename to Uint8Array of font data.
   */
  private fontCache: Map<string, Uint8Array<ArrayBuffer>> | undefined;

  /**
   * Get the raw OFF data for a geometry (for testing/debugging purposes).
   *
   * @param geometryId - The geometry ID to get OFF data for.
   * @returns The raw OFF data string or undefined if not found.
   */
  public getOffData(geometryId = 'default'): string | undefined {
    return this.offDataMemory[geometryId];
  }

  protected override async canHandle({ extension }: CanHandleInput): Promise<boolean> {
    return extension === 'scad';
  }

  protected override async getDependencies(
    { filePath, basePath }: GetDependenciesInput,
    { filesystem, logger }: KernelRuntime,
  ): Promise<string[]> {
    // Get relative path for dependency resolution (relative to project root)
    const relativeFilePath = KernelWorker.resolveToRelative(filePath, basePath);
    const relativePaths = await this.getReferencedScadFiles(relativeFilePath, basePath, filesystem, logger);
    // Convert relative paths to absolute paths
    return relativePaths.map((relativePath) => KernelWorker.resolveFromRoot(relativePath, basePath));
  }

  protected override getAssetUrls(): string[] {
    return [geistRegularUrl, geistBoldUrl];
  }

  protected override async getParameters(
    { filePath, basePath }: GetParametersInput,
    { filesystem, logger }: KernelRuntime,
  ): Promise<GetParametersResult> {
    try {
      // Get only .scad files that are transitively referenced from the main file
      // via use/include statements. This prevents extracting parameters from
      // unrelated files in the project.
      // Use relative path (relative to project root) to correctly resolve relative includes.
      const mainFilePath = KernelWorker.resolveToRelative(filePath, basePath);
      const referencedFiles = await this.getReferencedScadFiles(mainFilePath, basePath, filesystem, logger);

      logger.debug(`Extracting parameters from ${referencedFiles.length} referenced files`, {
        data: { files: referencedFiles, mainFile: mainFilePath },
      });

      // Collect parameters from all referenced files
      const allParameters: OpenScadParameterExport['parameters'] = [];

      for (const scadFile of referencedFiles) {
        // Create a fresh OpenSCAD instance for each file
        // This is necessary because OpenSCAD WASM doesn't properly support multiple callMain invocations
        // eslint-disable-next-line no-await-in-loop -- Sequential processing required: each file needs its own instance
        const extractedParameters = await this.getParametersFromFile(scadFile, basePath, filesystem, logger);

        // Defensive check: ensure extracted params exists and has a valid parameters array
        const parameters = extractedParameters?.parameters;
        if (!parameters || !Array.isArray(parameters)) {
          continue;
        }

        // Add file context to group name for parameters from non-main files
        // Compare with mainFilePath (full relative path) not filename (basename)
        const isMainFile = scadFile === mainFilePath;
        for (const parameter of parameters) {
          // Skip internal OpenSCAD parameters
          if (parameter.name.startsWith('$')) {
            continue;
          }

          // For included files, preserve their group or use filename as group
          const needsFileGroup =
            !isMainFile && (!parameter.group || parameter.group === 'Global' || parameter.group === 'Parameters');

          if (needsFileGroup) {
            const fileGroup = this.getGroupNameFromPath(scadFile);
            allParameters.push({ ...parameter, group: fileGroup });
          } else {
            allParameters.push(parameter);
          }
        }
      }

      let jsonSchema: JSONSchema7 = { type: 'object' };
      let defaultParameters: Record<string, unknown> = {};

      if (allParameters.length > 0) {
        const mergedExport: OpenScadParameterExport = {
          parameters: allParameters,
          title: mainFilePath,
        };

        jsonSchema = processOpenScadParameters(mergedExport);
        // NOTE: json-schema-default has a bug where it returns {} for oneOf properties with
        // falsy defaults (e.g., 0, false, ""). Example: `shape_type = 0; // [0:Cube, 1:Sphere]`
        // generates a schema with `default: 0` and oneOf, but jsonDefault() returns
        // `{ shape_type: {} }` instead of `{ shape_type: 0 }`. This affects parameters where
        // the first option (index 0) is the default. Consider post-processing to fix {} values
        // by reading defaults directly from the schema, or replacing this library.
        defaultParameters = jsonDefault(jsonSchema) as Record<string, unknown>;
      } else {
        jsonSchema = { type: 'object', properties: {}, additionalProperties: false };
        defaultParameters = {};
      }

      return createKernelSuccess({
        defaultParameters,
        jsonSchema,
      });
    } catch (error) {
      logger.error('Error extracting parameters', { data: error });
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // Get relative path for error location
      const relativeFilePath = KernelWorker.resolveToRelative(filePath, basePath);
      return createKernelError([
        {
          message: errorMessage,
          location: { fileName: relativeFilePath, startLineNumber: 1, startColumn: 1 },
          severity: 'error',
        },
      ]);
    }
  }

  protected override async createGeometry(
    { filePath, basePath, parameters }: CreateGeometryInput,
    { filesystem, logger }: KernelRuntime,
  ): Promise<CreateGeometryResult> {
    const geometryId = 'default';
    // Get relative path from absolute path
    const relativeFilePath = KernelWorker.resolveToRelative(filePath, basePath);

    // Cache for file contents - populated during mountFilesystem, used for error highlighting
    const fileContentsCache = new Map<string, string>();

    // Lazy file contents getter - returns cached content for error highlighting
    const getFileContents: GetFileContentsFn = (fileName: string) => {
      return fileContentsCache.get(fileName);
    };

    // Collect issues from stderr parsing in real-time
    const collectedIssues: KernelIssue[] = [];
    const addError = (issue: KernelIssue): void => {
      collectedIssues.push(issue);
    };

    try {
      const code = await filesystem.readFile(filePath, 'utf8');
      const trimmedCode = code.trim();
      if (trimmedCode === '') {
        return createKernelSuccess([]);
      }

      // Pass the full relative path to createInstance so error file paths can be
      // mapped from basename back to full relative path for FileLink navigation
      const instance = await this.createInstance({
        logger,
        addError,
        getFileContents,
        mainFilePath: relativeFilePath,
      });
      await this.mountFilesystem(instance, { basePath, filesystem, logger, fileContentsCache });
      await this.mountFonts(instance, logger);

      // Use full project-relative path for input/output files
      const inputFile = relativeFilePath;
      const outputFile = `${relativeFilePath}.off`;

      instance.FS.writeFile(inputFile, code);

      const args = [inputFile, '-o', outputFile, '--backend=manifold'];

      const flattenedParameters = flattenParametersForInjection(parameters);
      for (const [key, value] of Object.entries(flattenedParameters)) {
        args.push(`-D${key}=${this.formatValue(value)}`);
      }

      const result = instance.callMain(args);

      if (result !== 0) {
        // Check if there are actual errors (not just warnings)
        const hasActualErrors = collectedIssues.some((issue) => issue.severity === 'error');

        // If we only have warnings (e.g., empty top level object), treat as success with warnings
        if (!hasActualErrors && collectedIssues.length > 0) {
          return createKernelSuccess([], collectedIssues);
        }

        // Return all collected issues (errors + warnings) for full diagnostic context
        if (collectedIssues.length > 0) {
          return createKernelError(collectedIssues);
        }

        // Fallback error when OpenSCAD fails without a parseable error message
        return createKernelError([
          {
            message: 'OpenSCAD build failed',
            location: { fileName: relativeFilePath, startLineNumber: 1, startColumn: 1 },
            severity: 'error',
          },
        ]);
      }

      const offData = instance.FS.readFile(outputFile, { encoding: 'utf8' });
      this.offDataMemory[geometryId] = offData;

      const gltfBlob = await convertOffToGltf(offData, 'glb');

      const geometry: GeometryGltf = {
        format: 'gltf',
        content: gltfBlob,
      };

      // Return warnings (non-error issues) with the successful result
      const warnings = collectedIssues.filter((issue) => issue.severity !== 'error');
      return createKernelSuccess([geometry], warnings);
    } catch (error) {
      logger.error('Error while building geometries from code', { data: error });

      // Return parsed issues if we collected any before the exception
      if (collectedIssues.length > 0) {
        return createKernelError(collectedIssues);
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return createKernelError([
        {
          message: errorMessage,
          location: { fileName: relativeFilePath, startLineNumber: 1, startColumn: 1 },
          severity: 'error',
        },
      ]);
    }
  }

  protected override async exportGeometry({ fileType }: ExportGeometryInput): Promise<ExportGeometryResult> {
    const geometryId = 'default';
    try {
      const offData = this.offDataMemory[geometryId];
      if (!offData) {
        // System error - no location needed
        return createKernelError([
          {
            message: `Geometry ${geometryId} not computed yet. Please build geometries before exporting.`,
            severity: 'error',
          },
        ]);
      }

      switch (fileType) {
        case 'glb': {
          const gltfBlob = await convertOffToGltf(offData, 'glb');
          return createKernelSuccess([{ blob: new Blob([asBuffer(gltfBlob.buffer)]), name: 'model.glb' }]);
        }

        case 'gltf': {
          const gltfBlob = await convertOffToGltf(offData, 'gltf');
          return createKernelSuccess([{ blob: new Blob([asBuffer(gltfBlob.buffer)]), name: 'model.gltf' }]);
        }

        case 'stl': {
          const stlBlob = await convertOffToStl(offData, 'stl');
          return createKernelSuccess([{ blob: stlBlob, name: 'model.stl' }]);
        }

        case 'stl-binary': {
          const stlBlob = await convertOffToStl(offData, 'stl-binary');
          return createKernelSuccess([{ blob: stlBlob, name: 'model.stl' }]);
        }

        case '3mf': {
          const threeMfBlob = await convertOffTo3mf(offData);
          return createKernelSuccess([{ blob: threeMfBlob, name: 'model.3mf' }]);
        }

        default: {
          return createKernelError([{ message: `Unsupported export format: ${fileType}`, severity: 'error' }]);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return createKernelError([{ message: errorMessage, severity: 'error' }]);
    }
  }

  /**
   * Extract parameters from a single .scad file using OpenSCAD's --export-format=param.
   * Creates a fresh OpenSCAD instance for this file to avoid state issues.
   *
   * @param filePath - The path to the .scad file.
   * @param basePath - The project root path.
   * @param filesystem - Filesystem interface for reading files.
   * @param logger - Logger interface for debug output.
   * @returns The extracted parameters or undefined if extraction fails.
   */
  private async getParametersFromFile(
    filePath: string,
    basePath: string,
    filesystem: KernelFilesystem,
    logger: KernelLogger,
  ): Promise<OpenScadParameterExport | undefined> {
    const parameterFile = `${filePath}.params.json`;

    try {
      // Create a fresh instance for each file - OpenSCAD WASM doesn't support multiple callMain calls
      const instance = await this.createInstance({ logger });
      await this.mountFilesystem(instance, { basePath, filesystem, logger });

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

  /**
   * Parse use and include statements from OpenSCAD code.
   *
   * @param code - The OpenSCAD source code.
   * @returns Array of file paths referenced via use or include.
   */
  private parseUseIncludeStatements(code: string): string[] {
    const paths: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-restricted-types -- RegExp missing match returns null
    let match: RegExpExecArray | null;

    // Reset regex state for fresh matching
    OpenScadWorker.useIncludeRegex.lastIndex = 0;

    while ((match = OpenScadWorker.useIncludeRegex.exec(code)) !== null) {
      const path = match[1];
      if (path) {
        paths.push(path);
      }
    }

    return paths;
  }

  /**
   * Resolve a relative path from a base file's directory.
   * Handles ../ and ./ path segments.
   *
   * @param basePath - The path of the file containing the use/include statement.
   * @param relativePath - The relative path from the use/include statement.
   * @returns The resolved absolute path relative to the project root.
   */
  private resolveIncludePath(basePath: string, relativePath: string): string {
    // Get the directory of the base file
    const lastSlash = basePath.lastIndexOf('/');
    const baseDir = lastSlash === -1 ? '' : basePath.slice(0, lastSlash);

    // Combine base directory with relative path
    const combinedPath = baseDir ? joinPath(baseDir, relativePath) : relativePath;

    // Normalize the path by resolving . and .. segments
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

  /**
   * Get all .scad files that are transitively referenced from the main file
   * via use and include statements.
   *
   * @param mainFile - The main entry point file (relative to project root).
   * @param basePath - The project root path.
   * @param filesystem - Filesystem interface for reading files.
   * @param logger - Logger interface for debug output.
   * @returns Array of relative file paths to .scad files (including the main file).
   */
  private async getReferencedScadFiles(
    mainFile: string,
    basePath: string,
    filesystem: KernelFilesystem,
    logger: KernelLogger,
  ): Promise<string[]> {
    const visited = new Set<string>();
    const result: string[] = [];

    // Recursive helper with depth tracking
    const resolveFile = async (filePath: string, depth: number): Promise<void> => {
      // Normalize path for consistent tracking
      const normalizedPath = filePath.replace(/^\/+/, '');

      // Check depth limit
      if (depth >= OpenScadWorker.maxIncludeDepth) {
        logger.debug(`Max include depth (${OpenScadWorker.maxIncludeDepth}) reached for ${normalizedPath}`);
        return;
      }

      // Skip if already visited (handles circular dependencies)
      if (visited.has(normalizedPath)) {
        return;
      }

      visited.add(normalizedPath);

      // Try to read the file from project root (not basePath)
      // This allows resolving paths like '../lib/shared.scad' correctly
      let code: string;
      try {
        code = await filesystem.readFile(KernelWorker.resolveFromRoot(normalizedPath, basePath), 'utf8');
      } catch {
        logger.debug(`Could not read file ${normalizedPath} for dependency resolution`);
        return;
      }

      // Add this file to results
      result.push(normalizedPath);

      // Parse use/include statements and recursively resolve
      const dependencies = this.parseUseIncludeStatements(code);

      for (const depPath of dependencies) {
        const resolvedPath = this.resolveIncludePath(normalizedPath, depPath);
        // eslint-disable-next-line no-await-in-loop -- Sequential processing required for proper depth tracking
        await resolveFile(resolvedPath, depth + 1);
      }
    };

    await resolveFile(mainFile, 0);

    return result;
  }

  /**
   * Generate a group name from a file path.
   * Converts "lib/parameters.scad" to "Parameters" (capitalized, without path prefix and extension).
   *
   * @param filePath - The file path.
   * @returns A human-readable group name.
   */
  private getGroupNameFromPath(filePath: string): string {
    // Remove directory prefix and extension
    const fileName = KernelWorker.getBasename(filePath);
    const nameWithoutExt = fileName.replace(/\.scad$/, '');

    // Capitalize first letter
    return nameWithoutExt.charAt(0).toUpperCase() + nameWithoutExt.slice(1);
  }

  /**
   * Create an OpenSCAD WASM instance.
   *
   * @param options - Options for creating the instance.
   * @returns The OpenSCAD instance.
   */
  private async createInstance(options: CreateInstanceOptions): Promise<OpenSCAD> {
    const { logger, addError, getFileContents, mainFilePath } = options;

    /**
     * Parse the log level from an OpenSCAD message.
     * Maps OpenSCAD output patterns to standard log levels.
     */
    const parseLogLevel = (message: string): LogLevel => {
      if (message.includes('ERROR')) {
        return logLevels.error;
      }

      if (message.includes('WARNING')) {
        return logLevels.warn;
      }

      return logLevels.info;
    };

    const instance = await createOpenSCAD({
      noInitialRun: true,
      print(message) {
        logger.custom(parseLogLevel(message), message, { data: { operation: 'internal' } });
      },
      printErr(message) {
        logger.custom(parseLogLevel(message), message, { data: { operation: 'internal' } });
        if (addError) {
          parseStderrLine(message, addError, getFileContents, mainFilePath);
        }
      },
    });

    return instance.getInstance();
  }

  private formatValue(value: unknown): string {
    if (typeof value === 'string') {
      return `"${value}"`;
    }

    if (Array.isArray(value)) {
      return `[${value.map((v) => this.formatValue(v)).join(', ')}]`;
    }

    return String(value);
  }

  /**
   * Mount the project filesystem into Emscripten's FS.
   * Pre-populates all files from project root so OpenSCAD can access them,
   * including files in sibling directories (for relative paths like ../lib/file.scad).
   * Optionally populates a cache with .scad file contents for error highlighting.
   *
   * @param instance - The OpenSCAD instance with FS API.
   * @param options.basePath - The project root path.
   * @param options.filesystem - Filesystem interface for reading files.
   * @param options.logger - Logger interface for debug output.
   * @param options.fileContentsCache - Optional cache to populate with .scad file contents.
   */
  private async mountFilesystem(
    instance: OpenSCAD,
    options: {
      basePath: string;
      filesystem: KernelFilesystem;
      logger: KernelLogger;
      fileContentsCache?: Map<string, string>;
    },
  ): Promise<void> {
    const { basePath, filesystem, logger, fileContentsCache } = options;
    try {
      logger.debug('Mounting filesystem from project root', { data: { basePath } });

      // Change to root directory FIRST - all file operations should be relative to /
      // This is critical for font resolution (fonts are at /fonts relative to cwd)
      // @ts-expect-error - chdir exists on Emscripten FS but is not typed in openscad-wasm-prebuilt
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- chdir is untyped but exists on Emscripten FS
      instance.FS.chdir('/');

      // Get all files from the project root (includes sibling directories)
      const files = await filesystem.getDirectoryContents(basePath);
      const fileCount = Object.keys(files).length;

      logger.debug(`Found ${fileCount} files to mount`);

      // Add locale directory - required to silence OpenSCAD warnings about missing locale directory
      instance.FS.mkdir('/locale');

      // Create directories and write files into Emscripten FS
      for (const [relativePath, content] of Object.entries(files)) {
        this.ensureDirectoryForFile(instance, relativePath);

        // Write the file
        instance.FS.writeFile(relativePath, content);
        logger.trace(`Mounted file: ${relativePath}`);

        // Cache .scad file contents for error highlighting
        if (fileContentsCache && relativePath.endsWith('.scad')) {
          const textContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
          fileContentsCache.set(relativePath, textContent);
        }
      }

      logger.debug(`Successfully mounted ${fileCount} files`);
    } catch (error) {
      logger.error('Failed to mount filesystem', { data: error });
      throw error;
    }
  }

  /**
   * Create nested directories for a file path in Emscripten's FS.
   * Silently ignores errors if directories already exist.
   *
   * @param instance - The OpenSCAD instance with FS API.
   * @param filePath - The relative file path.
   */
  private ensureDirectoryForFile(instance: OpenSCAD, filePath: string): void {
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
        // Directory already exists, ignore error
      }
    }
  }

  /**
   * Mount fonts into Emscripten's FS for OpenSCAD text() rendering.
   * Fetches TTF fonts from the public folder and writes them to /fonts/ in the virtual FS.
   * Font data is cached to avoid re-fetching on subsequent OpenSCAD instances.
   *
   * @param instance - The OpenSCAD instance with FS API.
   * @param logger - Logger interface for debug output.
   */
  private async mountFonts(instance: OpenSCAD, logger: KernelLogger): Promise<void> {
    try {
      logger.debug('Mounting fonts for text rendering');

      // Fetch and cache fonts if not already cached
      if (!this.fontCache) {
        logger.debug('Fetching fonts (first time)');
        this.fontCache = new Map();

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
          this.fontCache.set(filename, data);
          logger.trace(`Cached font: ${filename} (${data.byteLength} bytes)`);
        }
      }

      // Create /fonts directory in Emscripten FS
      try {
        instance.FS.mkdir('/fonts');
      } catch {
        // Directory may already exist, ignore error
      }

      // Write fonts to Emscripten FS
      for (const [filename, data] of this.fontCache) {
        instance.FS.writeFile(`/fonts/${filename}`, data);
        logger.trace(`Mounted font: /fonts/${filename}`);
      }

      // Write fonts.conf for fontconfig
      instance.FS.writeFile('/fonts/fonts.conf', fontsConf);
      logger.trace('Mounted fonts.conf');

      // Note: chdir('/') is called in mountFilesystem before this method
      // so fontconfig will resolve fonts from ./fonts (i.e., /fonts)

      logger.debug(`Successfully mounted ${this.fontCache.size} fonts`);
    } catch (error) {
      // Reset fontCache so next call will retry fetching
      this.fontCache = undefined;
      // Log warning but don't fail - text rendering just won't work
      logger.warn('Failed to mount fonts - text() may not render correctly', { data: error });
    }
  }
}

const worker = new OpenScadWorker();
const service = wrapForComlink(worker);
exposeWorker(service);

export type OpenScadBuilderInterface = typeof service;
