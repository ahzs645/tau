/**
 * Monaco Language Contribution Registry
 *
 * Manages a uniform, idempotent, two-phase lifecycle for all language contributions.
 * Follows VS Code's extension activation pattern:
 *
 * 1. Register phase (during configureMonaco): Language metadata, syntax config. No services needed.
 * 2. Activate phase (when services ready): Providers, LSP clients, navigation handlers.
 *
 * Idempotency / HMR safety:
 * - addContribution: keyed by languageId, duplicate adds are silently ignored
 * - registerAll: guarded by flag, subsequent calls are no-ops
 * - activate: guarded by epoch, only activates if lastActivatedEpoch < activationEpoch
 */

import type * as Monaco from 'monaco-editor';
import type { MonacoModelService } from '#lib/monaco-model-service.js';
import type { MonacoMarkerService } from '#lib/monaco-marker-service.js';
import type { FileManagerRef, FileManagerApi } from '#machines/file-manager.machine.types.js';

export type NavigationHandler = {
  canHandle(path: string): boolean;
  isReadOnly?(path: string): boolean;
};

export type ActivationContext = {
  monaco: typeof Monaco;
  modelService: MonacoModelService;
  markerService: MonacoMarkerService;
  fileManager: FileManagerApi;
  fileManagerRef: FileManagerRef;
};

export type ActivationResult = {
  disposables: Monaco.IDisposable[];
  navigationHandler?: NavigationHandler;
};

export type LanguageContribution = {
  readonly languageId: string;

  /** Phase 1: Called during configureMonaco. Register language metadata only. */
  register(monaco: typeof Monaco): void;

  /** Phase 2: Called when services are available. Register providers, start LSP, etc. */
  activate(context: ActivationContext): ActivationResult;

  /** Called on project session change. Reset caches, document tracking, etc. */
  onProjectSessionChange?(projectId: string): void;

  /** Dispose all resources. Called on unmount or before re-activation. */
  dispose(): void;
};

export class LanguageContributionRegistry {
  private readonly contributions = new Map<string, LanguageContribution>();
  private registered = false;
  private activationEpoch = 0;
  private lastActivatedEpoch = -1;

  /** Disposables from the current activation cycle */
  private activationDisposables: Monaco.IDisposable[] = [];

  /** Navigation handlers from the current activation cycle */
  private currentHandlers: NavigationHandler[] = [];

  /**
   * Add a contribution. Idempotent: silently skips if languageId already added.
   */
  public addContribution(contribution: LanguageContribution): void {
    if (this.contributions.has(contribution.languageId)) {
      return;
    }

    this.contributions.set(contribution.languageId, contribution);
  }

  /**
   * Phase 1: Register all contributions (language metadata only). Idempotent.
   */
  public registerAll(monaco: typeof Monaco): void {
    if (this.registered) {
      return;
    }

    this.registered = true;

    for (const contribution of this.contributions.values()) {
      contribution.register(monaco);
    }
  }

  /**
   * Phase 2: Activate all contributions with services.
   * Returns navigation handlers. Idempotent per epoch.
   */
  public activate(context: ActivationContext): NavigationHandler[] {
    if (this.lastActivatedEpoch >= this.activationEpoch) {
      return this.currentHandlers;
    }

    // Dispose previous activation
    this.disposeActivation();

    this.currentHandlers = [];

    for (const contribution of this.contributions.values()) {
      try {
        const result = contribution.activate(context);

        this.activationDisposables.push(...result.disposables);

        if (result.navigationHandler) {
          this.currentHandlers.push(result.navigationHandler);
        }
      } catch (error) {
        console.error(`Failed to activate language contribution "${contribution.languageId}":`, error);
      }
    }

    // Commit epoch AFTER all contributions have been processed
    this.lastActivatedEpoch = this.activationEpoch;

    return this.currentHandlers;
  }

  /**
   * Forward project session change to all contributions. Increments activation epoch.
   */
  public onProjectSessionChange(projectId: string): void {
    this.activationEpoch++;

    for (const contribution of this.contributions.values()) {
      contribution.onProjectSessionChange?.(projectId);
    }
  }

  /**
   * Dispose all contributions and activation resources.
   */
  public dispose(): void {
    this.disposeActivation();

    for (const contribution of this.contributions.values()) {
      contribution.dispose();
    }

    // Reset state but keep contributions (they can be re-activated)
    this.registered = false;
    this.lastActivatedEpoch = -1;
    this.activationEpoch = 0;
    this.currentHandlers = [];
  }

  /**
   * Dispose current activation disposables.
   */
  private disposeActivation(): void {
    for (const disposable of this.activationDisposables) {
      disposable.dispose();
    }

    this.activationDisposables = [];
  }
}

/**
 * Global singleton registry instance.
 * Contributions register during module load, activated later by the provider.
 */
export const registry = new LanguageContributionRegistry();
