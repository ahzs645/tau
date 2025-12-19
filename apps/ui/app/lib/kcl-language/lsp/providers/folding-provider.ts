/**
 * Monaco folding range provider for KCL LSP.
 */

import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { KclLspClient } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import { lspToMonacoFoldingRangeKind } from '#lib/kcl-language/lsp/utils/lsp-kind-utils.js';

/**
 * Create a Monaco folding range provider that uses the LSP client.
 */
export function createFoldingRangeProvider(
  monaco: typeof Monaco,
  client: KclLspClient,
): Monaco.languages.FoldingRangeProvider {
  return {
    async provideFoldingRanges(
      model: Monaco.editor.ITextModel,
      _context: Monaco.languages.FoldingContext,
      _token: Monaco.CancellationToken,
    ): Promise<Monaco.languages.FoldingRange[] | undefined> {
      const result = await client.textDocumentFoldingRange({
        textDocument: { uri: model.uri.toString() },
      });

      if (!result) {
        return undefined;
      }

      return result.map((range) => ({
        start: range.startLine + 1,
        end: range.endLine + 1,
        kind: lspToMonacoFoldingRangeKind(monaco, range.kind),
      }));
    },
  };
}
