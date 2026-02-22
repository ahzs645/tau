/**
 * Monaco Marker Service
 *
 * Decouples marker storage from model existence. Markers persist across
 * model create/dispose cycles and are automatically applied when models appear.
 * Handles file rename/delete reconciliation.
 *
 * This replaces all direct `monaco.editor.setModelMarkers` calls across the codebase,
 * centralizing marker ownership and ensuring diagnostics are never silently dropped.
 */

import type * as Monaco from 'monaco-editor';

export class MonacoMarkerService {
  private monaco: typeof Monaco | undefined;

  /** Uri -> owner -> markers */
  private readonly store = new Map<string, Map<string, Monaco.editor.IMarkerData[]>>();

  private readonly disposables: Monaco.IDisposable[] = [];

  /**
   * Initialize the marker service with Monaco.
   * Subscribes to model lifecycle events to apply/retain markers.
   */
  public initialize(monaco: typeof Monaco): void {
    this.monaco = monaco;

    // When a model is created, apply any stored markers for its URI
    this.disposables.push(
      monaco.editor.onDidCreateModel((model) => {
        const uri = model.uri.toString();
        const ownerMap = this.store.get(uri);
        if (!ownerMap) {
          return;
        }

        for (const [owner, markers] of ownerMap) {
          monaco.editor.setModelMarkers(model, owner, markers);
        }
      }),
    );

    // When a model is disposed, markers stay in our store (NOT cleared).
    // They will be re-applied if the model is recreated.
    // No action needed on onWillDisposeModel for storage -- Monaco clears
    // its own markers when the model is disposed.
  }

  /**
   * Dispose all subscriptions and clear storage.
   */
  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this.disposables.length = 0;
    this.store.clear();
    this.monaco = undefined;
  }

  /**
   * Set markers for a URI+owner. Stores AND applies if model exists.
   */
  public setMarkers(uri: string, owner: string, markers: Monaco.editor.IMarkerData[]): void {
    // Store
    let ownerMap = this.store.get(uri);
    if (!ownerMap) {
      ownerMap = new Map();
      this.store.set(uri, ownerMap);
    }

    if (markers.length === 0) {
      ownerMap.delete(owner);
      if (ownerMap.size === 0) {
        this.store.delete(uri);
      }
    } else {
      ownerMap.set(owner, markers);
    }

    // Apply if model exists
    if (this.monaco) {
      const model = this.monaco.editor.getModel(this.monaco.Uri.parse(uri));
      if (model) {
        this.monaco.editor.setModelMarkers(model, owner, markers);
      }
    }
  }

  /**
   * Clear markers for a URI+owner.
   */
  public clearMarkers(uri: string, owner: string): void {
    this.setMarkers(uri, owner, []);
  }

  /**
   * Clear ALL markers for a specific owner across all URIs.
   * Used by contribution dispose to clean up its own markers.
   */
  public clearOwnerEverywhere(owner: string): void {
    if (!this.monaco) {
      return;
    }

    for (const [uri, ownerMap] of this.store) {
      if (ownerMap.has(owner)) {
        ownerMap.delete(owner);
        if (ownerMap.size === 0) {
          this.store.delete(uri);
        }

        // Clear on model if it exists
        const model = this.monaco.editor.getModel(this.monaco.Uri.parse(uri));
        if (model) {
          this.monaco.editor.setModelMarkers(model, owner, []);
        }
      }
    }
  }

  /**
   * Remove all stored markers for a URI (all owners). Called on file delete.
   */
  public removeUri(uri: string): void {
    const ownerMap = this.store.get(uri);
    if (!ownerMap || !this.monaco) {
      this.store.delete(uri);
      return;
    }

    // Clear Monaco markers for each owner on the model if it exists
    const model = this.monaco.editor.getModel(this.monaco.Uri.parse(uri));
    if (model) {
      for (const owner of ownerMap.keys()) {
        this.monaco.editor.setModelMarkers(model, owner, []);
      }
    }

    this.store.delete(uri);
  }

  /**
   * Migrate all stored markers from one URI to another. Called on file rename.
   */
  public migrateUri(oldUri: string, newUri: string): void {
    const ownerMap = this.store.get(oldUri);
    if (!ownerMap) {
      return;
    }

    // Remove old entry
    this.store.delete(oldUri);

    // Clear markers on old model if it exists
    if (this.monaco) {
      const oldModel = this.monaco.editor.getModel(this.monaco.Uri.parse(oldUri));
      if (oldModel) {
        for (const owner of ownerMap.keys()) {
          this.monaco.editor.setModelMarkers(oldModel, owner, []);
        }
      }
    }

    // Store under new URI
    this.store.set(newUri, ownerMap);

    // Apply to new model if it exists
    if (this.monaco) {
      const newModel = this.monaco.editor.getModel(this.monaco.Uri.parse(newUri));
      if (newModel) {
        for (const [owner, markers] of ownerMap) {
          this.monaco.editor.setModelMarkers(newModel, owner, markers);
        }
      }
    }
  }

  /**
   * Clear all stored markers (session reset).
   * Empties the store AND clears all Monaco markers on existing models.
   */
  public clearAll(): void {
    if (this.monaco) {
      for (const [uri, ownerMap] of this.store) {
        const model = this.monaco.editor.getModel(this.monaco.Uri.parse(uri));
        if (model) {
          for (const owner of ownerMap.keys()) {
            this.monaco.editor.setModelMarkers(model, owner, []);
          }
        }
      }
    }

    this.store.clear();
  }

  /**
   * Get stored markers for a URI (all owners). For diagnostics/debugging.
   */
  public getMarkers(uri: string): Map<string, Monaco.editor.IMarkerData[]> {
    return this.store.get(uri) ?? new Map<string, Monaco.editor.IMarkerData[]>();
  }
}
