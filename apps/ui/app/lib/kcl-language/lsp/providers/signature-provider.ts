/**
 * Monaco signature help provider for KCL LSP.
 */

import type * as Monaco from 'monaco-editor';
import type { KclLspClient } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import { createKclLogger } from '#lib/kcl-language/lsp/kcl-logs.js';
import { monacoToLspPosition } from '#lib/kcl-language/lsp/utils/position-utils.js';
import { formatDocumentation } from '#lib/kcl-language/lsp/utils/lsp-kind-utils.js';

const log = createKclLogger('Signature Provider');

/**
 * Create a Monaco signature help provider that uses the LSP client.
 */
export function createSignatureHelpProvider(
  _monaco: typeof Monaco,
  client: KclLspClient,
): Monaco.languages.SignatureHelpProvider {
  return {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],

    async provideSignatureHelp(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      _token: Monaco.CancellationToken,
      _context: Monaco.languages.SignatureHelpContext,
    ): Promise<Monaco.languages.SignatureHelpResult | undefined> {
      // Error Resilience: LSP errors should not break the editor
      try {
        const result = await client.textDocumentSignatureHelp({
          textDocument: { uri: model.uri.toString() },
          position: monacoToLspPosition(position),
        });

        if (!result) {
          return undefined;
        }

        return {
          value: {
            signatures: result.signatures.map((signature) => ({
              label: signature.label,
              documentation: formatDocumentation(signature.documentation),
              parameters:
                signature.parameters?.map((parameter) => ({
                  label: parameter.label,
                  documentation: formatDocumentation(parameter.documentation),
                })) ?? [],
            })),
            activeSignature: result.activeSignature ?? 0,
            activeParameter: result.activeParameter ?? 0,
          },
          dispose() {
            // Empty dispose
          },
        };
      } catch (error) {
        log.debug('Signature help error (non-fatal):', error);
        return undefined;
      }
    },
  };
}
