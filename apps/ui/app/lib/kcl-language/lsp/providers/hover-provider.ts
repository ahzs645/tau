/**
 * Monaco hover provider for KCL LSP.
 *
 * Priority order:
 * 1. LSP server (stdlib functions, future-proof for when LSP adds user-defined support)
 * 2. Symbol Service (WASM AST-based, for user-defined symbols)
 */

import type * as Monaco from 'monaco-editor';
import type { KclLspClient, LspFileManager } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import type { KclSymbolService, KclSymbol } from '#lib/kcl-language/lsp/kcl-symbol-service.js';
import { formatSymbolHover } from '#lib/kcl-language/lsp/kcl-symbol-service.js';
import { createKclLogger } from '#lib/kcl-language/lsp/kcl-logs.js';
import { monacoToLspPosition, lspToMonacoRange } from '#lib/kcl-language/lsp/utils/position-utils.js';
import { formatDocumentation } from '#lib/kcl-language/lsp/utils/lsp-kind-utils.js';

const log = createKclLogger('Hover Provider');

/**
 * Resolve an import symbol to its actual definition in the imported file.
 * Returns the resolved symbol with its hover lines, or undefined if resolution fails.
 */
async function resolveImportSymbolHover(
  symbolService: KclSymbolService,
  uri: string,
  importSymbol: KclSymbol,
  fileManager: LspFileManager | undefined,
): Promise<string[] | undefined> {
  log.debug('resolveImportSymbolHover called:', {
    symbolName: importSymbol.name,
    importPath: importSymbol.importPath,
    hasFileManager: Boolean(fileManager),
  });

  if (!fileManager) {
    log.debug('resolveImportSymbolHover: no fileManager, returning undefined');
    return undefined;
  }

  const importedSymbol = await symbolService.resolveImportedSymbol(uri, importSymbol.name, fileManager);
  log.debug('resolveImportSymbolHover: resolveImportedSymbol returned:', importedSymbol?.name, importedSymbol?.kind);

  if (!importedSymbol) {
    log.debug('resolveImportSymbolHover: no imported symbol found, returning undefined');
    return undefined;
  }

  log.debug('Resolved import to actual definition:', importedSymbol.name, 'kind:', importedSymbol.kind);
  const hoverLines = formatSymbolHover(importedSymbol);

  // Add "from" reference to show it's imported
  if (importSymbol.importPath) {
    hoverLines.push(`*from* \`"${importSymbol.importPath}"\``);
  }

  return hoverLines;
}

/**
 * Create a Monaco hover provider that uses the LSP client.
 * Falls back to symbol service when LSP returns null.
 */
export function createHoverProvider(
  monaco: typeof Monaco,
  client: KclLspClient,
  symbolService?: KclSymbolService,
): Monaco.languages.HoverProvider {
  return {
    async provideHover(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      _token: Monaco.CancellationToken,
    ): Promise<Monaco.languages.Hover | undefined> {
      const uri = model.uri.toString();
      const lspPosition = monacoToLspPosition(position);
      log.debug('Hover requested at', uri, 'line:', lspPosition.line, 'character:', lspPosition.character);

      // Get the word at the hover position
      const wordInfo = model.getWordAtPosition(position);
      if (wordInfo) {
        log.debug('Word at position:', wordInfo.word);
      }

      // 1. Try LSP first (stdlib functions, future-proof)
      const lspResult = await client.textDocumentHover({
        textDocument: { uri },
        position: lspPosition,
      });

      log.debug('LSP hover result:', lspResult);

      if (lspResult) {
        const contents = convertHoverContents(lspResult.contents);
        return {
          contents,
          range: lspResult.range ? lspToMonacoRange(monaco, lspResult.range) : undefined,
        };
      }

      // ════════════════════════════════════════════════════════════════════════
      // AUGMENTATION: Client-side symbol lookup via WASM AST
      // Remove this block when KCL LSP provides hover for user-defined symbols
      // ════════════════════════════════════════════════════════════════════════

      if (!wordInfo || !symbolService?.isInitialized) {
        log.debug('No word at position or symbol service not initialized:', {
          hasWordInfo: Boolean(wordInfo),
          isInitialized: symbolService?.isInitialized,
        });
        return undefined;
      }

      const wordRange = new monaco.Range(
        position.lineNumber,
        wordInfo.startColumn,
        position.lineNumber,
        wordInfo.endColumn,
      );

      // Debug: log available symbols
      const allSymbols = symbolService.getSymbols(uri);
      log.debug('Symbol service has', allSymbols.length, 'symbols for', uri);
      if (allSymbols.length > 0) {
        log.debug('Available symbols:', allSymbols.map((s) => `${s.name}(${s.kind})`).join(', '));
      }

      const symbol = symbolService.getDefinitionForUsage(uri, position.lineNumber, position.column, wordInfo.word);
      if (!symbol) {
        log.debug('No symbol found for word:', wordInfo.word);
        return undefined;
      }

      log.debug('Symbol service found local symbol:', symbol.name, 'kind:', symbol.kind);

      // For imports, resolve to the actual definition in the imported file
      if (symbol.kind === 'import') {
        const resolvedHover = await resolveImportSymbolHover(symbolService, uri, symbol, client.getFileManager());
        if (resolvedHover) {
          return {
            contents: resolvedHover.map((line) => ({ value: line })),
            range: wordRange,
          };
        }
        // Fallback: if we can't resolve, show the import symbol below
      }

      const hoverLines = formatSymbolHover(symbol);
      return {
        contents: hoverLines.map((line) => ({ value: line })),
        range: wordRange,
      };
    },
  };
}

/**
 * Convert LSP hover contents to Monaco markdown strings.
 */
function convertHoverContents(
  contents:
    | string
    | { language: string; value: string }
    | { kind: string; value: string }
    | Array<string | { language: string; value: string }>,
): Monaco.IMarkdownString[] {
  if (typeof contents === 'string') {
    return [{ value: contents }];
  }

  if (Array.isArray(contents)) {
    return contents.map((content) => {
      if (typeof content === 'string') {
        return { value: content };
      }

      return { value: `\`\`\`${content.language}\n${content.value}\n\`\`\`` };
    });
  }

  // MarkedString with language
  if ('language' in contents) {
    return [{ value: `\`\`\`${contents.language}\n${contents.value}\n\`\`\`` }];
  }

  // MarkupContent
  if ('kind' in contents) {
    const formatted = formatDocumentation(contents as { kind: 'markdown' | 'plaintext'; value: string });

    return formatted ? [typeof formatted === 'string' ? { value: formatted } : formatted] : [];
  }

  return [];
}
