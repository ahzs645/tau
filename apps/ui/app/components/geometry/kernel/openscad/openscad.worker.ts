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
      // Get all .scad files in the project to extract parameters from each
      // OpenSCAD's customizer only sees parameters declared in the main file,
      // not from included files. We need to extract from each file separately.
      const allScadFiles = await this.getAllScadFiles();

      this.debug(`Extracting parameters from ${allScadFiles.length} files`, {
        operation: 'extractParameters',
        data: { files: allScadFiles, mainFile: filename },
      });

      // Collect parameters from all files
      const allParameters: OpenScadParameterExport['parameters'] = [];

      for (const scadFile of allScadFiles) {
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
        const isMainFile = scadFile === filename;
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
      return createKernelError({
        message: errorMessage,
        location: { fileName: this.activeFilePath, startLineNumber: 0, startColumn: 0 },
      });
    }
  }

  protected override async computeGeometry(
    filename: string,
    parameters?: Record<string, unknown>,
    geometryId = 'defaultGeometry',
  ): Promise<ComputeGeometryResult> {
    try {
      const code = await this.readFile(filename, 'utf8');
      const trimmedCode = code.trim();
      if (trimmedCode === '') {
        return createKernelSuccess([]);
      }

      const instance = await this.createInstance();
      await this.mountFilesystem(instance, this.basePath);
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
        // @ts-expect-error - TODO: add typings for formatException, ensure this API is available.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- formatException is not typed
        const error = instance.formatException?.(result);
        return createKernelError({
          message: `Failed to build geometry: ${error}`,
          location: { fileName: this.activeFilePath, startLineNumber: 0, startColumn: 0 },
        });
      }

      const offData = instance.FS.readFile(outputFile, { encoding: 'utf8' });
      this.offDataMemory[geometryId] = offData;

      const gltfBlob = await convertOffToGltf(offData, 'glb', false);

      const geometry: GeometryGltf = {
        format: 'gltf',
        content: gltfBlob,
      };

      return createKernelSuccess([geometry]);
    } catch (error) {
      this.error('Error while building geometries from code', { data: error });
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return createKernelError({
        message: errorMessage,
        location: { fileName: this.activeFilePath, startLineNumber: 0, startColumn: 0 },
      });
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
        return createKernelError({
          message: `Geometry ${geometryId} not computed yet. Please build geometries before exporting.`,
        });
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
          return createKernelError({ message: `Unsupported export format: ${fileType}` });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return createKernelError({ message: errorMessage });
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
   * Get all .scad files in the current project directory.
   *
   * @returns Array of relative file paths to .scad files.
   */
  private async getAllScadFiles(): Promise<string[]> {
    const files = await this.fileManager.getDirectoryContents(this.basePath);
    const scadFiles: string[] = [];

    for (const [relativePath] of Object.entries(files)) {
      if (relativePath.endsWith('.scad')) {
        scadFiles.push(relativePath);
      }
    }

    return scadFiles;
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

  private async createInstance(): Promise<OpenSCAD> {
    const instance = await createOpenSCAD({
      noInitialRun: true,
      print: (message) => {
        this.print(message);
      },
      printErr: (message) => {
        this.printErr(message);
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
   *
   * @param instance - The OpenSCAD instance with FS API.
   * @param basePath - The base path to mount files from.
   */
  private async mountFilesystem(instance: OpenSCAD, basePath: string): Promise<void> {
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
