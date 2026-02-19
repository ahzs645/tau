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
import { KernelWorker } from '#components/geometry/kernel/utils/kernel-worker.js';
import { isWorkerContext, getWorkerMessagePort } from '#components/geometry/kernel/utils/kernel-message-adapter.js';
import { createWorkerDispatcher } from '#components/geometry/kernel/utils/kernel-worker-dispatcher.js';

/**
 * Configuration for a kernel module within the runtime worker.
 * Mirrors KernelWorkerEntry but without the worker URL (since we ARE the worker).
 */
type KernelModuleConfig = {
  id: string;
  moduleUrl: string;
  extensions?: string[];
  detectImport?: string;
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
class KernelRuntimeWorker extends KernelWorker<RuntimeWorkerOptions> {
  protected override readonly name = 'KernelRuntimeWorker';

  private readonly loadedKernels = new Map<string, LoadedKernel>();
  private activeKernelId: string | undefined;
  private readonly selectionCache = new Map<string, string>();
  private kernelModules: KernelModuleConfig[] = [];

  // =====================================================================
  // Protected overrides (must precede private methods per linter rules)
  // =====================================================================

  protected override async initialize(
    { options }: { options: RuntimeWorkerOptions },
    _runtime: KernelRuntime,
  ): Promise<void> {
    this.kernelModules = options.kernelModules;
    this.logger.debug(`Runtime worker initialized with ${this.kernelModules.length} kernel modules`);
  }

  protected override async canHandle(input: CanHandleInput, runtime: KernelRuntime): Promise<boolean> {
    const filename = input.filePath.split('/').pop() ?? input.filePath;
    const kernel = await this.selectKernel(filename, runtime);
    if (!kernel) {
      return false;
    }

    this.activeKernelId = kernel.config.id;

    if (kernel.definition.canHandle) {
      return kernel.definition.canHandle(input, runtime, kernel.ctx);
    }

    return true;
  }

  protected override async getDependencies(input: GetDependenciesInput, runtime: KernelRuntime): Promise<string[]> {
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

  // =====================================================================
  // Private methods
  // =====================================================================

  private async ensureActiveKernel(filePath: string, runtime: KernelRuntime): Promise<LoadedKernel> {
    if (this.activeKernelId) {
      return this.getActiveKernel();
    }

    const filename = filePath.split('/').pop() ?? filePath;
    const kernel = await this.selectKernel(filename, runtime);
    if (!kernel) {
      throw new Error(`No kernel can handle file: ${filePath}`);
    }

    this.activeKernelId = kernel.config.id;
    return kernel;
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

  private async selectKernel(filename: string, runtime: KernelRuntime): Promise<LoadedKernel | undefined> {
    const cached = this.selectionCache.get(filename);
    if (cached) {
      return this.loadedKernels.get(cached);
    }

    const extension = filename.split('.').pop()?.toLowerCase() ?? '';

    /* eslint-disable no-await-in-loop -- Sequential kernel selection: try each config in priority order */
    for (const config of this.kernelModules) {
      if (!config.extensions) {
        continue;
      }

      const extensionMatch = config.extensions.includes(extension) || config.extensions.includes('*');
      if (!extensionMatch) {
        continue;
      }

      if (!config.detectImport) {
        const kernel = await this.loadKernelModule(config);
        await this.ensureKernelInitialized(kernel, runtime);
        this.selectionCache.set(filename, config.id);
        return kernel;
      }

      const filePath = `${this.getProjectRootPath()}/${filename}`;
      try {
        const code = await runtime.filesystem.readFile(filePath, 'utf8');
        const importRegex = new RegExp(config.detectImport, 's');
        if (importRegex.test(code)) {
          const kernel = await this.loadKernelModule(config);
          await this.ensureKernelInitialized(kernel, runtime);
          this.selectionCache.set(filename, config.id);
          return kernel;
        }
      } catch {
        continue;
      }
    }
    /* eslint-enable no-await-in-loop -- End sequential kernel selection */

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
