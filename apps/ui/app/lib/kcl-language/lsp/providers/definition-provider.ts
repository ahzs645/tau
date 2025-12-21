/**
 * Monaco definition provider for KCL LSP.
 *
 * Priority order:
 * 1. LSP server (future-proof for when KCL LSP adds definition support)
 * 2. Symbol Service (WASM AST-based, for local and imported symbols)
 */

import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type * as LSP from 'vscode-languageserver-protocol';
import type { KclLspClient } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import type { KclSymbolService } from '#lib/kcl-language/lsp/kcl-symbol-service.js';
import { createLogger } from '#lib/kcl-language/lsp/kcl-logs.js';
import { monacoToLspPosition, lspToMonacoRange } from '#lib/kcl-language/lsp/utils/position-utils.js';

const log = createLogger('Definition Provider');

/**
 * Create a Monaco definition provider that uses the LSP client.
 * Falls back to symbol service when LSP returns null.
 */
export function createDefinitionProvider(
  monaco: typeof Monaco,
  client: KclLspClient,
  symbolService?: KclSymbolService,
): Monaco.languages.DefinitionProvider {
  return {
    async provideDefinition(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      _token: Monaco.CancellationToken,
    ): Promise<Monaco.languages.Definition | undefined> {
      const uri = model.uri.toString();
      const wordInfo = model.getWordAtPosition(position);
      log('Definition requested at', uri, 'word:', wordInfo?.word);

      // 1. Try LSP first (future-proof - currently returns null)
      const lspResult = await client.textDocumentDefinition({
        textDocument: { uri },
        position: monacoToLspPosition(position),
      });

      if (lspResult) {
        log('LSP definition found');
        return convertDefinition(monaco, lspResult);
      }

      // ════════════════════════════════════════════════════════════════════════
      // AUGMENTATION: Client-side definition via WASM AST
      // Remove this block when KCL LSP supports textDocument/definition
      // ════════════════════════════════════════════════════════════════════════

      // Check if the word is a quoted import path (e.g., "car-wheel.kcl")
      // The wordPattern includes quoted .kcl strings, so wordInfo.word may contain quotes
      if (wordInfo) {
        const { word } = wordInfo;
        const quotedPathMatch = /^["'](.+\.kcl)["']$/.exec(word);
        if (quotedPathMatch?.[1]) {
          const importPath = quotedPathMatch[1];
          log('Word is a quoted import path:', importPath);
          const targetUri = resolveImportPathToUri(uri, importPath);
          log('Resolved import path to URI:', targetUri);
          return {
            uri: monaco.Uri.parse(targetUri),
            range: new monaco.Range(1, 1, 1, 1), // Beginning of file
          };
        }
      }

      // Fallback: Check if cursor is inside an import path string (e.g., "car-wheel.kcl")
      // This handles cases where the wordPattern didn't match the full quoted string
      const importPathResult = getImportPathAtPosition(model, position);
      if (importPathResult) {
        log('Detected import path string:', importPathResult.path);
        const targetUri = resolveImportPathToUri(uri, importPathResult.path);
        log('Resolved import path to URI:', targetUri);
        return {
          uri: monaco.Uri.parse(targetUri),
          range: new monaco.Range(1, 1, 1, 1), // Beginning of file
        };
      }

      if (!wordInfo) {
        log('No word at position, no definition available');
        return undefined;
      }

      if (!symbolService?.isInitialized) {
        log('Symbol service not initialized');
        return undefined;
      }

      // Try local symbol lookup
      log('Looking up symbol by name:', wordInfo.word, 'in', uri);
      const symbol = symbolService.findSymbolByName(uri, wordInfo.word);
      log('Symbol lookup result:', symbol?.name, 'kind:', symbol?.kind, 'line:', symbol?.lineNumber);

      // For imports, resolve to the actual definition in the imported file
      if (symbol?.kind === 'import') {
        log('Symbol is an import, resolving to actual definition in imported file');
        const fileManager = client.getFileManager();
        log('fileManager available:', Boolean(fileManager));
        if (fileManager) {
          const importedSymbol = await symbolService.resolveImportedSymbol(uri, wordInfo.word, fileManager);
          log('resolveImportedSymbol result:', importedSymbol?.name, 'uri:', importedSymbol?.uri);
          if (importedSymbol) {
            const targetUri = monaco.Uri.parse(importedSymbol.uri);
            log('Resolved import to definition:', importedSymbol.name, 'in', importedSymbol.uri);
            log('Target URI:', targetUri.toString(), 'scheme:', targetUri.scheme, 'path:', targetUri.path);
            log('Target position:', importedSymbol.lineNumber, importedSymbol.column);
            return {
              uri: targetUri,
              range: new monaco.Range(
                importedSymbol.lineNumber,
                importedSymbol.column,
                importedSymbol.lineNumber,
                importedSymbol.column + importedSymbol.name.length,
              ),
            };
          }
        }
        // If we can't resolve, fall through to return the import location
      }

      // Return local symbol definition (variable, function, parameter)
      if (symbol) {
        log('Symbol service found local definition:', symbol.name, 'kind:', symbol.kind, 'at line:', symbol.lineNumber);
        log('Returning definition at:', symbol.uri, 'line:', symbol.lineNumber, 'column:', symbol.column);
        return {
          uri: monaco.Uri.parse(symbol.uri),
          range: new monaco.Range(
            symbol.lineNumber,
            symbol.column,
            symbol.lineNumber,
            symbol.column + symbol.name.length,
          ),
        };
      }

      log('No definition found');
      return undefined;
    },
  };
}

/**
 * Convert LSP Definition result to Monaco Definition.
 */
function convertDefinition(
  monaco: typeof Monaco,
  result: LSP.Definition | LSP.DefinitionLink[],
): Monaco.languages.Definition {
  // Handle array of locations or links
  if (Array.isArray(result)) {
    return result.map((item) => {
      // DefinitionLink
      if ('targetUri' in item) {
        return {
          uri: monaco.Uri.parse(item.targetUri),
          range: lspToMonacoRange(monaco, item.targetRange),
        };
      }

      // Location
      return {
        uri: monaco.Uri.parse(item.uri),
        range: lspToMonacoRange(monaco, item.range),
      };
    });
  }

  // Single Location
  return {
    uri: monaco.Uri.parse(result.uri),
    range: lspToMonacoRange(monaco, result.range),
  };
}

/**
 * Check if the cursor is inside an import path string and return the path.
 * Handles patterns like:
 * - import "car-wheel.kcl" as carWheel
 * - import * from "parameters.kcl"
 * - import { foo } from "module.kcl"
 */
function getImportPathAtPosition(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): { path: string; range: { start: number; end: number } } | undefined {
  const lineContent = model.getLineContent(position.lineNumber);
  const { column } = position;

  // Find if cursor is inside a quoted string
  // Look for opening quote before cursor
  let stringStart = -1;
  let quoteChar = '';
  for (let index = column - 2; index >= 0; index--) {
    const char = lineContent[index];
    // Check if it's a quote that's an opening quote (not preceded by backslash)
    if ((char === '"' || char === "'") && (index === 0 || lineContent[index - 1] !== '\\')) {
      stringStart = index;
      quoteChar = char;
      break;
    }
  }

  if (stringStart === -1) {
    return undefined;
  }

  // Find closing quote after cursor
  let stringEnd = -1;
  for (let index = column - 1; index < lineContent.length; index++) {
    const char = lineContent[index];
    if (char === quoteChar && lineContent[index - 1] !== '\\') {
      stringEnd = index;
      break;
    }
  }

  if (stringEnd === -1) {
    return undefined;
  }

  // Extract the string content (without quotes)
  const path = lineContent.slice(stringStart + 1, stringEnd);

  // Check if this looks like a KCL file import
  if (!path.endsWith('.kcl')) {
    return undefined;
  }

  // Check if this line is an import statement
  const trimmedLine = lineContent.trim();
  if (!trimmedLine.startsWith('import ')) {
    return undefined;
  }

  return {
    path,
    range: { start: stringStart, end: stringEnd },
  };
}

/**
 * Resolve an import path relative to the current file's URI.
 */
function resolveImportPathToUri(currentFileUri: string, importPath: string): string {
  // Parse the current file URI to get the directory
  // Example: "file:///public/kcl-samples/bench/main.kcl" -> "file:///public/kcl-samples/bench/"
  const lastSlashIndex = currentFileUri.lastIndexOf('/');
  const directory = currentFileUri.slice(0, lastSlashIndex + 1);

  // Join with the import path
  return `${directory}${importPath}`;
}
