/**
 * Monaco rename provider for KCL LSP.
 */

import type * as Monaco from 'monaco-editor';
import type { KclLspClient } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import { monacoToLspPosition, lspToMonacoRange } from '#lib/kcl-language/lsp/utils/position-utils.js';

/**
 * Create a Monaco rename provider that uses the LSP client.
 */
export function createRenameProvider(monaco: typeof Monaco, client: KclLspClient): Monaco.languages.RenameProvider {
  return {
    async provideRenameEdits(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      newName: string,
      _token: Monaco.CancellationToken,
    ): Promise<Monaco.languages.WorkspaceEdit | undefined> {
      const result = await client.textDocumentRename({
        textDocument: { uri: model.uri.toString() },
        position: monacoToLspPosition(position),
        newName,
      });

      if (!result) {
        return undefined;
      }

      return convertWorkspaceEdit(monaco, result);
    },

    async resolveRenameLocation(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      _token: Monaco.CancellationToken,
    ): Promise<Monaco.languages.RenameLocation | undefined> {
      const result = await client.textDocumentPrepareRename({
        textDocument: { uri: model.uri.toString() },
        position: monacoToLspPosition(position),
      });

      if (!result) {
        return undefined;
      }

      // Handle different return types
      if ('range' in result) {
        // PrepareRenameResult with range
        const prepareResult = result as {
          range: { start: { line: number; character: number }; end: { line: number; character: number } };
          placeholder: string;
        };

        return {
          range: lspToMonacoRange(monaco, prepareResult.range),
          text: prepareResult.placeholder,
        };
      }

      if ('start' in result && 'end' in result) {
        // Plain Range
        const range = result as {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };

        return {
          range: lspToMonacoRange(monaco, range),
          text: model.getValueInRange(lspToMonacoRange(monaco, range)),
        };
      }

      return undefined;
    },
  };
}

/**
 * Convert LSP WorkspaceEdit to Monaco WorkspaceEdit.
 */
function convertWorkspaceEdit(
  monaco: typeof Monaco,
  edit: {
    changes?: Record<
      string,
      Array<{
        range: { start: { line: number; character: number }; end: { line: number; character: number } };
        newText: string;
      }>
    >;
  },
): Monaco.languages.WorkspaceEdit {
  const edits: Monaco.languages.IWorkspaceTextEdit[] = [];

  if (edit.changes) {
    for (const [uri, textEdits] of Object.entries(edit.changes)) {
      for (const textEdit of textEdits) {
        edits.push({
          resource: monaco.Uri.parse(uri),
          textEdit: {
            range: lspToMonacoRange(monaco, textEdit.range),
            text: textEdit.newText,
          },
          versionId: undefined,
        });
      }
    }
  }

  return { edits };
}
