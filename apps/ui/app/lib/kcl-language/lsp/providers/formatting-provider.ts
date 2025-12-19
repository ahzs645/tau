/**
 * Monaco document formatting provider for KCL LSP.
 */

import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { KclLspClient } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import { lspToMonacoRange } from '#lib/kcl-language/lsp/utils/position-utils.js';

/**
 * Create a Monaco document formatting provider that uses the LSP client.
 */
export function createFormattingProvider(
  monaco: typeof Monaco,
  client: KclLspClient,
): Monaco.languages.DocumentFormattingEditProvider {
  return {
    async provideDocumentFormattingEdits(
      model: Monaco.editor.ITextModel,
      options: Monaco.languages.FormattingOptions,
      _token: Monaco.CancellationToken,
    ): Promise<Monaco.languages.TextEdit[] | undefined> {
      const result = await client.textDocumentFormatting({
        textDocument: { uri: model.uri.toString() },
        options: {
          tabSize: options.tabSize,
          insertSpaces: options.insertSpaces,
        },
      });

      if (!result) {
        return undefined;
      }

      return result.map((edit) => ({
        range: lspToMonacoRange(monaco, edit.range),
        text: edit.newText,
      }));
    },
  };
}
