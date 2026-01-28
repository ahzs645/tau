/**
 * Monaco folding range provider for KCL LSP.
 */

import type * as Monaco from 'monaco-editor';
import type { KclLspClient } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import { createKclLogger } from '#lib/kcl-language/lsp/kcl-logs.js';
import { lspToMonacoFoldingRangeKind } from '#lib/kcl-language/lsp/utils/lsp-kind-utils.js';

const log = createKclLogger('Folding Provider');

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
      // Error Resilience: LSP errors should not break the editor
      try {
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
      } catch (error) {
        log.debug('Folding range error (non-fatal):', error);
        return undefined;
      }
    },
  };
}
