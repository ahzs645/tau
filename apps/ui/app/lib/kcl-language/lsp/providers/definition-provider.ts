/**
 * Monaco definition provider for KCL LSP.
 *
 * Priority order:
 * 1. LSP server (future-proof for when KCL LSP adds definition support)
 * 2. Symbol Service (WASM AST-based, for local and imported symbols)
 *
 * On-demand model loading:
 * When returning a definition for an import path, this provider ensures
 * the target Monaco model exists. This is required for Monaco to show
 * the Cmd+hover underline (Monaco verifies the target exists before
 * displaying the link preview).
 */

import { codeLanguages } from '@taucad/types/constants';
import type * as Monaco from 'monaco-editor';
import type * as LSP from 'vscode-languageserver-protocol';
import type { KclLspClient, LspFileManager } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import type { KclSymbolService } from '#lib/kcl-language/lsp/kcl-symbol-service.js';
import { createKclLogger } from '#lib/kcl-language/lsp/kcl-logs.js';
import { getImportPathAtPosition, isKclFileImport } from '#lib/kcl-language/lsp/utils/import-path-utils.js';
import { monacoToLspPosition, lspToMonacoRange } from '#lib/kcl-language/lsp/utils/position-utils.js';

const log = createKclLogger('Definition Provider');

/** Context for symbol definition lookup */
type SymbolLookupContext = {
  monaco: typeof Monaco;
  symbolService: KclSymbolService;
  client: KclLspClient;
  uri: string;
  word: string;
};

/**
 * Find symbol definition using the symbol service.
 * Extracted to reduce complexity of provideDefinition.
 */
async function findSymbolDefinition(context: SymbolLookupContext): Promise<Monaco.languages.Definition | undefined> {
  const { monaco, symbolService, uri, word } = context;

  try {
    log.debug('Looking up symbol by name:', word, 'in', uri);
    const symbol = symbolService.findSymbolByName(uri, word);
    log.debug('Symbol lookup result:', symbol?.name, 'kind:', symbol?.kind, 'line:', symbol?.lineNumber);

    if (!symbol) {
      return undefined;
    }

    // For imports, resolve to the actual definition in the imported file
    if (symbol.kind === 'import') {
      const importDefinition = await resolveImportDefinition(context);
      if (importDefinition) {
        return importDefinition;
      }
      // If we can't resolve, fall through to return the import location
    }

    // Return local symbol definition (variable, function, parameter)
    log.debug(
      'Symbol service found local definition:',
      symbol.name,
      'kind:',
      symbol.kind,
      'at line:',
      symbol.lineNumber,
    );
    log.debug('Returning definition at:', symbol.uri, 'line:', symbol.lineNumber, 'column:', symbol.column);
    return {
      uri: monaco.Uri.parse(symbol.uri),
      range: new monaco.Range(symbol.lineNumber, symbol.column, symbol.lineNumber, symbol.column + symbol.name.length),
    };
  } catch (error) {
    log.debug('Symbol service definition error (non-fatal):', error);
    return undefined;
  }
}

/**
 * Resolve an import symbol to its definition in the imported file.
 */
async function resolveImportDefinition(context: SymbolLookupContext): Promise<Monaco.languages.Definition | undefined> {
  const { monaco, symbolService, client, uri, word } = context;

  log.debug('Symbol is an import, resolving to actual definition in imported file');
  const fileManager = client.getFileManager();
  log.debug('fileManager available:', Boolean(fileManager));

  if (!fileManager) {
    return undefined;
  }

  try {
    const importedSymbol = await symbolService.resolveImportedSymbol(uri, word, fileManager);
    log.debug('resolveImportedSymbol result:', importedSymbol?.name, 'uri:', importedSymbol?.uri);

    if (!importedSymbol) {
      return undefined;
    }

    const targetUri = monaco.Uri.parse(importedSymbol.uri);
    log.debug('Resolved import to definition:', importedSymbol.name, 'in', importedSymbol.uri);
    log.debug('Target URI:', targetUri.toString(), 'scheme:', targetUri.scheme, 'path:', targetUri.path);
    log.debug('Target position:', importedSymbol.lineNumber, importedSymbol.column);

    return {
      uri: targetUri,
      range: new monaco.Range(
        importedSymbol.lineNumber,
        importedSymbol.column,
        importedSymbol.lineNumber,
        importedSymbol.column + importedSymbol.name.length,
      ),
    };
  } catch (error) {
    log.debug('Error resolving imported symbol (non-fatal):', error);
    return undefined;
  }
}

/** Callback to ensure a Monaco model exists for a path. */
export type GetOrEnsureModel = (path: string) => Promise<Monaco.editor.ITextModel | undefined>;

/**
 * Create a Monaco definition provider that uses the LSP client.
 * Falls back to symbol service when LSP returns null.
 */
// oxlint-disable-next-line max-params -- Factory function with optional provider dependencies
export function createDefinitionProvider(
  monaco: typeof Monaco,
  client: KclLspClient,
  symbolService?: KclSymbolService,
  getOrEnsureModel?: GetOrEnsureModel,
): Monaco.languages.DefinitionProvider {
  return {
    async provideDefinition(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      _token: Monaco.CancellationToken,
    ): Promise<Monaco.languages.Definition | undefined> {
      const uri = model.uri.toString();
      const wordInfo = model.getWordAtPosition(position);
      log.debug('Definition requested at', uri, 'word:', wordInfo?.word);

      // 1. Try LSP first (future-proof - currently returns null)
      // Error Resilience: LSP errors should not prevent symbol service fallback
      try {
        const lspResult = await client.textDocumentDefinition({
          textDocument: { uri },
          position: monacoToLspPosition(position),
        });

        // Check for non-empty result (empty array is truthy but means no definitions)
        const hasResult = lspResult && (!Array.isArray(lspResult) || lspResult.length > 0);
        if (hasResult) {
          log.debug('LSP definition found');
          return convertDefinition(monaco, lspResult);
        }
      } catch (error) {
        log.debug('LSP definition error (falling back to symbol service):', error);
      }

      // ════════════════════════════════════════════════════════════════════════
      // AUGMENTATION: Client-side definition via WASM AST
      // Remove this block when KCL LSP supports textDocument/definition
      // ════════════════════════════════════════════════════════════════════════

      // Check if the word is a quoted import path (e.g., "car-wheel.kcl")
      // The wordPattern includes quoted .kcl strings, so wordInfo.word may contain quotes
      const fileManager = client.getFileManager();

      if (wordInfo) {
        const { word } = wordInfo;
        const quotedPathMatch = /^["'](.+\.kcl)["']$/.exec(word);
        if (quotedPathMatch?.[1]) {
          const importPath = quotedPathMatch[1];
          log.debug('Word is a quoted import path:', importPath);
          const targetUri = resolveImportPathToUri(uri, importPath);
          log.debug('Resolved import path to URI:', targetUri);

          // Ensure target model exists for Monaco to show Cmd+hover underline
          await ensureModelForUri(monaco, targetUri, fileManager, getOrEnsureModel);

          return {
            uri: monaco.Uri.parse(targetUri),
            range: new monaco.Range(1, 1, 1, 1), // Beginning of file
          };
        }
      }

      // Fallback: Check if cursor is inside an import path string (e.g., "car-wheel.kcl")
      // This handles cases where the wordPattern didn't match the full quoted string
      const importPathResult = getImportPathAtPosition(model, position);
      if (importPathResult && isKclFileImport(importPathResult.path)) {
        log.debug('Detected import path string:', importPathResult.path);
        const targetUri = resolveImportPathToUri(uri, importPathResult.path);
        log.debug('Resolved import path to URI:', targetUri);

        // Ensure target model exists for Monaco to show Cmd+hover underline
        await ensureModelForUri(monaco, targetUri, fileManager, getOrEnsureModel);

        return {
          uri: monaco.Uri.parse(targetUri),
          range: new monaco.Range(1, 1, 1, 1), // Beginning of file
        };
      }

      if (!wordInfo) {
        log.debug('No word at position, no definition available');
        return undefined;
      }

      if (!symbolService?.isInitialized) {
        log.debug('Symbol service not initialized');
        return undefined;
      }

      // Error Resilience: Symbol service provides definitions even when LSP fails
      // Symbols may be from last successful parse if current parse failed
      const symbolResult = await findSymbolDefinition({
        monaco,
        symbolService,
        client,
        uri,
        word: wordInfo.word,
      });
      if (symbolResult) {
        return symbolResult;
      }

      log.debug('No definition found');
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

/**
 * Extract the file path from a Monaco URI for file reading.
 * Handles root-level URIs like "file:///main.kcl" → "main.kcl"
 */
function extractFilePathFromUri(uri: string): string {
  // Remove file:// prefix
  let path = uri.replace(/^file:\/\//, '');

  // Strip leading slash from root-level paths
  // URI path: /main.kcl -> main.kcl
  if (path.startsWith('/')) {
    path = path.slice(1);
  }

  return path;
}

/**
 * Ensure a Monaco model exists for the given URI.
 * Delegates to the centralized model service when available, otherwise
 * falls back to direct model creation.
 *
 * This is required for Monaco to show Cmd+hover link underlines.
 */
// oxlint-disable-next-line max-params -- Distinct required dependencies for model resolution
async function ensureModelForUri(
  monaco: typeof Monaco,
  targetUri: string,
  fileManager: LspFileManager | undefined,
  getOrEnsureModelFn?: GetOrEnsureModel,
): Promise<void> {
  // Fast path: model already exists
  const monacoUri = monaco.Uri.parse(targetUri);
  if (monaco.editor.getModel(monacoUri)) {
    return;
  }

  // Use centralized model service if available
  if (getOrEnsureModelFn) {
    const filePath = extractFilePathFromUri(targetUri);
    await getOrEnsureModelFn(filePath);
    return;
  }

  // Fallback: direct model creation (only when model service not yet initialized)
  if (!fileManager) {
    log.debug('No file manager available, cannot create model for:', targetUri);
    return;
  }

  try {
    const filePath = extractFilePathFromUri(targetUri);
    log.debug('Creating model on-demand (fallback) for:', targetUri, '(path:', filePath, ')');

    const content = await fileManager.readFile(filePath);
    const textContent = new TextDecoder().decode(content);

    monaco.editor.createModel(textContent, codeLanguages.kcl, monacoUri);
    log.debug('Model created successfully for:', targetUri);
  } catch (error) {
    log.debug('Failed to create model for:', targetUri, error);
  }
}
