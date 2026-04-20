/**
 * Monaco Model Service
 *
 * Single authority for all Monaco model lifecycle and content mutations.
 * Replaces the dual-subscriber pattern that caused file corruption.
 *
 * Key behaviors:
 * - Ref-counted editor holds for split-view readiness
 * - Single fileWritten/fileDeleted/fileRenamed subscriber (eliminates race)
 * - pushEditOperations for editor-held models (preserves undo), setValue for background
 * - Background JS/TS sync via requestIdleCallback
 * - Session epoch gating for all async operations
 * - AbortController cancellation for background jobs
 * - Background model eviction (hard cap + TTL)
 */

import type * as Monaco from 'monaco-editor';
import type { MonacoMarkerService } from '#lib/monaco-marker-service.js';
import type { FileContentService, ContentChangeEvent } from '#lib/file-content-service.js';
import type { FileTreeService } from '#lib/file-tree-service.js';
import { isJsLikeFile, getMonacoLanguage } from '#lib/monaco.constants.js';
import { decodeTextFile } from '#utils/filesystem.utils.js';

export type ModelServiceConfig = {
  monaco: typeof Monaco;
  contentService: FileContentService;
  treeService: FileTreeService;
  markerService: MonacoMarkerService;
};

export type ServiceDiagnostics = {
  totalModelsCreated: number;
  peakModelCount: number;
  evictionCount: number;
  editorHeldCount: number;
  backgroundCount: number;
  currentModelCount: number;
};

/** Default maximum number of background models */
const maxBackgroundModels = 200;

/** Background model TTL in milliseconds (1 hour) */
const backgroundModelTtlMs = 60 * 60 * 1000;

/** Eviction check interval in milliseconds (60 seconds) */
const evictionCheckIntervalMs = 60 * 1000;

export class MonacoModelService {
  private monaco: typeof Monaco | undefined;
  private contentService: FileContentService | undefined;
  private treeService: FileTreeService | undefined;
  private markerService: MonacoMarkerService | undefined;

  /** Session epoch -- incremented on each project session change */
  private epoch = 0;

  /** AbortController for current session -- aborted on session change and dispose */
  private abortController: AbortController | undefined;

  /** Ref-counted editor holds: path -> refCount */
  private readonly editorHolds = new Map<string, number>();

  /** Background model access times for TTL eviction: path -> lastAccessTime */
  private readonly backgroundAccessTimes = new Map<string, number>();

  /** Set of paths that have been synced in the current session */
  private readonly syncedPaths = new Set<string>();

  /** Content change subscription unsubscribe fn */
  private contentUnsubscribe: (() => void) | undefined;

  /** Timer for eviction checks */
  private evictionTimerId: ReturnType<typeof setInterval> | undefined;

  /** Dev-mode metrics */
  private readonly metrics = {
    totalModelsCreated: 0,
    peakModelCount: 0,
    evictionCount: 0,
  };

  /**
   * Initialize the model service.
   */
  public initialize(config: ModelServiceConfig): void {
    this.monaco = config.monaco;
    this.contentService = config.contentService;
    this.treeService = config.treeService;
    this.markerService = config.markerService;

    this.abortController = new AbortController();

    this.contentUnsubscribe = this.contentService.onDidContentChange((event) => {
      this.handleContentChange(event);
    });

    // Start eviction timer
    this.evictionTimerId = setInterval(() => {
      this.evictStaleBackgroundModels();
    }, evictionCheckIntervalMs);

    // Start background sync
    this.startBackgroundSync();
  }

  /**
   * Dispose all resources.
   */
  public dispose(): void {
    this.abortController?.abort();
    this.abortController = undefined;

    if (this.evictionTimerId !== undefined) {
      clearInterval(this.evictionTimerId);
      this.evictionTimerId = undefined;
    }

    this.contentUnsubscribe?.();
    this.contentUnsubscribe = undefined;

    this.disposeAllModels();

    this.editorHolds.clear();
    this.backgroundAccessTimes.clear();
    this.syncedPaths.clear();

    this.monaco = undefined;
    this.contentService = undefined;
    this.treeService = undefined;
    this.markerService = undefined;
  }

  /**
   * Switch to a new project session. Aborts in-flight work, clears state, restarts sync.
   */
  public setProjectSession(): void {
    // Increment epoch
    this.epoch++;

    // Abort previous session's async work
    this.abortController?.abort();
    this.abortController = new AbortController();

    // Clear markers
    this.markerService?.clearAll();

    // Dispose all models
    this.disposeAllModels();

    // Reset tracking
    this.editorHolds.clear();
    this.backgroundAccessTimes.clear();
    this.syncedPaths.clear();

    // Restart background sync
    this.startBackgroundSync();
  }

  /**
   * Acquire a ref-counted editor hold on a path and ensure the model exists.
   * Returns the model, or undefined if the file can't be loaded.
   * Each call must be balanced by a corresponding `releaseModel` call.
   */
  public async acquireModel(path: string): Promise<Monaco.editor.ITextModel | undefined> {
    this.registerEditorModel(path);
    return this.getOrEnsureModel(path);
  }

  /**
   * Release a ref-counted editor hold. When the last hold is released,
   * the model transitions to the background pool (subject to TTL/cap eviction).
   */
  public releaseModel(path: string): void {
    this.unregisterEditorModel(path);
  }

  /**
   * Get or create a Monaco model for a given path.
   * Returns undefined if the file can't be loaded.
   */
  public async getOrEnsureModel(path: string): Promise<Monaco.editor.ITextModel | undefined> {
    if (!this.monaco || !this.contentService) {
      return undefined;
    }

    const uri = this.createUri(path);
    const existing = this.monaco.editor.getModel(uri);

    if (existing) {
      // Update access time for background models
      if (!this.editorHolds.has(path)) {
        this.backgroundAccessTimes.set(path, Date.now());
      }

      return existing;
    }

    const capturedEpoch = this.epoch;

    try {
      const result = await this.contentService.resolve(path);

      // Check epoch hasn't changed during async read
      if (this.epoch !== capturedEpoch || this.abortController?.signal.aborted) {
        return undefined;
      }

      // Only text outcomes back a Monaco model. Binary, too-large, orphaned,
      // and error outcomes intentionally return undefined so the editor falls
      // back to its placeholder UI.
      if (result.kind !== 'text') {
        return undefined;
      }

      // Re-check model (could have been created during async read)
      const recheck = this.monaco.editor.getModel(uri);
      if (recheck) {
        return recheck;
      }

      const text = decodeTextFile(result.content);
      const language = this.detectLanguage(path);
      const model = this.monaco.editor.createModel(text, language, uri);

      this.trackModelCreated();

      // Track as background model if not editor-held
      if (!this.editorHolds.has(path)) {
        this.backgroundAccessTimes.set(path, Date.now());
      }

      this.syncedPaths.add(path);
      return model;
    } catch {
      // Read error -- silently return undefined
      return undefined;
    }
  }

  /**
   * Get diagnostics for dev-mode observability.
   */
  public getDiagnostics(): ServiceDiagnostics {
    return {
      ...this.metrics,
      editorHeldCount: this.editorHolds.size,
      backgroundCount: this.backgroundAccessTimes.size,
      currentModelCount: this.monaco?.editor.getModels().length ?? 0,
    };
  }

  private registerEditorModel(path: string): void {
    const current = this.editorHolds.get(path) ?? 0;
    this.editorHolds.set(path, current + 1);

    // Remove from background tracking since it's now editor-held
    this.backgroundAccessTimes.delete(path);
  }

  private unregisterEditorModel(path: string): void {
    const current = this.editorHolds.get(path) ?? 0;
    if (current <= 1) {
      this.editorHolds.delete(path);
      // Move to background tracking
      this.backgroundAccessTimes.set(path, Date.now());
    } else {
      this.editorHolds.set(path, current - 1);
    }
  }

  // ============ Content Event Handler ============

  private handleContentChange(event: ContentChangeEvent): void {
    if (!this.monaco) {
      return;
    }

    switch (event.type) {
      case 'written': {
        if (event.source === 'editor') {
          return;
        }
        this.applyWritten(event.path, event.data, event.source);
        break;
      }
      case 'batchWritten': {
        for (const path of event.paths) {
          const cached = this.contentService?.peek(path);
          if (cached) {
            this.applyWritten(path, cached, event.source);
          }
        }
        break;
      }
      case 'deleted': {
        const uri = this.createUri(event.path);
        this.monaco.editor.getModel(uri)?.dispose();
        this.editorHolds.delete(event.path);
        this.backgroundAccessTimes.delete(event.path);
        this.syncedPaths.delete(event.path);
        this.markerService?.removeUri(uri.toString());
        break;
      }
      case 'renamed': {
        const oldUri = this.createUri(event.oldPath);
        const newUri = this.createUri(event.newPath);
        const oldModel = this.monaco.editor.getModel(oldUri);
        const content = oldModel?.getValue() ?? '';
        oldModel?.dispose();

        const editorCount = this.editorHolds.get(event.oldPath);
        this.editorHolds.delete(event.oldPath);
        if (editorCount !== undefined) {
          this.editorHolds.set(event.newPath, editorCount);
        }

        this.backgroundAccessTimes.delete(event.oldPath);
        this.syncedPaths.delete(event.oldPath);

        const language = this.detectLanguage(event.newPath);
        if (language && content) {
          this.monaco.editor.createModel(content, language, newUri);
          this.trackModelCreated();
          this.syncedPaths.add(event.newPath);

          if (!this.editorHolds.has(event.newPath)) {
            this.backgroundAccessTimes.set(event.newPath, Date.now());
          }
        }

        this.markerService?.migrateUri(oldUri.toString(), newUri.toString());
        break;
      }
      case 'read': {
        break;
      }
    }
  }

  private applyWritten(path: string, data: Uint8Array<ArrayBuffer>, source: string): void {
    if (!this.monaco) {
      return;
    }

    const uri = this.createUri(path);
    const newContent = decodeTextFile(data);
    const existingModel = this.monaco.editor.getModel(uri);

    if (existingModel) {
      const currentModelValue = existingModel.getValue();
      if (currentModelValue !== newContent) {
        if (this.editorHolds.has(path)) {
          existingModel.pushStackElement();
          existingModel.pushEditOperations(
            [],
            [{ range: existingModel.getFullModelRange(), text: newContent }],
            () => null,
          );
          existingModel.pushStackElement();
        } else {
          existingModel.setValue(newContent);
        }
      }
    } else if (source === 'user') {
      const language = this.detectLanguage(path);
      if (language) {
        this.monaco.editor.createModel(newContent, language, uri);
        this.trackModelCreated();
        this.syncedPaths.add(path);

        if (!this.editorHolds.has(path)) {
          this.backgroundAccessTimes.set(path, Date.now());
        }
      }
    } else {
      const language = this.detectLanguage(path);
      if (language && !path.includes('node_modules')) {
        this.monaco.editor.createModel(newContent, language, uri);
        this.trackModelCreated();
        this.syncedPaths.add(path);
        this.backgroundAccessTimes.set(path, Date.now());
      }
    }
  }

  /**
   * Create a root-level Monaco URI from a relative path.
   */
  private createUri(relativePath: string): Monaco.Uri {
    return this.monaco!.Uri.file(`/${relativePath}`);
  }

  // ============ Background Sync ============

  private startBackgroundSync(): void {
    if (!this.contentService) {
      return;
    }

    void this.syncAllInBackground();
  }

  private async syncAllInBackground(): Promise<void> {
    if (!this.treeService || !this.monaco) {
      return;
    }

    const capturedEpoch = this.epoch;
    const signal = this.abortController?.signal;

    try {
      const tree = this.treeService.getTreeSnapshot();

      if (this.epoch !== capturedEpoch || signal?.aborted) {
        return;
      }

      const jsFiles = [...tree.values()].filter(
        (entry) => entry.type === 'file' && isJsLikeFile(entry.path) && !entry.path.includes('node_modules'),
      );

      // Process files in batches during idle time
      let index = 0;
      const processNextBatch = (): void => {
        if (this.epoch !== capturedEpoch || signal?.aborted) {
          return;
        }

        const batchSize = 5;
        const endIndex = Math.min(index + batchSize, jsFiles.length);

        for (let i = index; i < endIndex; i++) {
          void this.syncBackgroundFile(jsFiles[i]!.path, capturedEpoch);
        }

        index = endIndex;
        if (index < jsFiles.length) {
          if ('requestIdleCallback' in globalThis) {
            requestIdleCallback(processNextBatch, { timeout: 1000 });
          } else {
            setTimeout(processNextBatch, 16);
          }
        }
      };

      if ('requestIdleCallback' in globalThis) {
        requestIdleCallback(processNextBatch, { timeout: 1000 });
      } else {
        setTimeout(processNextBatch, 0);
      }
    } catch {
      // Directory read failed -- silently ignore
    }
  }

  private async syncBackgroundFile(filePath: string, capturedEpoch: number): Promise<void> {
    if (!this.monaco || !this.contentService) {
      return;
    }

    if (this.syncedPaths.has(filePath) || this.epoch !== capturedEpoch) {
      return;
    }

    if (!isJsLikeFile(filePath) || filePath.includes('node_modules')) {
      return;
    }

    const uri = this.createUri(filePath);

    try {
      const result = await this.contentService.resolve(filePath);

      if (this.epoch !== capturedEpoch || this.abortController?.signal.aborted) {
        return;
      }

      // Background model warm-up only applies to text content; binary,
      // too-large, orphaned, and error outcomes do not produce models.
      if (result.kind !== 'text') {
        return;
      }

      const text = decodeTextFile(result.content);

      // Check if model already exists (may have been recreated by the Editor
      // component with stale content after setBuildSession disposed it).
      const existingModel = this.monaco.editor.getModel(uri);
      if (existingModel) {
        // Update content if it differs from the filesystem (fixes stale model content)
        if (existingModel.getValue() !== text) {
          existingModel.setValue(text);

          // Safety net: immediately clear TypeScript/JavaScript worker markers
          // from the previous project. The TS worker will re-validate the updated
          // content asynchronously and set fresh markers, but clearing now prevents
          // stale errors from showing during the debounce window.
          this.monaco.editor.setModelMarkers(existingModel, 'typescript', []);
          this.monaco.editor.setModelMarkers(existingModel, 'javascript', []);
        }

        this.syncedPaths.add(filePath);
        return;
      }

      if (this.backgroundAccessTimes.size >= maxBackgroundModels) {
        return;
      }

      const language = getMonacoLanguage(filePath);
      if (language) {
        this.monaco.editor.createModel(text, language, uri);
        this.trackModelCreated();
        this.syncedPaths.add(filePath);
        this.backgroundAccessTimes.set(filePath, Date.now());
      }
    } catch {
      // File read failed -- silently ignore
    }
  }

  // ============ Background Model Eviction ============

  private evictStaleBackgroundModels(): void {
    if (!this.monaco) {
      return;
    }

    const now = Date.now();

    // TTL eviction
    for (const [path, lastAccess] of this.backgroundAccessTimes) {
      if (now - lastAccess > backgroundModelTtlMs) {
        const uri = this.createUri(path);
        this.monaco.editor.getModel(uri)?.dispose();
        this.backgroundAccessTimes.delete(path);
        this.syncedPaths.delete(path);
        this.metrics.evictionCount++;
      }
    }

    // Hard cap eviction -- evict oldest first
    if (this.backgroundAccessTimes.size > maxBackgroundModels) {
      const sorted = [...this.backgroundAccessTimes.entries()].sort(([, a], [, b]) => a - b);
      const toEvict = sorted.slice(0, this.backgroundAccessTimes.size - maxBackgroundModels);

      for (const [path] of toEvict) {
        const uri = this.createUri(path);
        this.monaco.editor.getModel(uri)?.dispose();
        this.backgroundAccessTimes.delete(path);
        this.syncedPaths.delete(path);
        this.metrics.evictionCount++;
      }
    }
  }

  // ============ Helpers ============

  /**
   * Detect the Monaco language for a file path.
   */
  private detectLanguage(path: string): string | undefined {
    return getMonacoLanguage(path);
  }

  /**
   * Dispose all Monaco models managed by this service.
   * Only disposes models tracked by this service (editorHolds, backgroundAccessTimes, syncedPaths),
   * leaving Monaco internals (TypeScript lib files, ATA-injected type declarations, etc.) intact.
   */
  private disposeAllModels(): void {
    if (!this.monaco) {
      return;
    }

    const trackedPaths = new Set([
      ...this.editorHolds.keys(),
      ...this.backgroundAccessTimes.keys(),
      ...this.syncedPaths,
    ]);

    for (const path of trackedPaths) {
      const uri = this.createUri(path);
      this.monaco.editor.getModel(uri)?.dispose();
    }
  }

  /**
   * Track that a model was created (for metrics).
   */
  private trackModelCreated(): void {
    this.metrics.totalModelsCreated++;
    const currentCount = this.monaco?.editor.getModels().length ?? 0;
    if (currentCount > this.metrics.peakModelCount) {
      this.metrics.peakModelCount = currentCount;
    }
  }
}
