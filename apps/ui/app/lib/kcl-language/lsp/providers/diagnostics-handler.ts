/**
 * Diagnostics handler for KCL LSP.
 * Subscribes to publishDiagnostics notifications and converts them to Monaco markers.
 */

import type * as Monaco from 'monaco-editor';
import type * as LSP from 'vscode-languageserver-protocol';
import { lspSeverityToMonaco } from '#lib/kcl-language/lsp/utils/position-utils.js';

const kclMarkerOwner = 'kcl-lsp';

/**
 * Handle LSP publishDiagnostics notification and set Monaco markers.
 */
export function handleDiagnostics(monaco: typeof Monaco, parameters: LSP.PublishDiagnosticsParams): void {
  const uri = monaco.Uri.parse(parameters.uri);
  const model = monaco.editor.getModel(uri);

  if (!model) {
    return;
  }

  const markers: Monaco.editor.IMarkerData[] = parameters.diagnostics.map((diagnostic) => ({
    severity: lspSeverityToMonaco(monaco, diagnostic.severity),
    startLineNumber: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLineNumber: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
    message: diagnostic.message,
    source: diagnostic.source,
    code: typeof diagnostic.code === 'string' ? diagnostic.code : String(diagnostic.code ?? ''),
  }));

  monaco.editor.setModelMarkers(model, kclMarkerOwner, markers);
}

/**
 * Clear all KCL diagnostics for a given URI.
 */
export function clearDiagnostics(monaco: typeof Monaco, uri: string): void {
  const monacoUri = monaco.Uri.parse(uri);
  const model = monaco.editor.getModel(monacoUri);

  if (model) {
    monaco.editor.setModelMarkers(model, kclMarkerOwner, []);
  }
}

/**
 * Create a notification handler that processes diagnostics.
 */
export function createDiagnosticsHandler(monaco: typeof Monaco): (notification: LSP.NotificationMessage) => void {
  return (notification: LSP.NotificationMessage) => {
    if (notification.method === 'textDocument/publishDiagnostics') {
      handleDiagnostics(monaco, notification.params as LSP.PublishDiagnosticsParams);
    }
  };
}
