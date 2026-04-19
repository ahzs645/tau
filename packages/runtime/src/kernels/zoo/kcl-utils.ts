import type { PartialDeep, SetRequired } from 'type-fest';
import type { Node } from '@taucad/kcl-wasm-lib/bindings/Node';
import type { Program } from '@taucad/kcl-wasm-lib/bindings/Program';
import type { KclValue } from '@taucad/kcl-wasm-lib/bindings/KclValue';
import type { Operation } from '@taucad/kcl-wasm-lib/bindings/Operation';
import type { ArtifactGraph } from '@taucad/kcl-wasm-lib/bindings/Artifact';
import type { CompilationError } from '@taucad/kcl-wasm-lib/bindings/CompilationError';
import type { ModulePath } from '@taucad/kcl-wasm-lib/bindings/ModulePath';
import type { DefaultPlanes } from '@taucad/kcl-wasm-lib/bindings/DefaultPlanes';
import type { Configuration } from '@taucad/kcl-wasm-lib/bindings/Configuration';
import type { System } from '@taucad/kcl-wasm-lib/bindings/ModelingCmd';
import type { Context } from '@taucad/kcl-wasm-lib';
import type { Models } from '@kittycad/lib';
import type { RuntimeSpanTracer } from '#types/runtime-tracer.types.js';
import { EngineConnection, MockEngineConnection } from '#kernels/zoo/engine-connection.js';
import type { WasmModule } from '#kernels/zoo/engine-connection.js';
import type { FileSystemManager } from '#kernels/zoo/filesystem-manager.js';
import { KclError, KclExportError, KclWasmError, extractWasmKclError } from '#kernels/zoo/kcl-errors.js';
import { createZooLogger } from '#kernels/zoo/zoo-logs.js';
import { compileWasmStreaming } from '#framework/wasm-loader.js';

/**
 * URL to the KCL WASM binary, resolved relative to this module for bundler compatibility.
 *
 * @see https://web.dev/articles/bundling-non-js-resources#universal_pattern_for_browsers_and_bundlers
 */
export const kclWasmUrl = new URL('wasm/kcl_wasm_lib_bg.wasm', import.meta.url).href;

const log = createZooLogger('KclUtils');

type OutputFormat3d = Models['OutputFormat3d_type'];

/**
 * Outcome of parsing a KCL source file into an AST. Errors and warnings are separated for diagnostic display.
 */
export type KclParseResult = {
  program: Node<Program>;
  errors: CompilationError[];
  warnings: CompilationError[];
};

/**
 * Outcome of executing a KCL program against the Zoo engine, containing the full modeling state.
 */
export type KclExecutionResult = {
  variables: Partial<Record<string, KclValue>>;
  operations: Operation[];
  artifactGraph: ArtifactGraph;
  errors: CompilationError[];
  filenames: Record<number, ModulePath | undefined>;
  defaultPlanes: DefaultPlanes | undefined;
};

/**
 * Configuration for exporting a KCL model to a 3D file format. The `type` field selects the output format (e.g., `step`, `stl`).
 */
export type ExportOptions = SetRequired<Partial<OutputFormat3d>, 'type'> & {
  deterministic?: boolean;
};

/**
 * File produced by a KCL export operation, ready to be downloaded or written to disk.
 */
export type ExportedFile = {
  name: string;
  contents: Uint8Array<ArrayBuffer>;
};

/**
 * Outcome of exporting a KCL model to a file format. On failure, `error` contains the human-readable reason.
 */
export type KclExportResult = {
  success: boolean;
  files: ExportedFile[];
  error?: string;
};

type KclUtilitiesOptions = {
  /** API key for modeling API authentication */
  apiKey: string;
  /** Base URL for the modeling API */
  baseUrl?: string;
  /** Stream dimensions for engine */
  streamDimensions?: {
    width: number;
    height: number;
  };
  /** FileSystemManager for resolving file paths */
  fileSystemManager: FileSystemManager;
};

const splitErrors = (input: CompilationError[]): { errors: CompilationError[]; warnings: CompilationError[] } => {
  const errors = [];
  const warnings = [];
  for (const i of input) {
    if (i.severity === 'Warning') {
      warnings.push(i);
    } else {
      errors.push(i);
    }
  }

  return { errors, warnings };
};

// Dynamic import function to load WASM module
async function loadWasmModule(tracer?: RuntimeSpanTracer): Promise<WasmModule> {
  try {
    const wasmModule = await import('@taucad/kcl-wasm-lib');

    const compiledModule = await compileWasmStreaming(kclWasmUrl, tracer);

    // eslint-disable-next-line @typescript-eslint/naming-convention -- WASM Bindgen API
    await wasmModule.default({ module_or_path: compiledModule });

    return wasmModule;
  } catch (error) {
    throw KclError.simple({
      kind: 'engine',
      message: `Failed to load WASM module: ${String(error)}`,
    });
  }
}

/**
 * Utilities for parsing, executing, and exporting KCL code via WASM and Zoo engine.
 */
export class KclUtilities {
  /**
   * Inject parameters into KCL program JSON by modifying variable declarations.
   * This is a pure transformation that doesn't modify the original program.
   *
   * @param program - The KCL program to inject parameters into
   * @param parameters - The JSON parameters to inject
   * @returns A new program with injected parameters
   */
  public static injectParametersIntoProgram(program: Program, parameters: Record<string, unknown>): Program {
    if (Object.keys(parameters).length === 0) {
      return program;
    }

    // Deep clone the program to avoid mutating the original
    const modifiedProgram = structuredClone(program);

    // Iterate through the body to find variable declarations
    for (const bodyItem of modifiedProgram.body) {
      if (bodyItem.type === 'VariableDeclaration') {
        const { declaration } = bodyItem;
        const variableName = declaration.id.name;
        if (declaration.init.type === 'Literal' && variableName in parameters) {
          const parameterValue = parameters[variableName];

          // Update the literal value while preserving the structure
          if (typeof parameterValue === 'number') {
            // `value` is mistyped - it always has a nested `value` property
            (declaration.init.value as unknown) = {
              value: parameterValue,
              suffix: 'None',
            };
            declaration.init.raw = String(parameterValue);
          } else if (typeof parameterValue === 'string') {
            (declaration.init.value as unknown) = {
              value: parameterValue,
              suffix: 'None',
            };
            declaration.init.raw = `"${parameterValue}"`;
          } else if (typeof parameterValue === 'boolean') {
            (declaration.init.value as unknown) = {
              value: parameterValue,
              suffix: 'None',
            };
            declaration.init.raw = String(parameterValue);
          }
        }
      }
    }

    return modifiedProgram;
  }

  /**
   * Convert KCL variables to JSON schema format for parameter extraction.
   * Only processes literal values (String, Number, Bool) and skips complex types.
   *
   * @param variables - name-to-value map produced by the KCL executor (only literal types are extracted)
   * @returns Object containing default parameters and JSON schema
   */
  public static convertKclVariablesToJsonSchema(variables: Partial<Record<string, KclValue>>): {
    defaultParameters: Record<string, unknown>;
    jsonSchema: Record<string, unknown>;
  } {
    const defaultParameters: Record<string, unknown> = {};
    const properties: Record<string, unknown> = {};

    for (const [name, kclValue] of Object.entries(variables)) {
      if (!kclValue) {
        continue;
      }

      try {
        // Only process literal values: String, Number, and Bool
        switch (kclValue.type) {
          case 'String': {
            defaultParameters[name] = kclValue.value;
            properties[name] = { type: 'string', default: kclValue.value };
            break;
          }

          case 'Number': {
            defaultParameters[name] = kclValue.value;
            properties[name] = { type: 'number', default: kclValue.value };
            break;
          }

          case 'Bool': {
            defaultParameters[name] = kclValue.value;
            properties[name] = { type: 'boolean', default: kclValue.value };
            break;
          }

          default: {
            // Skip non-literal values (Plane, Face, Sketch, etc.)
            log.debug(`Skipping non-literal KCL variable ${name} of type ${kclValue.type}`);
            break;
          }
        }
      } catch (error) {
        log.warn(`Failed to process KCL variable ${name}:`, error);
      }
    }

    const jsonSchema = {
      type: 'object',
      properties,
      additionalProperties: false,
    };

    return { defaultParameters, jsonSchema };
  }

  private wasmModule: WasmModule | undefined;
  private isWasmInitialized = false;
  private isEngineInitialized = false;
  private engineManager: EngineConnection | undefined;
  private mockContext: Context | undefined;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fileSystemManager: FileSystemManager;
  // Add execution state tracking
  private hasExecutedProgram = false;

  public constructor(options: KclUtilitiesOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'wss://api.zoo.dev';
    this.fileSystemManager = options.fileSystemManager;
  }

  /**
   * Whether the WASM module has been initialized and is ready for parsing.
   *
   * @returns whether the WASM module is initialized
   */
  public get isWasmReady(): boolean {
    return this.isWasmInitialized;
  }

  /**
   * Whether the full engine connection (WASM + WebSocket) has been initialized.
   *
   * @returns whether both WASM and WebSocket are initialized
   */
  public get isEngineReady(): boolean {
    return this.isEngineInitialized;
  }

  /**
   * Initializes only the WASM module for parsing and mock execution.
   * This allows parseKcl and executeMockKcl to work without a WebSocket connection.
   *
   * @param tracer - optional span tracer for performance instrumentation
   */
  public async initializeWasm(tracer?: RuntimeSpanTracer): Promise<void> {
    if (this.isWasmInitialized) {
      return;
    }

    // Initialize WASM module for parsing
    this.wasmModule = await loadWasmModule(tracer);

    // Create mock context for local operations
    const mockEngine = new MockEngineConnection();
    // oxlint-disable-next-line @typescript-eslint/await-thenable -- WASM Context constructor may return thenable
    this.mockContext = await new this.wasmModule.Context(mockEngine, this.fileSystemManager);

    this.isWasmInitialized = true;
  }

  /**
   * Initializes the full engine connection (WASM + WebSocket) for execution and export.
   *
   * @throws When the WebSocket connection or authentication fails
   */
  public async initializeEngine(): Promise<void> {
    if (this.isEngineInitialized) {
      return;
    }

    // Ensure WASM is initialized first
    await this.initializeWasm();

    // Create and initialize engine manager
    this.engineManager = await this.createEngineManager();
    await this.engineManager.initialize();

    this.isEngineInitialized = true;
  }

  /**
   * Parses KCL source code into an AST. Only requires WASM initialization.
   *
   * @param kclCode - the KCL source code to parse
   * @returns the parsed program, errors, and warnings
   * @throws When the WASM module fails to load or parsing encounters a fatal error
   */
  public async parseKcl(kclCode: string): Promise<KclParseResult> {
    if (!this.isWasmInitialized) {
      await this.initializeWasm();
    }

    if (!this.wasmModule) {
      throw KclError.simple({
        kind: 'engine',
        message: 'WASM module not loaded',
      });
    }

    try {
      const result = this.wasmModule.parse_wasm(kclCode) as [Node<Program>, CompilationError[]];
      const errors = splitErrors(result[1]);

      return {
        program: result[0],
        errors: errors.errors,
        warnings: errors.warnings,
      };
    } catch (error) {
      throw KclError.simple({
        kind: 'syntax',
        message: `Failed to parse KCL code: ${String(error)}`,
      });
    }
  }

  /**
   * Executes a KCL program using a mock context without a WebSocket connection.
   *
   * @param program - the parsed KCL program AST to execute
   * @param path - the file path of the entry module
   * @param settings - optional KCL configuration overrides
   * @returns the execution result with variables, operations, and artifacts
   * @throws When execution fails or the WASM module is not loaded
   */
  public async executeMockKcl(
    program: Program,
    path: string,
    settings?: PartialDeep<Configuration>,
  ): Promise<KclExecutionResult> {
    if (!this.isWasmInitialized) {
      await this.initializeWasm();
    }

    if (!this.wasmModule) {
      throw KclError.simple({
        kind: 'engine',
        message: 'WASM module not loaded',
      });
    }

    if (!this.mockContext) {
      throw KclError.simple({
        kind: 'engine',
        message: 'Mock context not initialized',
      });
    }

    try {
      const result = (await this.mockContext.executeMock(
        JSON.stringify(program),
        path,
        JSON.stringify(settings ?? {}),
        false,
      )) as KclExecutionResult;

      return result;
    } catch (error) {
      log.error('KCL mock execution error details:', error);

      // Check if this is a WASM KclError
      const wasmError = extractWasmKclError(error);
      if (wasmError) {
        throw new KclWasmError(wasmError);
      }

      const errorMessage =
        error instanceof Error
          ? `KCL mock execution failed: ${error.message}`
          : `KCL mock execution failed: ${String(error)}`;
      throw KclError.simple({ kind: 'engine', message: errorMessage });
    }
  }

  /**
   * Executes a KCL program against the Zoo engine via WebSocket.
   *
   * @param program - the parsed KCL program AST to execute
   * @param path - the file path of the entry module
   * @param settings - optional KCL configuration overrides
   * @returns the execution result with variables, operations, and artifacts
   * @throws When execution fails, the engine is not initialized, or a WASM error occurs
   */
  public async executeProgram(
    program: Program,
    path: string,
    settings?: PartialDeep<Configuration>,
  ): Promise<KclExecutionResult> {
    if (!this.isEngineInitialized) {
      await this.initializeEngine();
    }

    if (!this.wasmModule) {
      throw KclError.simple({
        kind: 'engine',
        message: 'WASM module not loaded',
      });
    }

    if (!this.engineManager) {
      throw KclError.simple({
        kind: 'engine',
        message: 'Engine manager not initialized',
      });
    }

    try {
      const result = (await this.engineManager.context?.execute(
        JSON.stringify(program),
        path,
        JSON.stringify(settings ?? {}),
      )) as KclExecutionResult;

      // Track successful execution
      this.hasExecutedProgram = true;

      return result;
    } catch (error) {
      log.error('KCL execution error details:', error);

      // Check if this is a WASM KclError
      const wasmError = extractWasmKclError(error);
      if (wasmError) {
        throw new KclWasmError(wasmError);
      }

      const errorMessage =
        error instanceof Error ? `KCL execution failed: ${error.message}` : `KCL execution failed: ${String(error)}`;
      throw KclError.simple({ kind: 'engine', message: errorMessage });
    }
  }

  /**
   * Exports the model from operations already in memory, without re-execution.
   * Must be called after {@link executeProgram}.
   *
   * @param options - export format configuration (e.g., `{ type: 'step' }`)
   * @param settings - optional KCL configuration overrides
   * @returns the exported files, or an empty array if nothing to export
   * @throws When no program has been executed or the export fails
   */
  public async exportFromMemory(
    options: ExportOptions,
    settings: PartialDeep<Configuration> = {},
  ): Promise<ExportedFile[]> {
    if (!this.hasExecutedProgram) {
      throw new KclExportError('No program has been executed yet. Call executeKcl first.');
    }

    if (!this.isEngineInitialized) {
      throw KclError.simple({
        kind: 'engine',
        message: 'Engine not initialized',
      });
    }

    // Get the context used for execution
    const context = this.engineManager?.context;
    if (!context) {
      throw KclError.simple({
        kind: 'engine',
        message: 'No context available for export',
      });
    }

    // Create export format configuration
    const exportFormat = this.createExportFormat(options);

    try {
      // Export the model using operations already in memory
      const result = (await context.export(JSON.stringify(exportFormat), JSON.stringify(settings))) as Array<{
        name: string;
        contents: ArrayBuffer;
      }>;

      // Convert the result to our format
      const files: ExportedFile[] = [];
      if (Array.isArray(result)) {
        for (const file of result) {
          files.push({
            name: file.name,
            contents: new Uint8Array(file.contents),
          });
        }
      }

      return files;
    } catch (error) {
      // Handle the specific "Nothing to export" case as a valid scenario
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check for the "Nothing to export" pattern in various forms
      if (errorMessage.includes('Nothing to export') || errorMessage.includes('internal_engine: Nothing to export')) {
        // This is a valid case - return empty array instead of throwing
        return [];
      }

      // For other export errors, re-throw as KCLExportError
      throw new KclExportError(`Export failed: ${errorMessage}`, options.type);
    }
  }

  /**
   * Releases all resources including the WebSocket connection and WASM contexts.
   */
  public async cleanup(): Promise<void> {
    await this.clearProgram();

    if (this.engineManager) {
      await this.engineManager.cleanup();
      this.engineManager = undefined;
    }

    this.mockContext = undefined;
    this.isWasmInitialized = false;
    this.isEngineInitialized = false;
  }

  /**
   * Clears the operations cache in WASM contexts for a clean build state.
   *
   * @param settings - optional KCL configuration overrides for the scene reset
   */
  public async clearProgram(settings?: PartialDeep<Configuration>): Promise<void> {
    try {
      // Get the context used for execution
      const context = this.engineManager?.context;
      if (context) {
        // Reset the scene
        await context.bustCacheAndResetScene(JSON.stringify(settings ?? {}));
      }

      // Reset execution state
      this.hasExecutedProgram = false;
    } catch (error) {
      log.warn('Failed to clear memory:', error);
    }
  }

  /**
   * Creates an EngineConnection that connects to the modeling API.
   *
   * @returns a configured but not yet initialized EngineConnection
   */
  private async createEngineManager(): Promise<EngineConnection> {
    if (!this.wasmModule) {
      throw KclError.simple({
        kind: 'engine',
        message: 'WASM module not loaded',
      });
    }

    const engineManager = new EngineConnection({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      wasmModule: this.wasmModule,
      fileSystemManager: this.fileSystemManager,
    });
    return engineManager;
  }

  /**
   * Creates an OutputFormat3d configuration from export options with sensible defaults.
   *
   * @param options - the export options specifying format type and overrides
   * @returns a fully-populated OutputFormat3d for the WASM export call
   */
  // oxlint-disable-next-line complexity -- supporting many defaults for exports in readable way
  private createExportFormat(options: ExportOptions): OutputFormat3d {
    const defaultCoords: System = {
      forward: { axis: 'y', direction: 'negative' },
      up: { axis: 'z', direction: 'positive' },
    };

    switch (options.type) {
      case 'gltf': {
        return {
          type: 'gltf',
          storage: options.storage ?? 'embedded',
          presentation: options.presentation ?? 'pretty',
        };
      }

      case 'obj': {
        return {
          type: 'obj',
          coords: options.coords ?? defaultCoords,
          units: options.units ?? 'mm',
        };
      }

      case 'stl': {
        return {
          type: 'stl',
          storage: options.storage ?? 'ascii',
          coords: options.coords ?? defaultCoords,
          units: options.units ?? 'mm',
          selection: { type: 'default_scene' },
        };
      }

      case 'step': {
        return {
          type: 'step',
          coords: options.coords ?? defaultCoords,
          ...(options.deterministic && {
            created: '1970-01-01T00:00:00Z',
          }),
        };
      }

      case 'ply': {
        return {
          type: 'ply',
          storage: options.storage ?? 'ascii',
          coords: options.coords ?? defaultCoords,
          selection: { type: 'default_scene' },
          units: options.units ?? 'mm',
        };
      }

      case 'fbx': {
        return {
          type: 'fbx',
          storage: options.storage ?? 'binary',
          ...(options.deterministic && {
            created: '1970-01-01T00:00:00Z',
          }),
        };
      }

      default: {
        const _exhaustiveCheck: never = options;
        throw new KclExportError(`Unsupported export format: ${String(_exhaustiveCheck)}`);
      }
    }
  }
}
