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
import type { Subscription } from 'xstate';
import type { FileManagerRef, FileManagerApi, FileManagerEmitted } from '#machines/file-manager.machine.types.js';
import type { MonacoMarkerService } from '#lib/monaco-marker-service.js';
import { isJsLikeFile, getMonacoLanguage } from '#lib/monaco.constants.js';
import { decodeTextFile } from '#utils/filesystem.utils.js';

export type ModelServiceConfig = {
  monaco: typeof Monaco;
  fileManagerRef: FileManagerRef;
  fileManager: Pick<FileManagerApi, 'readFile' | 'getDirectoryStat'>;
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
  private fileManagerRef: FileManagerRef | undefined;
  private fileManager: Pick<FileManagerApi, 'readFile' | 'getDirectoryStat'> | undefined;
  private markerService: MonacoMarkerService | undefined;

  /** Session epoch -- incremented on each build session change */
  private epoch = 0;

  /** AbortController for current session -- aborted on session change and dispose */
  private abortController: AbortController | undefined;

  /** Ref-counted editor holds: path -> refCount */
  private readonly editorHolds = new Map<string, number>();

  /** Background model access times for TTL eviction: path -> lastAccessTime */
  private readonly backgroundAccessTimes = new Map<string, number>();

  /** Set of paths that have been synced in the current session */
  private readonly syncedPaths = new Set<string>();

  /** Subscriptions to clean up */
  private readonly subscriptions: Subscription[] = [];

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
    this.fileManagerRef = config.fileManagerRef;
    this.fileManager = config.fileManager;
    this.markerService = config.markerService;

    this.abortController = new AbortController();

    // Subscribe to file events (SINGLE subscriber -- eliminates race)
    this.subscriptions.push(
      this.fileManagerRef.on('fileWritten', (event) => {
        this.handleFileWritten(event as FileManagerEmitted & { type: 'fileWritten' });
      }),
      this.fileManagerRef.on('fileDeleted', (event) => {
        this.handleFileDeleted(event as FileManagerEmitted & { type: 'fileDeleted' });
      }),
      this.fileManagerRef.on('fileRenamed', (event) => {
        this.handleFileRenamed(event as FileManagerEmitted & { type: 'fileRenamed' });
      }),
    );

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
    // Abort in-flight async work
    this.abortController?.abort();
    this.abortController = undefined;

    // Clear eviction timer
    if (this.evictionTimerId !== undefined) {
      clearInterval(this.evictionTimerId);
      this.evictionTimerId = undefined;
    }

    // Unsubscribe from file events
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }

    this.subscriptions.length = 0;

    // Dispose all models
    this.disposeAllModels();

    // Clear state
    this.editorHolds.clear();
    this.backgroundAccessTimes.clear();
    this.syncedPaths.clear();

    this.monaco = undefined;
    this.fileManagerRef = undefined;
    this.fileManager = undefined;
    this.markerService = undefined;
  }

  /**
   * Switch to a new build session. Aborts in-flight work, clears state, restarts sync.
   */
  public setBuildSession(_buildId: string): void {
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
   * Register an editor hold for a path. Creates model if needed.
   * Call when the editor opens a file.
   */
  public registerEditorModel(path: string): void {
    const current = this.editorHolds.get(path) ?? 0;
    this.editorHolds.set(path, current + 1);

    // Remove from background tracking since it's now editor-held
    this.backgroundAccessTimes.delete(path);
  }

  /**
   * Unregister an editor hold for a path.
   * Call when the editor closes a file (or switches away).
   */
  public unregisterEditorModel(path: string): void {
    const current = this.editorHolds.get(path) ?? 0;
    if (current <= 1) {
      this.editorHolds.delete(path);
      // Move to background tracking
      this.backgroundAccessTimes.set(path, Date.now());
    } else {
      this.editorHolds.set(path, current - 1);
    }
  }

  /**
   * Get or create a Monaco model for a given path.
   * Returns undefined if the file can't be loaded.
   */
  public async getOrEnsureModel(path: string): Promise<Monaco.editor.ITextModel | undefined> {
    if (!this.monaco || !this.fileManager) {
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

    // Load from filesystem
    const capturedEpoch = this.epoch;

    try {
      const content = await this.fileManager.readFile(path);

      // Check epoch hasn't changed during async read
      if (this.epoch !== capturedEpoch || this.abortController?.signal.aborted) {
        return undefined;
      }

      // Re-check model (could have been created during async read)
      const recheck = this.monaco.editor.getModel(uri);
      if (recheck) {
        return recheck;
      }

      const text = decodeTextFile(content);
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
      // File not found or read error -- silently return undefined
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

  // ============ File Event Handlers ============

  private handleFileWritten(event: FileManagerEmitted & { type: 'fileWritten' }): void {
    if (!this.monaco) {
      return;
    }

    const { path, data, source } = event;

    // Skip Monaco model updates for editor typing to avoid recursion
    if (source === 'editor') {
      return;
    }

    const uri = this.createUri(path);
    const newContent = decodeTextFile(data);
    const existingModel = this.monaco.editor.getModel(uri);

    if (existingModel) {
      // Update existing model if content changed
      const currentModelValue = existingModel.getValue();
      if (currentModelValue !== newContent) {
        if (this.editorHolds.has(path)) {
          // Editor-held: use pushEditOperations to preserve undo history
          existingModel.pushStackElement();
          existingModel.pushEditOperations(
            [],
            [{ range: existingModel.getFullModelRange(), text: newContent }],
            () => null,
          );
          existingModel.pushStackElement();
        } else {
          // Background: use setValue (cheaper, no undo needed)
          existingModel.setValue(newContent);
        }
      }
    } else if (source === 'user') {
      // For user operations (create/upload), create a new model
      const language = this.detectLanguage(path);
      if (language) {
        this.monaco.editor.createModel(newContent, language, uri);
        this.trackModelCreated();
        this.syncedPaths.add(path);

        if (!this.editorHolds.has(path)) {
          this.backgroundAccessTimes.set(path, Date.now());
        }
      }
    } else if (this.shouldSyncFile(path)) {
      // For machine sources on JS-like files, create background model
      const language = this.detectLanguage(path);
      if (language) {
        this.monaco.editor.createModel(newContent, language, uri);
        this.trackModelCreated();
        this.syncedPaths.add(path);
        this.backgroundAccessTimes.set(path, Date.now());
      }
    }
  }

  private handleFileDeleted(event: FileManagerEmitted & { type: 'fileDeleted' }): void {
    if (!this.monaco) {
      return;
    }

    const { path } = event;
    const uri = this.createUri(path);
    const uriString = uri.toString();

    // Dispose model
    this.monaco.editor.getModel(uri)?.dispose();

    // Clean up tracking
    this.editorHolds.delete(path);
    this.backgroundAccessTimes.delete(path);
    this.syncedPaths.delete(path);

    // Clean up markers
    this.markerService?.removeUri(uriString);
  }

  private handleFileRenamed(event: FileManagerEmitted & { type: 'fileRenamed' }): void {
    if (!this.monaco) {
      return;
    }

    const { oldPath, newPath } = event;
    const oldUri = this.createUri(oldPath);
    const newUri = this.createUri(newPath);

    // Get old model content before disposing
    const oldModel = this.monaco.editor.getModel(oldUri);
    const content = oldModel?.getValue() ?? '';
    oldModel?.dispose();

    // Transfer tracking
    const editorCount = this.editorHolds.get(oldPath);
    this.editorHolds.delete(oldPath);
    if (editorCount !== undefined) {
      this.editorHolds.set(newPath, editorCount);
    }

    this.backgroundAccessTimes.delete(oldPath);
    this.syncedPaths.delete(oldPath);

    // Create new model
    const language = this.detectLanguage(newPath);
    if (language && content) {
      this.monaco.editor.createModel(content, language, newUri);
      this.trackModelCreated();
      this.syncedPaths.add(newPath);

      if (!this.editorHolds.has(newPath)) {
        this.backgroundAccessTimes.set(newPath, Date.now());
      }
    }

    // Migrate markers
    this.markerService?.migrateUri(oldUri.toString(), newUri.toString());
  }

  /**
   * Create a root-level Monaco URI from a relative path.
   */
  private createUri(relativePath: string): Monaco.Uri {
    return this.monaco!.Uri.file(`/${relativePath}`);
  }

  // ============ Background Sync ============

  private startBackgroundSync(): void {
    if (!this.fileManager) {
      return;
    }

    void this.syncAllInBackground();
  }

  private async syncAllInBackground(): Promise<void> {
    if (!this.fileManager || !this.monaco) {
      return;
    }

    const capturedEpoch = this.epoch;
    const signal = this.abortController?.signal;

    try {
      const stats = await this.fileManager.getDirectoryStat('');

      if (this.epoch !== capturedEpoch || signal?.aborted) {
        return;
      }

      const jsFiles = stats.filter(
        (s) => s.type === 'file' && isJsLikeFile(s.path) && !s.path.includes('node_modules'),
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
    if (!this.monaco || !this.fileManager) {
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
      const content = await this.fileManager.readFile(filePath);

      if (this.epoch !== capturedEpoch || this.abortController?.signal.aborted) {
        return;
      }

      const text = decodeTextFile(content);

      // Check if model already exists (may have been recreated by the Editor
      // component with stale content after setBuildSession disposed it).
      const existingModel = this.monaco.editor.getModel(uri);
      if (existingModel) {
        // Update content if it differs from the filesystem (fixes stale model content)
        if (existingModel.getValue() !== text) {
          existingModel.setValue(text);

          // Safety net: immediately clear TypeScript/JavaScript worker markers
          // from the previous build. The TS worker will re-validate the updated
          // content asynchronously and set fresh markers, but clearing now prevents
          // stale errors from showing during the debounce window.
          this.monaco.editor.setModelMarkers(existingModel, 'typescript', []);
          this.monaco.editor.setModelMarkers(existingModel, 'javascript', []);
        }

        this.syncedPaths.add(filePath);
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
   * Check if a file should be synced as a background model.
   * Only user source files (JS/TS, not in node_modules) are synced.
   * Type declarations for node_modules are handled by the TypeAcquisitionService.
   */
  private shouldSyncFile(path: string): boolean {
    return isJsLikeFile(path) && !path.includes('node_modules');
  }

  /**
   * Dispose all Monaco models managed by this service.
   */
  private disposeAllModels(): void {
    if (!this.monaco) {
      return;
    }

    const models = this.monaco.editor.getModels();
    for (const model of models) {
      model.dispose();
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
