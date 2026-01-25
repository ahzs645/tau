/**
 * Kernel Middleware Testing Utilities
 *
 * Shared helper functions for testing kernel middleware.
 */

import deepmerge from 'deepmerge';
import type { PartialDeep } from 'type-fest';
import type {
  ComputeGeometryResult,
  ComputeGeometryRequest,
  ComputeGeometryInput,
  GeometryBase,
  KernelMiddlewareRuntime,
  KernelMiddlewareLogger,
  MiddlewareState,
  MiddlewareFileManager,
  KernelIssue,
  Dependency,
  ExtractParametersResult,
  ExportGeometryResult,
  GeometryFile,
} from '@taucad/types';
import { vi } from 'vitest';
import type { KernelMiddleware } from '#components/geometry/kernel/utils/kernel-middleware.js';
import { KernelWorker } from '#components/geometry/kernel/utils/kernel-worker.js';
import type { OnWorkerLog } from '#types/console.types.js';

/**
 * Create a mock logger for middleware testing.
 * Returns a logger with vitest mock functions.
 */
export function createMockLogger(): KernelMiddlewareLogger & {
  log: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  trace: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    log: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Create a mock file manager for middleware testing.
 * Returns a file manager with configurable behavior.
 */
export function createMockFileManager(options?: {
  existsResult?: boolean | ((path: string) => boolean | Promise<boolean>);
  readFileResult?: string | Uint8Array | ((path: string) => string | Uint8Array | Promise<string | Uint8Array>);
  getDirectoryStatResult?: Array<{ path: string; name: string; type: 'file' | 'dir'; size: number; mtimeMs: number }>;
}): MiddlewareFileManager & {
  exists: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  ensureDirectoryExists: ReturnType<typeof vi.fn>;
  getDirectoryStat: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
} {
  const existsFn = vi.fn().mockImplementation(async (path: string) => {
    if (typeof options?.existsResult === 'function') {
      return options.existsResult(path);
    }

    return options?.existsResult ?? false;
  });

  const readFileFn = vi.fn().mockImplementation(async (path: string) => {
    if (typeof options?.readFileResult === 'function') {
      return options.readFileResult(path);
    }

    return options?.readFileResult ?? new Uint8Array();
  });

  return {
    exists: existsFn,
    readFile: readFileFn,
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    ensureDirectoryExists: vi.fn().mockResolvedValue(undefined),
    getDirectoryStat: vi.fn().mockResolvedValue(options?.getDirectoryStatResult ?? []),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create a mock state for middleware testing.
 */
export function createMockState<T extends Record<string, unknown>>(): MiddlewareState<T> & {
  update: ReturnType<typeof vi.fn>;
} {
  // Start with empty object - we use a wrapper object to allow reassignment
  // while still having the getter work correctly
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Test utility requires flexible typing
  const stateContainer: { value: PartialDeep<T> } = { value: {} as PartialDeep<T> };

  const updateFn = vi.fn().mockImplementation((partial: Partial<T>) => {
    // Use deepmerge to match production createMiddlewareState behavior
    stateContainer.value = deepmerge(stateContainer.value, partial) as PartialDeep<T>;
  });

  return {
    get value() {
      return stateContainer.value;
    },
    update: updateFn,
  };
}

/**
 * Create a mock middleware runtime for testing.
 * Combines logger, file manager, state, and dependencies.
 */
/** Default mock dependency hash for testing */
const defaultMockDependencyHash = 'a'.repeat(64);

export function createMockRuntime<T extends Record<string, unknown> = Record<string, never>>(options?: {
  fileManagerOptions?: Parameters<typeof createMockFileManager>[0];
  dependencies?: readonly Dependency[];
  dependencyHash?: string;
}): KernelMiddlewareRuntime<T> & {
  logger: ReturnType<typeof createMockLogger>;
  fileManager: ReturnType<typeof createMockFileManager>;
  state: ReturnType<typeof createMockState<T>>;
} {
  return {
    logger: createMockLogger(),
    fileManager: createMockFileManager(options?.fileManagerOptions),
    state: createMockState<T>(),
    dependencies: options?.dependencies ?? [],
    dependencyHash: options?.dependencyHash ?? defaultMockDependencyHash,
  };
}

/**
 * Create a successful ComputeGeometryResultInternal with geometries.
 * Used for testing middleware which works with internal types (without hash).
 */
export function createSuccessResult(geometries: GeometryBase[]): ComputeGeometryResult {
  return {
    success: true,
    data: geometries,
    issues: [],
  };
}

/**
 * Create a successful ComputeGeometryResultInternal with a single GLTF geometry.
 */
export function createGltfSuccessResult(content: Uint8Array): ComputeGeometryResult {
  return createSuccessResult([{ format: 'gltf', content }]);
}

/**
 * Create a failed ComputeGeometryResultInternal.
 */
export function createErrorResult(issues?: KernelIssue[]): ComputeGeometryResult {
  return {
    success: false,
    issues: issues ?? [
      {
        message: 'Test error',
        severity: 'error',
        type: 'kernel',
      },
    ],
  };
}

/**
 * Create an empty successful result.
 */
export function createEmptySuccessResult(): ComputeGeometryResult {
  return createSuccessResult([]);
}

/**
 * Create a ComputeGeometryInput for testing.
 */
export function createMockInput(overrides?: Partial<ComputeGeometryInput>): ComputeGeometryInput {
  return {
    filename: 'test.kcl',
    parameters: {},
    basePath: 'builds/test-build',
    ...overrides,
  };
}

/**
 * Create a ComputeGeometryRequest for testing wrap-style hooks.
 */
export function createMockRequest<T extends Record<string, unknown> = Record<string, never>>(options?: {
  input?: Partial<ComputeGeometryInput>;
  runtimeOptions?: Parameters<typeof createMockRuntime>[0];
}): ComputeGeometryRequest<T> & {
  runtime: ReturnType<typeof createMockRuntime<T>>;
} {
  return {
    input: createMockInput(options?.input),
    runtime: createMockRuntime<T>(options?.runtimeOptions),
  };
}

// =============================================================================
// Mock KernelWorker for Testing
// =============================================================================

/**
 * Options for creating a MockKernelWorker.
 */
export type MockKernelWorkerOptions = {
  /** Middleware array to use (overrides default middleware) */
  middleware: KernelMiddleware[];
  /** Result to return from computeGeometry */
  computeResult?: ComputeGeometryResult;
  /** Custom onLog handler */
  onLog?: OnWorkerLog;
  /** Mock file manager for middleware */
  fileManager?: MiddlewareFileManager;
};

/**
 * Mock concrete implementation of KernelWorker for testing.
 * Allows injection of custom middleware to test the onion chain behavior.
 */
export class MockKernelWorker extends KernelWorker {
  protected override readonly name = 'MockKernelWorker';

  private readonly testMiddleware: KernelMiddleware[];
  private readonly mockComputeResult: ComputeGeometryResult;
  private readonly mockFileManager: MiddlewareFileManager;

  public constructor(options: MockKernelWorkerOptions) {
    super();
    this.testMiddleware = options.middleware;
    this.mockComputeResult =
      options.computeResult ?? createSuccessResult([{ format: 'gltf', content: new Uint8Array([1, 2, 3]) }]);
    this.mockFileManager = options.fileManager ?? createMockFileManager();

    // Set up onLog - use provided or no-op
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- Mock implementation
    this.onLog = options.onLog ?? (() => {});

    // Set up options as empty object
    this.options = {};
  }

  /**
   * Helper to run computeGeometryEntry with a mock file.
   */
  public async runComputeGeometry(
    filename = 'test.kcl',
    parameters: Record<string, unknown> = {},
  ): Promise<ReturnType<typeof this.computeGeometryEntry>> {
    const mockFile: GeometryFile = { filename, path: filename };
    return this.computeGeometryEntry(mockFile, parameters);
  }

  /**
   * Override getMiddleware to return test middleware.
   */
  protected override getMiddleware(): KernelMiddleware[] {
    return this.testMiddleware;
  }

  /**
   * Override to return mock file manager without needing real FileManager.
   */
  protected override createMiddlewareFileManager(): MiddlewareFileManager {
    return this.mockFileManager;
  }

  /**
   * Override to skip file I/O and return mock dependencies.
   */
  protected override async computeDependencies(): Promise<Dependency[]> {
    // Return minimal mock dependencies
    return [
      { type: 'file', path: 'test.kcl', contentHash: 'mock-hash' },
      ...this.testMiddleware.map((middleware, index) => ({
        type: 'middleware' as const,
        name: middleware.name,
        version: middleware.version ?? '1',
        index,
      })),
      { type: 'framework', name: 'tau' as const, version: 'test' },
    ];
  }

  // Stub implementations of abstract methods

  protected override async canHandle(): Promise<boolean> {
    return true;
  }

  protected override async extractParameters(): Promise<ExtractParametersResult> {
    return {
      success: true,
      data: { defaultParameters: {}, jsonSchema: { type: 'object', properties: {} } },
      issues: [],
    };
  }

  protected override async computeGeometry(): Promise<ComputeGeometryResult> {
    return this.mockComputeResult;
  }

  protected override async exportGeometry(): Promise<ExportGeometryResult> {
    return {
      success: true,
      data: [{ blob: new Blob(), name: 'export.gltf' }],
      issues: [],
    };
  }

  protected override async discoverDependencies(filename: string): Promise<string[]> {
    return [filename];
  }
}
