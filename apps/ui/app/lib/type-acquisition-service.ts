/**
 * Type Acquisition Service
 *
 * Manages TypeScript/JavaScript type declarations for Monaco Editor IntelliSense.
 * Handles two categories of types:
 *
 * 1. **Static types**: Built-in packages (replicad, @jscad/modeling) whose `.d.ts`
 *    content is bundled at build time and injected immediately during activation.
 *
 * 2. **Dynamic types**: User-imported packages (lodash, three, etc.) whose types
 *    are fetched from esm.sh CDN on demand when detected in editor content.
 *
 * This service is standalone with no dependencies on MonacoModelService, FileManagerApi,
 * or any virtual filesystem layer. It communicates with Monaco purely through
 * `addExtraLib` on both `typescriptDefaults` and `javascriptDefaults`.
 *
 * Architecture:
 * - Watches all JS/TS models for import statements (debounced)
 * - Parses imports using es-module-lexer (cached, <1ms)
 * - Fetches type declarations from esm.sh via X-TypeScript-Types header
 * - Guards all async operations with session epoch + AbortController
 * - Degrades gracefully offline (static types always available, dynamic types silently skipped)
 */

import type * as Monaco from 'monaco-editor';
import { getAllImports } from '#lib/javascript-import-parser.js';
import { isBareSpecifier } from '#utils/import.utils.js';

// =============================================================================
// Types
// =============================================================================

export type StaticTypeDefinition = {
  /** The npm package name (e.g., 'replicad', '@jscad/modeling') */
  packageName: string;
  /** Raw .d.ts content string */
  content: string;
  /** If true, content already contains `declare module` blocks and should not be wrapped */
  prewrapped?: boolean;
};

export type TypeAcquisitionConfig = {
  /** Static type definitions to inject immediately on initialization */
  staticTypes: StaticTypeDefinition[];
};

// =============================================================================
// Constants
// =============================================================================

const esmShBase = 'https://esm.sh';

/** Debounce delay for model content changes (ms) */
const debounceMs = 500;

/** Minimum time between retry attempts for failed packages (ms) */
const retryDelayMs = 60_000;

/** JS/TS language IDs that we watch for imports */
const jsTsLanguages = new Set(['typescript', 'javascript', 'typescriptreact', 'javascriptreact']);

// =============================================================================
// TypeAcquisitionService
// =============================================================================

export class TypeAcquisitionService {
  private monaco: typeof Monaco | undefined;

  // --- Session safety ---
  private sessionEpoch = 0;
  private abortController: AbortController | undefined;

  // --- Static types (addExtraLib disposables) ---
  private readonly staticDisposables: Monaco.IDisposable[] = [];
  private readonly builtinTypePackages = new Set<string>();

  // --- Dynamic types ---
  private readonly dynamicLibs = new Map<string, Monaco.IDisposable[]>();
  private readonly acquiredTypes = new Set<string>();

  // --- Watcher state ---
  private readonly modelListeners = new Map<Monaco.editor.ITextModel, Monaco.IDisposable>();
  private readonly debounceTimers = new Map<Monaco.editor.ITextModel, ReturnType<typeof setTimeout>>();
  private readonly globalListeners: Monaco.IDisposable[] = [];

  // --- Fetch management ---
  private readonly fetchCache = new Map<string, string>(); // PackageName -> .d.ts content
  private readonly pendingFetches = new Map<string, Promise<void>>(); // Dedup in-flight
  private readonly failedPackages = new Map<string, number>(); // Pkg -> timestamp of last failure

  /**
   * Initialize the service with Monaco and static type definitions.
   * Must be called before `startWatching()`.
   */
  public initialize(monaco: typeof Monaco, config: TypeAcquisitionConfig): void {
    this.monaco = monaco;
    this.abortController = new AbortController();

    // Register static types via addExtraLib on both defaults
    for (const staticType of config.staticTypes) {
      const content = staticType.prewrapped
        ? staticType.content
        : `declare module '${staticType.packageName}' {\n${staticType.content}\n}`;
      const filePath = `file:///node_modules/${staticType.packageName}/index.d.ts`;

      // Register on both TS and JS defaults so .js files also get type info
      const tsDisposable = monaco.typescript.typescriptDefaults.addExtraLib(content, filePath);
      const jsDisposable = monaco.typescript.javascriptDefaults.addExtraLib(content, filePath);

      this.staticDisposables.push(tsDisposable, jsDisposable);
      this.builtinTypePackages.add(staticType.packageName);
      this.acquiredTypes.add(staticType.packageName);
    }
  }

  /**
   * Start watching Monaco models for import statements.
   * Attaches listeners to existing and newly-created JS/TS models.
   */
  public startWatching(): void {
    if (!this.monaco) {
      return;
    }

    const { monaco } = this;

    // Watch for new and disposed models
    this.globalListeners.push(
      monaco.editor.onDidCreateModel((model) => {
        if (this.isJsTsModel(model)) {
          this.attachModelListener(model);
          void this.scanModelImports(model);
        }
      }),
      monaco.editor.onWillDisposeModel((model) => {
        this.detachModelListener(model);
      }),
    );

    // Scan existing models
    for (const model of monaco.editor.getModels()) {
      if (this.isJsTsModel(model)) {
        this.attachModelListener(model);
        void this.scanModelImports(model);
      }
    }
  }

  /**
   * Handle a build session change. Clears dynamic types and re-scans models.
   * Static types persist across sessions.
   */
  public onBuildSessionChange(): void {
    // Increment epoch to invalidate in-flight fetches
    this.sessionEpoch++;

    // Abort in-flight requests
    this.abortController?.abort();
    this.abortController = new AbortController();

    // Dispose dynamic type libs
    for (const disposables of this.dynamicLibs.values()) {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    }

    this.dynamicLibs.clear();

    // Reset tracking (keep builtinTypePackages)
    this.acquiredTypes.clear();
    for (const pkg of this.builtinTypePackages) {
      this.acquiredTypes.add(pkg);
    }

    this.pendingFetches.clear();
    this.failedPackages.clear();

    // Keep fetchCache -- types don't change between sessions, avoids redundant CDN requests

    // Clear debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }

    this.debounceTimers.clear();

    // Re-scan all existing models (deferred to avoid blocking)
    if (typeof globalThis.requestIdleCallback === 'function') {
      globalThis.requestIdleCallback(() => {
        this.rescanAllModels();
      });
    } else {
      setTimeout(() => {
        this.rescanAllModels();
      }, 0);
    }
  }

  /**
   * Dispose all resources. After disposal, the service cannot be used.
   */
  public dispose(): void {
    // Abort in-flight requests
    this.abortController?.abort();
    this.abortController = undefined;

    // Dispose static type libs
    for (const disposable of this.staticDisposables) {
      disposable.dispose();
    }

    this.staticDisposables.length = 0;

    // Dispose dynamic type libs
    for (const disposables of this.dynamicLibs.values()) {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    }

    this.dynamicLibs.clear();

    // Clear debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }

    this.debounceTimers.clear();

    // Detach model listeners
    for (const disposable of this.modelListeners.values()) {
      disposable.dispose();
    }

    this.modelListeners.clear();

    // Detach global listeners
    for (const disposable of this.globalListeners) {
      disposable.dispose();
    }

    this.globalListeners.length = 0;

    // Clear all tracking state
    this.acquiredTypes.clear();
    this.builtinTypePackages.clear();
    this.fetchCache.clear();
    this.pendingFetches.clear();
    this.failedPackages.clear();

    this.monaco = undefined;
  }

  // =========================================================================
  // Private: Model watching
  // =========================================================================

  private isJsTsModel(model: Monaco.editor.ITextModel): boolean {
    return jsTsLanguages.has(model.getLanguageId());
  }

  private attachModelListener(model: Monaco.editor.ITextModel): void {
    if (this.modelListeners.has(model)) {
      return;
    }

    const disposable = model.onDidChangeContent(() => {
      this.scheduleScan(model);
    });

    this.modelListeners.set(model, disposable);
  }

  private detachModelListener(model: Monaco.editor.ITextModel): void {
    const disposable = this.modelListeners.get(model);
    if (disposable) {
      disposable.dispose();
      this.modelListeners.delete(model);
    }

    const timer = this.debounceTimers.get(model);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(model);
    }
  }

  private scheduleScan(model: Monaco.editor.ITextModel): void {
    const existing = this.debounceTimers.get(model);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(model);
      void this.scanModelImports(model);
    }, debounceMs);

    this.debounceTimers.set(model, timer);
  }

  private rescanAllModels(): void {
    if (!this.monaco) {
      return;
    }

    for (const model of this.monaco.editor.getModels()) {
      if (this.isJsTsModel(model)) {
        void this.scanModelImports(model);
      }
    }
  }

  // =========================================================================
  // Private: Import scanning
  // =========================================================================

  private async scanModelImports(model: Monaco.editor.ITextModel): Promise<void> {
    try {
      const imports = await getAllImports(model);

      for (const imp of imports) {
        if (!isBareSpecifier(imp.specifier)) {
          continue;
        }

        const packageName = extractPackageName(imp.specifier);
        if (!packageName) {
          continue;
        }

        if (this.acquiredTypes.has(packageName)) {
          continue;
        }

        // Fire-and-forget -- errors are handled internally
        void this.acquireTypes(packageName);
      }
    } catch {
      // Silently ignore scan errors (model may have been disposed)
    }
  }

  // =========================================================================
  // Private: Type acquisition
  // =========================================================================

  private async acquireTypes(packageName: string): Promise<void> {
    // Dedup: return existing in-flight promise
    const pending = this.pendingFetches.get(packageName);
    if (pending) {
      return pending;
    }

    // Check retry delay for previously failed packages
    const lastFailure = this.failedPackages.get(packageName);
    if (lastFailure !== undefined && Date.now() - lastFailure < retryDelayMs) {
      return;
    }

    // Check fetch cache (persisted across sessions)
    const cached = this.fetchCache.get(packageName);
    if (cached) {
      this.injectDynamicTypes(packageName, cached);
      return;
    }

    // Capture epoch for async safety
    const currentEpoch = this.sessionEpoch;
    const { signal } = this.abortController ?? {};

    const promise = (async (): Promise<void> => {
      try {
        await this.fetchAndInjectTypes(packageName, currentEpoch, signal);
      } finally {
        this.pendingFetches.delete(packageName);
      }
    })();

    this.pendingFetches.set(packageName, promise);
    return promise;
  }

  private async fetchAndInjectTypes(
    packageName: string,
    epoch: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      // Step 1: Fetch the module to get the X-TypeScript-Types header
      const moduleUrl = `${esmShBase}/${packageName}`;
      const moduleResponse = await fetch(moduleUrl, { signal });

      // Epoch guard: session may have changed during fetch
      if (this.sessionEpoch !== epoch) {
        return;
      }

      const typesUrl = moduleResponse.headers.get('X-TypeScript-Types');
      if (!typesUrl) {
        // No types available for this package -- mark as acquired to prevent re-scanning
        this.acquiredTypes.add(packageName);
        return;
      }

      // Step 2: Fetch the type declarations
      const resolvedTypesUrl = typesUrl.startsWith('http') ? typesUrl : `${esmShBase}${typesUrl}`;

      const typesResponse = await fetch(resolvedTypesUrl, { signal });

      // Epoch guard: session may have changed during second fetch
      if (this.sessionEpoch !== epoch) {
        return;
      }

      if (!typesResponse.ok) {
        throw new Error(`Types fetch returned ${typesResponse.status}`);
      }

      const typesContent = await typesResponse.text();

      // Final epoch guard before injection
      if (this.sessionEpoch !== epoch) {
        return;
      }

      // Cache and inject
      this.fetchCache.set(packageName, typesContent);
      this.injectDynamicTypes(packageName, typesContent);

      // Clear from failed packages on success
      this.failedPackages.delete(packageName);
    } catch (error: unknown) {
      // Don't record AbortError as a failure (it's intentional)
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }

      // Record failure with timestamp for retry delay
      this.failedPackages.set(packageName, Date.now());

      // Add to acquiredTypes to prevent immediate re-scan spam
      this.acquiredTypes.add(packageName);
    }
  }

  private injectDynamicTypes(packageName: string, content: string): void {
    if (!this.monaco) {
      return;
    }

    // Dispose existing libs for this package (if re-injecting from cache)
    const existing = this.dynamicLibs.get(packageName);
    if (existing) {
      for (const disposable of existing) {
        disposable.dispose();
      }
    }

    const wrapped = `declare module '${packageName}' {\n${content}\n}`;
    const filePath = `file:///node_modules/${packageName}/index.d.ts`;

    const tsDisposable = this.monaco.typescript.typescriptDefaults.addExtraLib(wrapped, filePath);
    const jsDisposable = this.monaco.typescript.javascriptDefaults.addExtraLib(wrapped, filePath);

    this.dynamicLibs.set(packageName, [tsDisposable, jsDisposable]);
    this.acquiredTypes.add(packageName);
  }
}

// =============================================================================
// Utility functions
// =============================================================================

/**
 * Extract the package name from a bare specifier, stripping any subpath.
 *
 * Examples:
 * - 'lodash' -> 'lodash'
 * - 'lodash/debounce' -> 'lodash'
 * - '@scope/pkg' -> '@scope/pkg'
 * - '@scope/pkg/sub/path' -> '@scope/pkg'
 */
function extractPackageName(specifier: string): string | undefined {
  if (specifier.startsWith('@')) {
    // Scoped package: @scope/name or @scope/name/subpath
    const parts = specifier.split('/');
    if (parts.length < 2) {
      return undefined;
    }

    return `${parts[0]}/${parts[1]}`;
  }

  // Unscoped package: name or name/subpath
  const slashIndex = specifier.indexOf('/');
  return slashIndex === -1 ? specifier : specifier.slice(0, slashIndex);
}
