/**
 * MIME type for file drags originating from the headless-tree file explorer.
 * Used by Dockview drop handlers to identify internal file drag-and-drop.
 */
export const tauFileDragMime = 'application/x-tau-file';

/**
 * MIME type set on editor panel tab drags for cross-dockview identification.
 * Payload: JSON-encoded `{ filePath: string }`.
 */
export const tauEditorPanelDragMime = 'application/x-tau-editor-panel';

/**
 * MIME type set on viewer panel tab drags for cross-dockview identification.
 * Payload: JSON-encoded `{ entryFile: string }`.
 */
export const tauViewerPanelDragMime = 'application/x-tau-viewer-panel';
