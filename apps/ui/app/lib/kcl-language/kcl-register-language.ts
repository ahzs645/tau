import { codeLanguages } from '@taucad/types/constants';
import type * as Monaco from 'monaco-editor';
import type * as LSP from 'vscode-languageserver-protocol';
import type { Node } from '@taucad/kcl-wasm-lib/bindings/Node';
import type { Program } from '@taucad/kcl-wasm-lib/bindings/Program';
import type { KclValue } from '@taucad/kcl-wasm-lib/bindings/KclValue';
import { KclLspClient } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import type { LspFileManager } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import { createKclLogger } from '#lib/kcl-language/lsp/kcl-logs.js';
import { createDiagnosticsHandler, kclMarkerOwner } from '#lib/kcl-language/lsp/providers/diagnostics-handler.js';
import { createCompletionProvider } from '#lib/kcl-language/lsp/providers/completion-provider.js';
import { createHoverProvider } from '#lib/kcl-language/lsp/providers/hover-provider.js';
import { createSignatureHelpProvider } from '#lib/kcl-language/lsp/providers/signature-provider.js';
import { createFormattingProvider } from '#lib/kcl-language/lsp/providers/formatting-provider.js';
import { createSemanticTokensProvider } from '#lib/kcl-language/lsp/providers/semantic-tokens-provider.js';
import { createFoldingRangeProvider } from '#lib/kcl-language/lsp/providers/folding-provider.js';
import { createRenameProvider } from '#lib/kcl-language/lsp/providers/rename-provider.js';
import { createDefinitionProvider } from '#lib/kcl-language/lsp/providers/definition-provider.js';
import { createCodeActionProvider } from '#lib/kcl-language/lsp/providers/code-action-provider.js';
import { getKclSymbolService } from '#lib/kcl-language/lsp/kcl-symbol-service.js';
import type { KclSymbolService } from '#lib/kcl-language/lsp/kcl-symbol-service.js';
import type { LanguageContribution, ActivationContext, ActivationResult } from '#lib/monaco-language-registry.js';
import type { MonacoMarkerService } from '#lib/monaco-marker-service.js';
import type { GetOrEnsureModel } from '#lib/kcl-language/lsp/providers/definition-provider.js';

const log = createKclLogger('Register');

/** Global LSP client instance */
let lspClient: KclLspClient | undefined;

/** Symbol service instance for WASM-based symbol extraction */
let symbolService: KclSymbolService | undefined;

/** Track if already registered to prevent duplicate registration */
let isRegistered = false;

/** Global marker service reference (injected by activation) */
let globalMarkerService: MonacoMarkerService | undefined;

/** Global getOrEnsureModel callback (injected by activation) */
let globalGetOrEnsureModel: GetOrEnsureModel | undefined;

/** Map of document URIs to their version numbers */
const documentVersions = new Map<string, number>();

/** Disposables for Monaco event subscriptions */
const monacoDisposables: Monaco.IDisposable[] = [];

/** Map of document URIs to their content change disposables */
const contentChangeDisposables = new Map<string, Monaco.IDisposable>();

/**
 * Get the symbol service instance.
 */
export function getSymbolService(): KclSymbolService | undefined {
  return symbolService;
}

/**
 * Get the LSP client instance.
 */
export function getKclLspClient(): KclLspClient | undefined {
  return lspClient;
}

/**
 * Set the file manager for the LSP client.
 * This enables the LSP to read imported files and provide go-to-definition.
 * Also triggers re-processing of already opened documents to resolve their imports.
 */
export function setKclLspFileManager(fileManager: LspFileManager): void {
  log.debug(' setKclLspFileManager called');
  log.debug(' - lspClient exists:', Boolean(lspClient));
  log.debug(' - lspClient ready:', lspClient?.ready);
  log.debug(' - fileManager.exists:', Boolean(fileManager.exists));
  log.debug(' - fileManager.readFile:', Boolean(fileManager.readFile));
  log.debug(' - openedDocuments count:', openedDocuments.size);
  log.debug(' - openedDocuments:', [...openedDocuments]);

  if (lspClient) {
    lspClient.setFileManager(fileManager);
    log.debug(' File manager set on client, triggering import re-processing');

    // Re-process all opened documents to parse and open their imports
    // This handles the case where documents were opened before the file manager was set
    void reprocessOpenedDocumentsForImports();
  } else {
    log.warn('Cannot set file manager - client not initialized');
  }
}

/**
 * Re-process all opened documents to parse and open their imports.
 * This is called when the file manager becomes available after documents are already open.
 */
async function reprocessOpenedDocumentsForImports(): Promise<void> {
  if (!lspClient?.ready) {
    log.debug(' Client not ready, skipping import re-processing');
    return;
  }

  const fileManager = lspClient.getFileManager();
  if (!fileManager) {
    log.debug(' No file manager, skipping import re-processing');
    return;
  }

  const monaco = monacoInstance;
  if (!monaco) {
    log.debug(' No Monaco instance, skipping import re-processing');
    return;
  }

  log.debug(`Re-processing ${openedDocuments.size} opened documents for imports`);

  // Collect all documents to process
  const documentsToProcess: Array<{ uri: string; text: string }> = [];
  for (const uri of openedDocuments) {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model) {
      documentsToProcess.push({ uri, text: model.getValue() });
    }
  }

  // Process all documents in parallel to avoid await-in-loop
  await Promise.all(
    documentsToProcess.map(async ({ uri, text }) => {
      log.debug(`Re-processing imports for: ${uri}`);
      await openImportedFiles(uri, text);
    }),
  );
}

/** Store Monaco instance for re-processing */
let monacoInstance: typeof Monaco | undefined;

/** Set of document URIs that have been opened (to prevent duplicates) */
const openedDocuments = new Set<string>();

/**
 * Notify the LSP server of a document open event.
 * Also scans for imports and opens those files recursively.
 */
export function notifyDocumentOpen(uri: string, text: string): void {
  log.debug(`notifyDocumentOpen called for: ${uri}`);
  log.debug(`- lspClient?.ready: ${lspClient?.ready}`);

  if (!lspClient?.ready) {
    log.debug(`LSP client not ready, skipping notifyDocumentOpen`);
    return;
  }

  // Skip if already opened
  if (openedDocuments.has(uri)) {
    log.debug(`Document already opened, sending didChange instead: ${uri}`);
    // Just send a change notification instead
    notifyDocumentChange(uri, text);
    return;
  }

  log.debug(`Sending textDocument/didOpen for: ${uri} (${text.length} chars)`);
  openedDocuments.add(uri);
  documentVersions.set(uri, 1);
  lspClient.textDocumentDidOpen({
    textDocument: {
      uri,
      languageId: codeLanguages.kcl,
      version: 1,
      text,
    },
  });
  log.debug(`textDocument/didOpen sent for: ${uri}`);

  // Parse imports and open those files
  log.debug(`Now calling openImportedFiles for: ${uri}`);
  void openImportedFiles(uri, text);
}

/**
 * Parse import statements and open the imported files.
 * This enables hover/completion for symbols from imported files.
 *
 * Uses the symbol service (WASM AST) to extract imports - no regex parsing.
 *
 * IMPORTANT: After all imports are opened, we send a didChange notification
 * for the parent file to trigger the LSP to re-process it with the imported
 * files now available in its code_map.
 */
async function openImportedFiles(currentUri: string, text: string): Promise<void> {
  log.debug(' openImportedFiles called for:', currentUri);

  const fileManager = lspClient?.getFileManager();

  const existsFunction = fileManager?.exists;
  if (!existsFunction) {
    log.debug(' No file manager.exists available, skipping import resolution');
    return;
  }

  // Use symbol service to get imports (from WASM AST)
  if (!symbolService?.isInitialized) {
    log.debug(' Symbol service not initialized, skipping import resolution');
    return;
  }

  // Ensure the document is parsed in the symbol service
  const version = documentVersions.get(currentUri) ?? 1;
  await symbolService.updateDocument(currentUri, text, version);

  const imports = symbolService.getImports(currentUri);
  log.debug(' Found', imports.length, 'imports in', currentUri);

  if (imports.length === 0) {
    return;
  }

  // Track if any imports were successfully opened
  let importsOpened = 0;

  // Process imports in parallel
  await Promise.all(
    imports.map(async (importSymbol) => {
      const { importPath } = importSymbol;
      if (!importPath) {
        return;
      }

      const importUri = resolveImportPath(currentUri, importPath);

      // Skip if already opened
      if (openedDocuments.has(importUri)) {
        log.debug(' Import already opened:', importUri);
        return;
      }

      try {
        // Convert URI to path for file manager
        const filePath = uriToPath(importUri);
        log.debug(' Reading import:', filePath);

        // Check if file exists
        try {
          const fileExists = await existsFunction(filePath);
          if (!fileExists) {
            log.debug(' Import file not found:', filePath);
            return;
          }
        } catch (existsError) {
          log.error(`Error checking file exists for ${filePath}:`, existsError);
          // Try to read anyway in case exists failed but read works
        }

        // Read the file
        const data = await fileManager.readFile(filePath);
        const importText = new TextDecoder().decode(data);

        log.debug(' Successfully read import file:', filePath, '(', importText.length, 'chars)');

        // Open the file (this will recursively open its imports too)
        notifyDocumentOpen(importUri, importText);
        importsOpened++;
      } catch (error) {
        log.error(`Failed to open import ${importPath}:`, error);
      }
    }),
  );

  // If any imports were opened, trigger a re-parse of the parent file
  // by sending a didChange notification. This is necessary because the LSP
  // may have already parsed the parent file before the imported files were
  // added to its code_map, causing import resolution to fail.
  if (importsOpened > 0) {
    log.debug(' ', importsOpened, 'imports opened, triggering re-parse of parent file:', currentUri);
    notifyDocumentChange(currentUri, text);
  }
}

// ============================================================================
// Path Utility Functions
// ============================================================================

/**
 * Convert URI to file path.
 * The file manager expects paths without leading slashes (e.g., "public/...")
 * but Monaco URIs use "file:///public/..." format.
 */
function uriToPath(uri: string): string {
  let path = uri;

  // Remove "file://" scheme
  if (path.startsWith('file://')) {
    path = path.slice(7);
  }

  // Remove leading slash - file manager expects "public/..." not "/public/..."
  if (path.startsWith('/')) {
    path = path.slice(1);
  }

  return path;
}

/**
 * Resolve an import path relative to the current file's directory.
 *
 * @param currentFileUri The URI of the current file (e.g., "file:///public/kcl-samples/bench/main.kcl")
 * @param importPath The relative import path (e.g., "bench-parts.kcl")
 * @returns The absolute URI of the imported file
 */
function resolveImportPath(currentFileUri: string, importPath: string): string {
  // Parse the current file URI to get the directory
  // Example: "file:///public/kcl-samples/bench/main.kcl" -> "file:///public/kcl-samples/bench/"
  const lastSlashIndex = currentFileUri.lastIndexOf('/');
  const directory = currentFileUri.slice(0, lastSlashIndex + 1);

  // Join with the import path
  return `${directory}${importPath}`;
}

/**
 * Notify the LSP server of a document change event.
 */
export function notifyDocumentChange(uri: string, text: string): void {
  if (!lspClient?.ready) {
    return;
  }

  const version = (documentVersions.get(uri) ?? 0) + 1;
  documentVersions.set(uri, version);

  lspClient.textDocumentDidChange({
    textDocument: { uri, version },
    contentChanges: [{ text }],
  });
}

/**
 * Notify the LSP server of a document close event.
 */
export function notifyDocumentClose(uri: string): void {
  if (!lspClient?.ready) {
    return;
  }

  openedDocuments.delete(uri);
  documentVersions.delete(uri);
  lspClient.textDocumentDidClose({
    textDocument: { uri },
  });
}

/**
 * Register KCL language with Monaco editor.
 *
 * This provides full language support for KCL files including:
 * - Language identification and configuration
 * - LSP-powered features: completions, hover, diagnostics, formatting, etc.
 *
 * @see https://microsoft.github.io/monaco-editor/playground.html#extending-language-services-custom-languages
 */
export function registerKclLanguage(monaco: typeof Monaco): void {
  // Prevent duplicate registration
  if (isRegistered) {
    log.debug(' Language already registered, skipping');

    return;
  }

  isRegistered = true;
  monacoInstance = monaco; // Store for later use in import re-processing

  // Register language metadata
  monaco.languages.register({
    id: codeLanguages.kcl,
    extensions: ['.kcl'],
    aliases: ['KCL', 'kcl'],
    mimetypes: ['text/x-kcl'],
  });

  // Basic language configuration
  monaco.languages.setLanguageConfiguration(codeLanguages.kcl, {
    comments: {
      lineComment: '//',
      blockComment: ['/*', '*/'],
    },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] },
      { open: "'", close: "'", notIn: ['string', 'comment'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    // Word pattern: matches identifiers and quoted strings (for import paths)
    // This enables Cmd+Click on both symbols and import path strings
    wordPattern: /("[^"]*\.kcl"|'[^']*\.kcl'|[a-zA-Z_]\w*)/,
  });

  // Initialize LSP client and register providers
  void initializeLsp(monaco);
}

/**
 * Initialize the LSP client and register all Monaco providers.
 */
async function initializeLsp(monaco: typeof Monaco): Promise<void> {
  // Create diagnostics handler (uses marker service if available)
  const diagnosticsHandler = createDiagnosticsHandler(monaco, globalMarkerService);

  // Initialize symbol service
  symbolService = getKclSymbolService();

  // Initialize WASM for symbol service (async, non-blocking)
  void initializeSymbolServiceWasm();

  // Create and initialize LSP client
  lspClient = new KclLspClient({
    onInitialized() {
      log.debug(' Client initialized successfully');
    },
    onNotification(notification: LSP.NotificationMessage) {
      diagnosticsHandler(notification);
    },
  });

  try {
    await lspClient.initialize();
  } catch (error) {
    log.error('Failed to initialize client:', error);
    lspClient = undefined;

    return;
  }

  // Wait for the client to be ready
  await lspClient.waitForReady();

  // Register Monaco language providers
  const languageId = codeLanguages.kcl;

  // Completion provider (with symbol service for user-defined completions)
  monaco.languages.registerCompletionItemProvider(
    languageId,
    createCompletionProvider(monaco, lspClient, symbolService),
  );

  // Hover provider (with symbol service for enhanced hover)
  monaco.languages.registerHoverProvider(languageId, createHoverProvider(monaco, lspClient, symbolService));

  // Signature help provider
  monaco.languages.registerSignatureHelpProvider(languageId, createSignatureHelpProvider(monaco, lspClient));

  // Document formatting provider
  monaco.languages.registerDocumentFormattingEditProvider(languageId, createFormattingProvider(monaco, lspClient));

  // Semantic tokens provider
  monaco.languages.registerDocumentSemanticTokensProvider(languageId, createSemanticTokensProvider(monaco, lspClient));

  // Folding range provider
  monaco.languages.registerFoldingRangeProvider(languageId, createFoldingRangeProvider(monaco, lspClient));

  // Rename provider
  monaco.languages.registerRenameProvider(languageId, createRenameProvider(monaco, lspClient));

  // Definition provider (with symbol service for go-to-definition, and model service for on-demand loading)
  monaco.languages.registerDefinitionProvider(
    languageId,
    createDefinitionProvider(monaco, lspClient, symbolService, globalGetOrEnsureModel),
  );

  // Code action provider
  monaco.languages.registerCodeActionProvider(languageId, createCodeActionProvider(monaco, lspClient));

  // Set up document synchronization
  setupDocumentSync(monaco, lspClient);

  log.debug(' All Monaco providers registered');
}

/**
 * Initialize WASM for the symbol service.
 * This loads the KCL WASM module and hooks it up to the symbol service.
 */
async function initializeSymbolServiceWasm(): Promise<void> {
  if (!symbolService) {
    return;
  }

  try {
    // Dynamically import the WASM module, path, and mock connections
    const [wasmModule, wasmPathModule, engineModule] = await Promise.all([
      import('@taucad/kcl-wasm-lib'),
      import('@taucad/kcl-wasm-lib/kcl.wasm?url'),
      import('@taucad/kernels/kernels/zoo/engine-connection'),
    ]);

    // Initialize WASM
    await wasmModule.default(wasmPathModule.default);

    // Set up parse function with error resilience
    // The WASM parser returns [program, errors] even when there are parse errors,
    // but may throw on catastrophic failures (e.g., invalid UTF-8)
    type ParseResultError = { severity: string };
    type ParseResult = [Node<Program>, ParseResultError[]];

    symbolService.setParseFunction(async (code: string) => {
      try {
        const result = wasmModule.parse_wasm(code) as ParseResult;
        const allErrors = result[1];
        const errors = allErrors.filter((error) => error.severity !== 'Warning');
        const warnings = allErrors.filter((warning) => warning.severity === 'Warning');

        // WASM parser returns partial AST even with errors - this is intentional
        // We can extract symbols from the successfully parsed portions
        log.debug('Parse completed with', errors.length, 'errors and', warnings.length, 'warnings');

        return { program: result[0], errors, warnings };
      } catch (error) {
        // Log and re-throw to surface the failure
        log.error('Parse threw exception (catastrophic failure):', error);
        throw error;
      }
    });

    // Set up mock execution function for variable values
    // Create a minimal mock file system that throws on file operations
    // (mock execution for single-file hover/intellisense doesn't need real file access)
    const mockEngine = new engineModule.MockEngineConnection();
    const mockFileSystem = {
      async readFile(): Promise<Uint8Array<ArrayBuffer>> {
        throw new Error('Mock file system does not support file reads');
      },
      exists: async (): Promise<boolean> => false,
      getAllFiles: async (): Promise<string[]> => [],
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable -- WASM Context constructor may return thenable
    const mockContext = (await new wasmModule.Context(mockEngine, mockFileSystem)) as {
      executeMock: (program: string, path: string, settings: string, capture: boolean) => Promise<unknown>;
    };

    type MockExecutionResult = {
      variables: Partial<Record<string, KclValue>>;
      errors: unknown[];
      sourceFiles?: Record<
        string | number,
        { path: { type: 'Main' } | { type: 'Local'; value: string } | { type: 'Std'; value: string }; source: string }
      >;
    };

    // Flag to track if we've processed stdlib
    let stdlibProcessed = false;

    // Capture reference to symbolService for closure (we know it's defined from guard above)
    const service = symbolService;

    service.setMockExecuteFunction(async (program, path) => {
      try {
        const result = (await mockContext.executeMock(
          JSON.stringify(program),
          path,
          '{}',
          false,
        )) as MockExecutionResult;

        // Process stdlib from successful result if available and not already done
        const successSourceFiles = result.sourceFiles;
        if (!stdlibProcessed && successSourceFiles) {
          log.debug('Processing stdlib from successful mock execution...');

          await service.processStdlibSources(successSourceFiles);
          stdlibProcessed = true;
        }

        return { variables: result.variables, errors: result.errors, sourceFiles: result.sourceFiles };
      } catch (error) {
        // Mock execution can throw but still contain partial results
        // The error object may contain sourceFiles which we need for stdlib
        if (error && typeof error === 'object') {
          const errorObject = error as MockExecutionResult;

          // Process stdlib from error result if available and not already done
          const errorSourceFiles = errorObject.sourceFiles;
          if (!stdlibProcessed && errorSourceFiles) {
            log.debug('Processing stdlib from error mock execution...');

            await service.processStdlibSources(errorSourceFiles);
            stdlibProcessed = true;
          }

          // Re-throw with variables and sourceFiles attached for the symbol service to extract
          const errorData = {
            variables: errorObject.variables,
            errors: errorObject.errors,
            sourceFiles: errorObject.sourceFiles,
          };
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- Intentionally throwing data object for symbol service
          throw errorData;
        }

        throw error;
      }
    });

    log.debug(' Symbol service WASM initialized with mock execution');

    // Re-parse any documents that were opened before WASM was ready
    await symbolService.reparseAllDocuments();
  } catch (error) {
    log.warn('Failed to initialize symbol service WASM:', error);
  }
}

/**
 * Set up document synchronization between Monaco models and the LSP server.
 * This follows the same pattern as Monaco's built-in TypeScript language service.
 */
function setupDocumentSync(monaco: typeof Monaco, client: KclLspClient): void {
  const languageId = codeLanguages.kcl;

  // Handle existing models (might be created before LSP was ready)
  const allModels = monaco.editor.getModels();
  log.debug('setupDocumentSync: found', allModels.length, 'models total');
  for (const model of allModels) {
    const modelLanguage = model.getLanguageId();
    log.debug('setupDocumentSync: model', model.uri.toString(), 'language:', modelLanguage);
    if (modelLanguage === languageId) {
      log.debug('setupDocumentSync: syncing KCL model', model.uri.toString());
      syncDocumentOpen(client, model);
    }
  }

  // Handle new models
  const createModelDisposable = monaco.editor.onDidCreateModel((model) => {
    if (model.getLanguageId() === languageId) {
      syncDocumentOpen(client, model);
    }
  });
  monacoDisposables.push(createModelDisposable);

  // Handle model language changes (e.g., file renamed to .kcl)
  const languageChangeDisposable = monaco.editor.onDidChangeModelLanguage((event) => {
    const newLanguage = event.model.getLanguageId();
    if (newLanguage === languageId) {
      syncDocumentOpen(client, event.model);
    } else if (event.oldLanguage === languageId) {
      syncDocumentClose(client, event.model.uri.toString());
    }
  });
  monacoDisposables.push(languageChangeDisposable);

  // Handle model disposal
  const disposeModelDisposable = monaco.editor.onWillDisposeModel((model) => {
    if (model.getLanguageId() === languageId) {
      syncDocumentClose(client, model.uri.toString());
    }
  });
  monacoDisposables.push(disposeModelDisposable);
}

/**
 * Sync a model open event to the LSP server.
 */
function syncDocumentOpen(client: KclLspClient, model: Monaco.editor.ITextModel): void {
  const uri = model.uri.toString();
  const text = model.getValue();

  log.debug('syncDocumentOpen called for:', uri, '(text length:', text.length, ')');
  log.debug('syncDocumentOpen: openedDocuments:', [...openedDocuments]);

  // Skip if already opened (prevents duplicates)
  if (openedDocuments.has(uri)) {
    log.debug('syncDocumentOpen: Document already opened, skipping:', uri);
    return;
  }

  log.debug('syncDocumentOpen: Document NOT in openedDocuments, sending didOpen');
  openedDocuments.add(uri);
  documentVersions.set(uri, 1);
  client.textDocumentDidOpen({
    textDocument: {
      uri,
      languageId: codeLanguages.kcl,
      version: 1,
      text,
    },
  });

  log.debug('syncDocumentOpen: Sent textDocument/didOpen for:', uri);

  // Update symbol service with document content
  if (symbolService) {
    void symbolService.updateDocument(uri, text, 1);
  }

  // Parse imports and open those files to enable hover/intellisense
  void openImportedFiles(uri, text);

  // Listen for content changes on this model
  const contentChangeDisposable = model.onDidChangeContent(() => {
    const version = (documentVersions.get(uri) ?? 0) + 1;
    documentVersions.set(uri, version);
    const newText = model.getValue();

    client.textDocumentDidChange({
      textDocument: { uri, version },
      contentChanges: [{ text: newText }],
    });

    // Update symbol service with new content
    if (symbolService) {
      void symbolService.updateDocument(uri, newText, version);
    }

    // Re-scan for imports on content change (new imports might be added)
    void openImportedFiles(uri, newText);
  });
  contentChangeDisposables.set(uri, contentChangeDisposable);
}

/**
 * Sync a model close event to the LSP server.
 */
function syncDocumentClose(client: KclLspClient, uri: string): void {
  openedDocuments.delete(uri);
  documentVersions.delete(uri);
  client.textDocumentDidClose({
    textDocument: { uri },
  });

  // Clean up content change listener for this document
  const contentDisposable = contentChangeDisposables.get(uri);
  if (contentDisposable) {
    contentDisposable.dispose();
    contentChangeDisposables.delete(uri);
  }

  // Clean up symbol service
  if (symbolService) {
    symbolService.removeDocument(uri);
  }

  log.debug(' Closed document:', uri);
}

/**
 * Dispose of the LSP client and clean up resources.
 */
export function disposeKclLsp(): void {
  // Dispose Monaco event subscriptions
  for (const disposable of monacoDisposables) {
    disposable.dispose();
  }

  monacoDisposables.length = 0;

  // Dispose content change subscriptions
  for (const disposable of contentChangeDisposables.values()) {
    disposable.dispose();
  }

  contentChangeDisposables.clear();

  // Clean up LSP client
  lspClient?.dispose();
  lspClient = undefined;

  // Clean up symbol service
  symbolService?.clear();
  symbolService = undefined;

  // Clear document tracking
  documentVersions.clear();
  openedDocuments.clear();

  // Reset Monaco instance reference
  monacoInstance = undefined;

  // Reset registration flag to allow re-registration
  isRegistered = false;

  // Clear global service references
  globalMarkerService = undefined;
  globalGetOrEnsureModel = undefined;
}

// ============================================================================
// Language Contribution (for LanguageContributionRegistry)
// ============================================================================

/** Provider disposables from activation */
let activationDisposables: Monaco.IDisposable[] = [];

/** Stored marker service reference for cleanup */
let activationMarkerService: ActivationContext['markerService'] | undefined;

/**
 * KCL Language Contribution
 *
 * Conforms to the LanguageContribution interface for uniform lifecycle management.
 * - register: Language metadata and configuration
 * - activate: LSP client, providers, document sync, marker service injection
 * - onBuildSessionChange: Reset document tracking and caches
 * - dispose: Full cleanup including LSP client, workers, markers
 */
export const kclContribution: LanguageContribution = {
  languageId: codeLanguages.kcl,

  register(monaco: typeof Monaco): void {
    registerKclLanguage(monaco);
  },

  activate(context: ActivationContext): ActivationResult {
    const { markerService, modelService } = context;

    activationMarkerService = markerService;

    // Store marker service globally so diagnostics handler can access it
    globalMarkerService = markerService;

    // Set up file manager for KCL LSP import resolution
    setKclLspFileManager({
      readFile: async (path: string) => context.fileManager.readFile(path),
      exists: async (path: string) => context.fileManager.exists(path),
      readdir: async (path: string) => context.fileManager.readdir(path),
    });

    // Navigation handler for KCL files
    const navigationHandler = {
      canHandle(path: string): boolean {
        return path.endsWith('.kcl');
      },
    };

    // The definition provider was already registered during initializeLsp.
    // Store getOrEnsureModel for future definition provider use.
    // Since initializeLsp is async and may complete after activate,
    // the getOrEnsureModel reference is stored module-level.
    globalGetOrEnsureModel = async (path: string): ReturnType<typeof modelService.getOrEnsureModel> =>
      modelService.getOrEnsureModel(path);

    return {
      disposables: activationDisposables,
      navigationHandler,
    };
  },

  onBuildSessionChange(_buildId: string): void {
    // Clear document tracking for new session
    openedDocuments.clear();
    documentVersions.clear();
    symbolService?.clear();
  },

  dispose(): void {
    // Dispose activation-specific disposables
    for (const disposable of activationDisposables) {
      disposable.dispose();
    }

    activationDisposables = [];

    // Full KCL LSP cleanup
    disposeKclLsp();

    // Clear KCL markers via marker service
    activationMarkerService?.clearOwnerEverywhere(kclMarkerOwner);
    activationMarkerService = undefined;
  },
};
