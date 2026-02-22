/**
 * Kernel Runtime Worker
 *
 * A generic worker that dynamically loads kernel modules defined via defineKernel().
 * Replaces the pattern of one Worker per kernel with a single Worker per compilation
 * unit that loads only the WASM runtime it needs.
 *
 * Kernel selection:
 * 1. Extension-based fast path: .scad -> OpenSCAD, .kcl -> KCL
 * 2. Import-based: for .ts/.js files, bundles the entry and inspects imports
 * 3. Caches selection for subsequent renders of the same file
 *
 * This worker extends KernelWorker to reuse all infrastructure:
 * file caching, middleware chain, telemetry, and the MessagePort dispatcher.
 */

import type {
  CanHandleInput,
  CreateGeometryInput,
  CreateGeometryResult,
  ExportGeometryInput,
  ExportGeometryResult,
  GetDependenciesInput,
  GetParametersInput,
  GetParametersResult,
  KernelDefinition,
  KernelIssue,
  KernelRuntime,
} from '@taucad/types';
import { KernelWorker } from '#framework/kernel-worker.js';
import { isWorkerContext, getWorkerMessagePort } from '#framework/kernel-message-adapter.js';
import { createWorkerDispatcher } from '#framework/kernel-worker-dispatcher.js';

/**
 * Configuration for a kernel module within the runtime worker.
 * Mirrors KernelWorkerEntry but without the worker URL (since we ARE the worker).
 */
type KernelModuleConfig = {
  id: string;
  moduleUrl: string;
  extensions?: string[];
  detectImport?: string;
  builtinModuleNames?: string[];
  options?: Record<string, unknown>;
  /** Pre-loaded definition (bypasses dynamic import, used in tests) */
  definition?: KernelDefinition;
};

type LoadedKernel = {
  config: KernelModuleConfig;
  definition: KernelDefinition;
  ctx: unknown;
  initialized: boolean;
};

type RuntimeWorkerOptions = {
  kernelModules: KernelModuleConfig[];
};

/**
 * Generic kernel runtime worker.
 * Loads kernel modules dynamically and delegates to the active kernel.
 */
/** How a kernel was selected — determines whether to re-check via kernel.canHandle. */
type SelectionMethod = 'regex' | 'bundler' | 'extension' | 'catchall';

type KernelSelection = {
  kernel: LoadedKernel;
  method: SelectionMethod;
};

class KernelRuntimeWorker extends KernelWorker<RuntimeWorkerOptions> {
  protected override readonly name = 'KernelRuntimeWorker';

  private readonly loadedKernels = new Map<string, LoadedKernel>();
  private activeKernelId: string | undefined;
  private readonly selectionCache = new Map<string, { id: string; method: SelectionMethod }>();
  private kernelModules: KernelModuleConfig[] = [];
  private cachedDetectionDeps?: string[];

  // =====================================================================
  // Protected overrides (must precede private methods per linter rules)
  // =====================================================================

  protected override async initialize(
    { options }: { options: RuntimeWorkerOptions },
    _runtime: KernelRuntime,
  ): Promise<void> {
    this.kernelModules = options.kernelModules;
  }

  protected override async canHandle(input: CanHandleInput, runtime: KernelRuntime): Promise<boolean> {
    const selection = await this.selectKernel(input.filePath, runtime);
    if (!selection) {
      return false;
    }

    this.activeKernelId = selection.kernel.config.id;

    // When selected via bundler detection (transitive import analysis),
    // the framework's detection is authoritative — skip kernel-level canHandle
    // which only checks the entry file and would reject transitive imports.
    if (selection.method === 'bundler') {
      return true;
    }

    if (selection.kernel.definition.canHandle) {
      return selection.kernel.definition.canHandle(input, runtime, selection.kernel.ctx);
    }

    return true;
  }

  protected override async getDependencies(input: GetDependenciesInput, runtime: KernelRuntime): Promise<string[]> {
    if (this.cachedDetectionDeps) {
      const deps = this.cachedDetectionDeps;
      this.cachedDetectionDeps = undefined;
      return deps;
    }

    const kernel = await this.ensureActiveKernel(input.filePath, runtime);
    return kernel.definition.getDependencies(input, runtime, kernel.ctx);
  }

  protected override async getParameters(
    input: GetParametersInput,
    runtime: KernelRuntime,
  ): Promise<GetParametersResult> {
    const kernel = await this.ensureActiveKernel(input.filePath, runtime);
    return kernel.definition.getParameters(input, runtime, kernel.ctx);
  }

  protected override async createGeometry(
    input: CreateGeometryInput,
    runtime: KernelRuntime,
  ): Promise<CreateGeometryResult> {
    const kernel = await this.ensureActiveKernel(input.filePath, runtime);
    try {
      const output = await kernel.definition.createGeometry(input, runtime, kernel.ctx);

      this.nativeHandle = output.nativeHandle;
      return {
        success: true,
        data: output.geometry,
        issues: output.issues ?? [],
      };
    } catch (error) {
      if (error instanceof Error && 'issues' in error && Array.isArray(error.issues)) {
        return { success: false, issues: error.issues as KernelIssue[] };
      }

      return {
        success: false,
        issues: [
          { message: error instanceof Error ? error.message : String(error), type: 'kernel', severity: 'error' },
        ],
      };
    }
  }

  protected override async exportGeometry(
    input: ExportGeometryInput,
    runtime: KernelRuntime,
    nativeHandle: unknown,
  ): Promise<ExportGeometryResult> {
    if (!this.activeKernelId) {
      return {
        success: false,
        issues: [{ message: 'No geometry available for export', type: 'runtime', severity: 'error' }],
      };
    }

    const kernel = this.getActiveKernel();
    return kernel.definition.exportGeometry(input, runtime, kernel.ctx, nativeHandle);
  }

  protected override getAssetUrls(): string[] {
    return [];
  }

  protected override onFileChanged(_changedPaths: string[]): void {
    this.selectionCache.clear();
    this.cachedDetectionDeps = undefined;
    this.activeKernelId = undefined;
  }

  // =====================================================================
  // Private methods
  // =====================================================================

  private async ensureActiveKernel(filePath: string, runtime: KernelRuntime): Promise<LoadedKernel> {
    if (this.activeKernelId) {
      return this.getActiveKernel();
    }

    const span = runtime.tracer.startSpan('kernel.select', { file: filePath });
    const selection = await this.selectKernel(filePath, runtime);
    if (!selection) {
      span.end();
      throw new Error(`No kernel can handle file: ${filePath}`);
    }

    this.activeKernelId = selection.kernel.config.id;
    span.end();
    return selection.kernel;
  }

  private async loadKernelModule(config: KernelModuleConfig): Promise<LoadedKernel> {
    const existing = this.loadedKernels.get(config.id);
    if (existing) {
      return existing;
    }

    let definition: KernelDefinition;
    if (config.definition) {
      definition = config.definition;
    } else {
      this.logger.debug(`Loading kernel module: ${config.id} from ${config.moduleUrl}`);
      const module = (await import(/* @vite-ignore */ config.moduleUrl)) as { default: KernelDefinition };
      definition = module.default;
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Runtime guard for dynamic import
    if (!definition || typeof definition.getDependencies !== 'function') {
      throw new Error(`Kernel module ${config.id} does not export a valid KernelDefinition`);
    }

    const loaded: LoadedKernel = {
      config,
      definition,
      ctx: undefined,
      initialized: false,
    };

    this.loadedKernels.set(config.id, loaded);
    return loaded;
  }

  private async ensureKernelInitialized(kernel: LoadedKernel, runtime: KernelRuntime): Promise<void> {
    if (kernel.initialized) {
      return;
    }

    this.logger.debug(`Initializing kernel: ${kernel.config.id}`);
    kernel.ctx = await kernel.definition.initialize(kernel.config.options ?? {}, runtime);
    kernel.initialized = true;
  }

  /**
   * Select the appropriate kernel for a file using three-pass detection:
   * 1. Extension + regex fast path (entry file only)
   * 2. Bundler-assisted detection via detectImports (transitive, no stubs)
   * 3. Catch-all fallback (extensions: ['*'])
   *
   * Returns the selected kernel and the method used for selection.
   * The selection method is used by canHandle to decide whether to
   * re-check via the kernel's own canHandle (skipped for bundler detection
   * since it already traced transitive imports).
   *
   * @param filePath - Full path to the file (used as cache key for collision safety)
   */
  private async selectKernel(filePath: string, runtime: KernelRuntime): Promise<KernelSelection | undefined> {
    const cached = this.selectionCache.get(filePath);
    if (cached) {
      const kernel = this.loadedKernels.get(cached.id);
      if (kernel) {
        return { kernel, method: cached.method };
      }
    }

    const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
    let catchAllConfig: KernelModuleConfig | undefined;
    const hasBundlerKernels = this.kernelModules.some((c) => c.builtinModuleNames && c.builtinModuleNames.length > 0);

    /* eslint-disable no-await-in-loop -- Sequential kernel selection: try each config in priority order */

    // Pass 1: Extension + regex fast path
    for (const config of this.kernelModules) {
      if (!config.extensions) {
        continue;
      }

      const isCatchAll = config.extensions.includes('*');
      const extensionMatch = config.extensions.includes(extension) || isCatchAll;
      if (!extensionMatch) {
        continue;
      }

      if (isCatchAll && hasBundlerKernels) {
        catchAllConfig = config;
        continue;
      }

      if (!config.detectImport) {
        const kernel = await this.loadKernelModule(config);
        await this.ensureKernelInitialized(kernel, runtime);
        this.selectionCache.set(filePath, { id: config.id, method: 'extension' });
        return { kernel, method: 'extension' };
      }

      try {
        const detectSpan = runtime.tracer.startSpan('kernel.detect-import', { kernel: config.id });
        const code = await runtime.filesystem.readFile(filePath, 'utf8');
        detectSpan.end();
        const importRegex = new RegExp(config.detectImport, 's');
        if (importRegex.test(code)) {
          const kernel = await this.loadKernelModule(config);
          await this.ensureKernelInitialized(kernel, runtime);
          this.selectionCache.set(filePath, { id: config.id, method: 'regex' });
          return { kernel, method: 'regex' };
        }
      } catch {
        continue;
      }
    }

    // Pass 2: Bundler-assisted detection via detectImports
    if (this.hasBundlerAvailable) {
      const configsWithBuiltins = this.kernelModules.filter(
        (c) => c.builtinModuleNames && c.builtinModuleNames.length > 0,
      );

      if (configsWithBuiltins.length > 0) {
        await this.ensureBundlerContext();
        const detectSpan = runtime.tracer.startSpan('kernel.detect-bundle', { file: filePath });
        const { detectedModules, dependencies } = await this.loadedBundler!.definition.detectImports(
          { entryPath: filePath },
          this.loadedBundler!.ctx,
        );
        detectSpan.end();

        this.cachedDetectionDeps = dependencies;

        const matchingConfigs = configsWithBuiltins.filter((config) =>
          config.builtinModuleNames!.some((name) =>
            detectedModules.some((detected) => detected === name || detected.startsWith(name + '/')),
          ),
        );

        if (matchingConfigs.length > 0) {
          const primaryConfig = matchingConfigs[0]!;
          const primaryKernel = await this.loadKernelModule(primaryConfig);
          await this.ensureKernelInitialized(primaryKernel, runtime);

          for (const config of matchingConfigs.slice(1)) {
            const kernel = await this.loadKernelModule(config);
            await this.ensureKernelInitialized(kernel, runtime);
          }

          this.selectionCache.set(filePath, { id: primaryConfig.id, method: 'bundler' });
          return { kernel: primaryKernel, method: 'bundler' };
        }
      }
    }

    /* eslint-enable no-await-in-loop -- End sequential kernel selection */

    // Pass 3: Catch-all fallback
    if (catchAllConfig) {
      const kernel = await this.loadKernelModule(catchAllConfig);
      await this.ensureKernelInitialized(kernel, runtime);
      this.selectionCache.set(filePath, { id: catchAllConfig.id, method: 'catchall' });
      return { kernel, method: 'catchall' };
    }

    return undefined;
  }

  private getActiveKernel(): LoadedKernel {
    if (!this.activeKernelId) {
      throw new Error('No kernel selected');
    }

    const kernel = this.loadedKernels.get(this.activeKernelId);
    if (!kernel) {
      throw new Error(`Kernel ${this.activeKernelId} not loaded`);
    }

    return kernel;
  }
}

if (isWorkerContext()) {
  const worker = new KernelRuntimeWorker();
  createWorkerDispatcher(worker, getWorkerMessagePort());
}

export { KernelRuntimeWorker };
