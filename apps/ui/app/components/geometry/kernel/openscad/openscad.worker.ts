import { expose } from 'comlink';
import { createOpenSCAD } from 'openscad-wasm-prebuilt';
import type { OpenSCAD } from 'openscad-wasm-prebuilt';
import { jsonDefault } from 'json-schema-default';
import type { JSONSchema7 } from 'json-schema';
import type {
  ComputeGeometryResult,
  ExportGeometryResult,
  ExtractParametersResult,
  ExportFormat,
  GeometryGltf,
  KernelIssue,
} from '@taucad/types';
import type { OpenScadParameterExport } from '#components/geometry/kernel/openscad/parse-parameters.js';
import {
  processOpenScadParameters,
  flattenParametersForInjection,
} from '#components/geometry/kernel/openscad/parse-parameters.js';
import { convertOffToGltf } from '#components/geometry/kernel/utils/off-to-gltf.js';
import { convertOffToStl } from '#components/geometry/kernel/utils/off-to-stl.js';
import { convertOffTo3mf } from '#components/geometry/kernel/utils/off-to-3mf.js';
import { asBuffer } from '#utils/file.utils.js';
import { logLevels } from '#types/console.types.js';
import type { LogLevel } from '#types/console.types.js';
import { KernelWorker } from '#components/geometry/kernel/utils/kernel-worker.js';
import { createKernelError, createKernelSuccess } from '#components/geometry/kernel/utils/kernel-helpers.js';
import type { AddErrorFn, GetFileContentsFn } from '#components/geometry/kernel/openscad/parse-output.js';
import { parseStderrLine } from '#components/geometry/kernel/openscad/parse-output.js';
// Font files for OpenSCAD text() rendering (Vite ?url imports)
import geistRegularUrl from '#components/geometry/kernel/openscad/fonts/Geist-Regular.ttf?url';
import geistBoldUrl from '#components/geometry/kernel/openscad/fonts/Geist-Bold.ttf?url';

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

  protected override readonly name: string = 'OpenScadWorker';

  private offDataMemory: Record<string, string> = {};

  /**
   * Cached font data to avoid re-fetching on every OpenSCAD instance.
   * Maps filename to Uint8Array of font data.
   */
  private fontCache: Map<string, Uint8Array> | undefined;

  /**
   * Get the raw OFF data for a geometry (for testing/debugging purposes).
   *
   * @param geometryId - The geometry ID to get OFF data for.
   * @returns The raw OFF data string or undefined if not found.
   */
  public getOffData(geometryId = 'defaultGeometry'): string | undefined {
    return this.offDataMemory[geometryId];
  }

  protected override async canHandle(_filename: string, extension: string): Promise<boolean> {
    return extension === 'scad';
  }

  protected override async extractParameters(filename: string): Promise<ExtractParametersResult> {
    try {
      // Get only .scad files that are transitively referenced from the main file
      // via use/include statements. This prevents extracting parameters from
      // unrelated files in the project.
      // Use activeFilePath (the full relative path) to correctly resolve relative includes.
      const mainFilePath = this.activeFilePath || filename;
      const referencedFiles = await this.getReferencedScadFiles(mainFilePath);

      this.debug(`Extracting parameters from ${referencedFiles.length} referenced files`, {
        operation: 'extractParameters',
        data: { files: referencedFiles, mainFile: filename },
      });

      // Collect parameters from all referenced files
      const allParameters: OpenScadParameterExport['parameters'] = [];

      for (const scadFile of referencedFiles) {
        // Create a fresh OpenSCAD instance for each file
        // This is necessary because OpenSCAD WASM doesn't properly support multiple callMain invocations
        // eslint-disable-next-line no-await-in-loop -- Sequential processing required: each file needs its own instance
        const extractedParameters = await this.extractParametersFromFile(scadFile);

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
          title: filename,
        };

        jsonSchema = processOpenScadParameters(mergedExport);
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
      this.error('Error extracting parameters', { data: error });
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return createKernelError([
        {
          message: errorMessage,
          location: { fileName: this.activeFilePath, startLineNumber: 0, startColumn: 0 },
          severity: 'error',
        },
      ]);
    }
  }

  protected override async computeGeometry(
    filename: string,
    parameters?: Record<string, unknown>,
    geometryId = 'defaultGeometry',
  ): Promise<ComputeGeometryResult> {
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
      const code = await this.readFile(filename, 'utf8');
      const trimmedCode = code.trim();
      if (trimmedCode === '') {
        return createKernelSuccess([]);
      }

      // Pass the full activeFilePath to createInstance so error file paths can be
      // mapped from basename back to full relative path for FileLink navigation
      const instance = await this.createInstance(addError, getFileContents, this.activeFilePath);
      await this.mountFilesystem(instance, this.basePath, fileContentsCache);
      await this.mountFonts(instance);

      const inputFile = filename;
      const outputFile = `${filename}.off`;

      instance.FS.writeFile(inputFile, code);

      const args = [inputFile, '--backend=manifold', '-o', outputFile];

      if (parameters) {
        const flattenedParameters = flattenParametersForInjection(parameters);
        for (const [key, value] of Object.entries(flattenedParameters)) {
          args.push(`-D${key}=${this.formatValue(value)}`);
        }
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
            location: { fileName: this.activeFilePath, startLineNumber: 0, startColumn: 0 },
            severity: 'error',
          },
        ]);
      }

      const offData = instance.FS.readFile(outputFile, { encoding: 'utf8' });
      this.offDataMemory[geometryId] = offData;

      const gltfBlob = await convertOffToGltf(offData, 'glb', false);

      const geometry: GeometryGltf = {
        format: 'gltf',
        content: gltfBlob,
      };

      // Return warnings (non-error issues) with the successful result
      const warnings = collectedIssues.filter((issue) => issue.severity !== 'error');
      return createKernelSuccess([geometry], warnings);
    } catch (error) {
      this.error('Error while building geometries from code', { data: error });

      // Return parsed issues if we collected any before the exception
      if (collectedIssues.length > 0) {
        return createKernelError(collectedIssues);
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return createKernelError([
        {
          message: errorMessage,
          location: { fileName: this.activeFilePath, startLineNumber: 0, startColumn: 0 },
          severity: 'error',
        },
      ]);
    }
  }

  protected override async exportGeometry(
    fileType: ExportFormat,
    geometryId = 'defaultGeometry',
  ): Promise<ExportGeometryResult> {
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
   * @returns The extracted parameters or undefined if extraction fails.
   */
  private async extractParametersFromFile(filePath: string): Promise<OpenScadParameterExport | undefined> {
    const parameterFile = `${filePath}.params.json`;

    try {
      // Create a fresh instance for each file - OpenSCAD WASM doesn't support multiple callMain calls
      const instance = await this.createInstance();
      await this.mountFilesystem(instance, this.basePath);

      const result = instance.callMain([filePath, '-o', parameterFile, '--export-format=param']);

      if (result !== 0) {
        this.debug(`No parameters extracted from ${filePath} (exit code: ${result})`, {
          operation: 'extractParametersFromFile',
        });
        return undefined;
      }

      const parameterData = instance.FS.readFile(parameterFile, { encoding: 'utf8' });
      const parsed = JSON.parse(parameterData) as OpenScadParameterExport;

      this.debug(`Extracted ${parsed.parameters.length} parameters from ${filePath}`, {
        operation: 'extractParametersFromFile',
      });

      return parsed;
    } catch (error) {
      this.debug(`Failed to extract parameters from ${filePath}`, {
        operation: 'extractParametersFromFile',
        data: error,
      });
      return undefined;
    }
  }

  /**
   * Maximum recursion depth for resolving use/include dependencies.
   * Prevents infinite loops in circular dependencies.
   */
  private static readonly MAX_INCLUDE_DEPTH = 50;

  /**
   * Regex to match OpenSCAD use and include statements.
   * Matches: use <path/to/file.scad> or include <path/to/file.scad>
   * Also handles quoted paths: use "path/to/file.scad"
   */
  private static readonly USE_INCLUDE_REGEX = /^\s*(?:use|include)\s*[<"]([^>"]+)[>"]/gm;

  /**
   * Parse use and include statements from OpenSCAD code.
   *
   * @param code - The OpenSCAD source code.
   * @returns Array of file paths referenced via use or include.
   */
  private parseUseIncludeStatements(code: string): string[] {
    const paths: string[] = [];
    let match: RegExpExecArray | null;

    // Reset regex state for fresh matching
    OpenScadWorker.USE_INCLUDE_REGEX.lastIndex = 0;

    while ((match = OpenScadWorker.USE_INCLUDE_REGEX.exec(code)) !== null) {
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
    const baseDir = lastSlash >= 0 ? basePath.slice(0, lastSlash) : '';

    // Combine base directory with relative path
    const combinedPath = baseDir ? `${baseDir}/${relativePath}` : relativePath;

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
   * Get the project root path by stripping the subdirectory from basePath.
   * This is the original file.path from the GeometryFile.
   *
   * @returns The project root path (e.g., '/builds/test' for basePath '/builds/test/project').
   */
  private getProjectRootPath(): string {
    // Extract the subdirectory from activeFilePath (e.g., 'project' from 'project/main.scad')
    const lastSlash = this.activeFilePath.lastIndexOf('/');
    const subDirectory = lastSlash >= 0 ? this.activeFilePath.slice(0, lastSlash) : '';

    // Remove the subdirectory from basePath to get the project root
    if (subDirectory && this.basePath.endsWith(`/${subDirectory}`)) {
      return this.basePath.slice(0, -(subDirectory.length + 1));
    }

    return this.basePath;
  }

  /**
   * Read a file relative to the project root, not relative to basePath.
   * Used for dependency resolution where paths may be outside the main file's directory.
   *
   * @param relativePath - Path relative to the project root.
   * @returns The file contents as string.
   */
  private async readFileFromProjectRoot(relativePath: string): Promise<string> {
    const projectRoot = this.getProjectRootPath();
    const fullPath = `${projectRoot}/${relativePath}`;
    // Cast is needed because Remote<FileManager> doesn't properly resolve overloads
    return this.fileManager.readFile(fullPath, 'utf8') as unknown as Promise<string>;
  }

  /**
   * Get all .scad files that are transitively referenced from the main file
   * via use and include statements.
   *
   * @param mainFile - The main entry point file (relative to project root).
   * @returns Array of relative file paths to .scad files (including the main file).
   */
  private async getReferencedScadFiles(mainFile: string): Promise<string[]> {
    const visited = new Set<string>();
    const result: string[] = [];

    // Recursive helper with depth tracking
    const resolveFile = async (filePath: string, depth: number): Promise<void> => {
      // Normalize path for consistent tracking
      const normalizedPath = filePath.replace(/^\/+/, '');

      // Check depth limit
      if (depth >= OpenScadWorker.MAX_INCLUDE_DEPTH) {
        this.debug(`Max include depth (${OpenScadWorker.MAX_INCLUDE_DEPTH}) reached for ${normalizedPath}`, {
          operation: 'getReferencedScadFiles',
        });
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
        code = await this.readFileFromProjectRoot(normalizedPath);
      } catch {
        this.debug(`Could not read file ${normalizedPath} for dependency resolution`, {
          operation: 'getReferencedScadFiles',
        });
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
    const fileName = filePath.split('/').pop() ?? filePath;
    const nameWithoutExt = fileName.replace(/\.scad$/, '');

    // Capitalize first letter
    return nameWithoutExt.charAt(0).toUpperCase() + nameWithoutExt.slice(1);
  }

  private parseLogLevel(message: string): LogLevel {
    if (message.includes('ERROR')) {
      return logLevels.error;
    }

    if (message.includes('WARNING')) {
      return logLevels.warn;
    }

    return logLevels.info;
  }

  private print(message: string): void {
    this.onLog({
      level: this.parseLogLevel(message),
      message,
      origin: { component: OpenScadWorker.name, operation: 'internal' },
    });
  }

  private printErr(message: string): void {
    this.onLog({
      level: this.parseLogLevel(message),
      message,
      origin: { component: OpenScadWorker.name, operation: 'internal' },
    });
  }

  /**
   * Create an OpenSCAD WASM instance.
   *
   * @param addError - Optional callback to receive parsed errors from stderr in real-time.
   * @param getFileContents - Optional function to lazily fetch file contents for error highlighting.
   * @param mainFilePath - Optional full relative path of the main file (e.g., "site/backyard.scad").
   *                       Used to map basename errors back to full paths for FileLink navigation.
   * @returns The OpenSCAD instance.
   */
  private async createInstance(
    addError?: AddErrorFn,
    getFileContents?: GetFileContentsFn,
    mainFilePath?: string,
  ): Promise<OpenSCAD> {
    const instance = await createOpenSCAD({
      noInitialRun: true,
      print: (message) => {
        this.print(message);
      },
      printErr: (message) => {
        this.printErr(message);
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
   * Mount the current directory filesystem into Emscripten's FS.
   * Pre-populates all files from basePath so OpenSCAD can access them.
   * Optionally populates a cache with .scad file contents for error highlighting.
   *
   * @param instance - The OpenSCAD instance with FS API.
   * @param basePath - The base path to mount files from.
   * @param fileContentsCache - Optional cache to populate with .scad file contents.
   */
  private async mountFilesystem(
    instance: OpenSCAD,
    basePath: string,
    fileContentsCache?: Map<string, string>,
  ): Promise<void> {
    try {
      this.debug('Mounting filesystem from basePath', { operation: 'mountFilesystem', data: { basePath } });

      // Change to root directory FIRST - all file operations should be relative to /
      // This is critical for font resolution (fonts are at /fonts relative to cwd)
      // @ts-expect-error - chdir exists on Emscripten FS but is not typed in openscad-wasm-prebuilt
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- chdir is untyped but exists on Emscripten FS
      instance.FS.chdir('/');

      // Get all files from the current directory
      const files = await this.fileManager.getDirectoryContents(basePath);
      const fileCount = Object.keys(files).length;

      this.debug(`Found ${fileCount} files to mount`, { operation: 'mountFilesystem' });

      // Add locale directory - required to silence OpenSCAD warnings about missing locale directory
      instance.FS.mkdir('/locale');

      // Create directories and write files into Emscripten FS
      for (const [relativePath, content] of Object.entries(files)) {
        // Extract directory path from file path
        const lastSlashIndex = relativePath.lastIndexOf('/');
        if (lastSlashIndex > 0) {
          const dirPath = relativePath.slice(0, lastSlashIndex);
          const dirSegments = dirPath.split('/');

          // Create nested directories
          let currentPath = '';
          for (const segment of dirSegments) {
            currentPath = currentPath ? `${currentPath}/${segment}` : segment;
            try {
              instance.FS.mkdir(currentPath);
            } catch {
              // Directory already exists, ignore error
            }
          }
        }

        // Write the file
        instance.FS.writeFile(relativePath, content);
        this.trace(`Mounted file: ${relativePath}`, { operation: 'mountFilesystem' });

        // Cache .scad file contents for error highlighting
        if (fileContentsCache && relativePath.endsWith('.scad')) {
          const textContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
          fileContentsCache.set(relativePath, textContent);
        }
      }

      this.debug(`Successfully mounted ${fileCount} files`, { operation: 'mountFilesystem' });
    } catch (error) {
      this.error('Failed to mount filesystem', { operation: 'mountFilesystem', data: error });
      throw error;
    }
  }

  /**
   * Mount fonts into Emscripten's FS for OpenSCAD text() rendering.
   * Fetches TTF fonts from the public folder and writes them to /fonts/ in the virtual FS.
   * Font data is cached to avoid re-fetching on subsequent OpenSCAD instances.
   *
   * @param instance - The OpenSCAD instance with FS API.
   */
  private async mountFonts(instance: OpenSCAD): Promise<void> {
    try {
      this.debug('Mounting fonts for text rendering', { operation: 'mountFonts' });

      // Fetch and cache fonts if not already cached
      if (!this.fontCache) {
        this.debug('Fetching fonts (first time)', { operation: 'mountFonts' });
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
          this.trace(`Cached font: ${filename} (${data.byteLength} bytes)`, { operation: 'mountFonts' });
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
        this.trace(`Mounted font: /fonts/${filename}`, { operation: 'mountFonts' });
      }

      // Write fonts.conf for fontconfig
      instance.FS.writeFile('/fonts/fonts.conf', fontsConf);
      this.trace('Mounted fonts.conf', { operation: 'mountFonts' });

      // Note: chdir('/') is called in mountFilesystem before this method
      // so fontconfig will resolve fonts from ./fonts (i.e., /fonts)

      this.debug(`Successfully mounted ${this.fontCache.size} fonts`, { operation: 'mountFonts' });
    } catch (error) {
      // Reset fontCache so next call will retry fetching
      this.fontCache = undefined;
      // Log warning but don't fail - text rendering just won't work
      this.warn('Failed to mount fonts - text() may not render correctly', {
        operation: 'mountFonts',
        data: error,
      });
    }
  }
}

const service = new OpenScadWorker();
expose(service);
export type OpenScadBuilderInterface = typeof service;
