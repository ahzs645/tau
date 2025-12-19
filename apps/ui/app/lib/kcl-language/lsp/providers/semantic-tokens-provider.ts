/**
 * Monaco semantic tokens provider for KCL LSP.
 */

import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { KclLspClient } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import { semanticTokenTypes, semanticTokenModifiers } from '#lib/kcl-language/lsp/kcl-lsp-types.js';

/**
 * Get the semantic tokens legend for KCL.
 */
export function getSemanticTokensLegend(): Monaco.languages.SemanticTokensLegend {
  return {
    tokenTypes: [...semanticTokenTypes],
    tokenModifiers: [...semanticTokenModifiers],
  };
}

/**
 * Create a Monaco document semantic tokens provider that uses the LSP client.
 */
export function createSemanticTokensProvider(
  _monaco: typeof Monaco,
  client: KclLspClient,
): Monaco.languages.DocumentSemanticTokensProvider {
  return {
    getLegend(): Monaco.languages.SemanticTokensLegend {
      return getSemanticTokensLegend();
    },

    async provideDocumentSemanticTokens(
      model: Monaco.editor.ITextModel,
      // eslint-disable-next-line @typescript-eslint/no-restricted-types -- lastResultId is optional
      _lastResultId: string | null,
      _token: Monaco.CancellationToken,
    ): Promise<Monaco.languages.SemanticTokens | undefined> {
      const result = await client.textDocumentSemanticTokensFull({
        textDocument: { uri: model.uri.toString() },
      });

      if (!result) {
        return undefined;
      }

      return {
        resultId: result.resultId ?? undefined,
        data: new Uint32Array(result.data),
      };
    },

    releaseDocumentSemanticTokens(_resultId: string | undefined): void {
      // Nothing to release
    },
  };
}
