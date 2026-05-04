/**
 * KCL LSP Client for Monaco Editor.
 *
 * This client:
 * 1. Manages the Web Worker hosting the WASM LSP
 * 2. Provides methods for all LSP requests (hover, completion, etc.)
 * 3. Handles LSP notifications (diagnostics, etc.)
 * 4. Manages document synchronization
 */

import type * as LSP from 'vscode-languageserver-protocol';
import { JSONRPCClient, JSONRPCServer, JSONRPCServerAndClient } from 'json-rpc-2.0';
import type { JSONRPCRequest } from 'json-rpc-2.0';
import { IntoServer } from '#lib/kcl-language/lsp/codec/into-server.js';
import { createFromServer } from '#lib/kcl-language/lsp/codec/from-server.js';
import { createKclLogger } from '#lib/kcl-language/lsp/kcl-logs.js';
import { lspWorkerEventType, kclWorkerType } from '#lib/kcl-language/lsp/kcl-lsp-types.js';
import type { KclLspWorkerOptions, LspWorkerEvent, FileSystemRequest } from '#lib/kcl-language/lsp/kcl-lsp-types.js';
import { encodeMessage } from '#lib/kcl-language/lsp/codec/utils.js';
import { kclUriToWorkspacePath } from '#lib/kcl-language/kcl-register-paths.js';

/**
 * Interface for file manager used to read files.
 */
export type LspFileManager = {
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
  exists?: (path: string) => Promise<boolean>;
  readdir?: (path: string) => Promise<string[]>;
};

const log = createKclLogger('LSP Client');

/**
 * Client capabilities sent during initialization.
 */
const clientCapabilities: LSP.ClientCapabilities = {
  textDocument: {
    hover: { dynamicRegistration: true, contentFormat: ['plaintext', 'markdown'] },
    synchronization: { dynamicRegistration: true, willSave: false, didSave: false, willSaveWaitUntil: false },
    completion: {
      dynamicRegistration: true,
      completionItem: {
        snippetSupport: false,
        commitCharactersSupport: true,
        documentationFormat: ['plaintext', 'markdown'],
        deprecatedSupport: false,
        preselectSupport: false,
      },
      contextSupport: false,
    },
    signatureHelp: {
      dynamicRegistration: true,
      signatureInformation: { documentationFormat: ['plaintext', 'markdown'] },
    },
    declaration: { dynamicRegistration: true, linkSupport: true },
    definition: { dynamicRegistration: true, linkSupport: true },
    typeDefinition: { dynamicRegistration: true, linkSupport: true },
    implementation: { dynamicRegistration: true, linkSupport: true },
    codeAction: { dynamicRegistration: true },
    formatting: { dynamicRegistration: true },
    rename: { dynamicRegistration: true, prepareSupport: true },
    foldingRange: { dynamicRegistration: true },
    semanticTokens: {
      dynamicRegistration: true,
      tokenTypes: [
        'number',
        'variable',
        'keyword',
        'type',
        'string',
        'operator',
        'comment',
        'function',
        'parameter',
        'property',
      ],
      tokenModifiers: ['declaration', 'definition', 'defaultLibrary', 'readonly', 'static'],
      formats: ['relative'],
      requests: { full: true },
    },
    publishDiagnostics: { relatedInformation: true },
  },
  workspace: { didChangeConfiguration: { dynamicRegistration: true } },
};

export type NotificationHandler = (notification: LSP.NotificationMessage) => void;

export type KclLspClientOptions = {
  /** File manager for reading files - required for import resolution */
  fileManager?: LspFileManager;
  /** Callback when the client is initialized */
  onInitialized?: () => void;
  /** Callback for handling notifications (e.g., diagnostics) */
  onNotification?: NotificationHandler;
};

export class KclLspClient {
  // Private fields
  private worker: Worker | undefined;
  private jsonRpcClient: JSONRPCServerAndClient | undefined;
  private intoServer: IntoServer | undefined;
  private fromServer: ReturnType<typeof createFromServer> | undefined;
  private serverCapabilities: LSP.ServerCapabilities = {};
  private readonly notificationHandler: NotificationHandler | undefined;
  private isReady = false;
  private readonly readyPromise: Promise<void>;
  private resolveReady: () => void;
  private readonly options: KclLspClientOptions;
  /**
   * Directory of the document last passed to {@link textDocumentDidOpen} (workspace-relative, no leading slash).
   * WASM FS callbacks use relative import strings; we join them here (modeling-app `FileSystemManager._dir` pattern).
   */
  private currentDocumentDir: string | undefined;
  private readonly knownDocumentDirs = new Set<string>();

  public constructor(options: KclLspClientOptions = {}) {
    this.options = options;
    this.notificationHandler = options.onNotification;
    this.resolveReady = (): void => {
      // Placeholder
    };

    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  public get ready(): boolean {
    return this.isReady;
  }

  public async waitForReady(): Promise<void> {
    return this.readyPromise;
  }

  public getServerCapabilities(): LSP.ServerCapabilities {
    return this.serverCapabilities;
  }

  /**
   * Set the file manager for file system access.
   * This can be called after initialization to enable import resolution.
   */
  public setFileManager(fileManager: LspFileManager): void {
    log.debug('Setting file manager');
    this.options.fileManager = fileManager;
  }

  /**
   * Get the current file manager, if set.
   */
  public getFileManager(): LspFileManager | undefined {
    return this.options.fileManager;
  }

  /**
   * Directory context for WASM-originated relative paths (sibling imports).
   * Call before `textDocument/didOpen` for the same URI so `fileReadRequest` joins resolve correctly.
   */
  public setCurrentDocumentDir(directory: string): void {
    this.currentDocumentDir = directory;
    this.knownDocumentDirs.add(directory);
  }

  public textDocumentDidOpen(parameters: LSP.DidOpenTextDocumentParams): void {
    log.debug(
      'textDocumentDidOpen called for:',
      parameters.textDocument.uri,
      'text length:',
      parameters.textDocument.text.length,
    );
    this.notify('textDocument/didOpen', parameters);
    log.debug('textDocumentDidOpen notification sent');
  }

  public textDocumentDidChange(parameters: LSP.DidChangeTextDocumentParams): void {
    this.notify('textDocument/didChange', parameters);
  }

  public textDocumentDidClose(parameters: LSP.DidCloseTextDocumentParams): void {
    this.notify('textDocument/didClose', parameters);
  }

  public async textDocumentHover(parameters: LSP.HoverParams): Promise<LSP.Hover | undefined> {
    if (!this.serverCapabilities.hoverProvider) {
      return undefined;
    }

    return this.request('textDocument/hover', parameters);
  }

  public async textDocumentCompletion(
    parameters: LSP.CompletionParams,
  ): Promise<LSP.CompletionItem[] | LSP.CompletionList | undefined> {
    log.debug('textDocumentCompletion called for uri:', parameters.textDocument.uri);
    log.debug('textDocumentCompletion position:', JSON.stringify(parameters.position));
    log.debug('textDocumentCompletion capabilities:', this.serverCapabilities.completionProvider);
    if (!this.serverCapabilities.completionProvider) {
      log.debug('No completion provider capability - returning undefined');
      return undefined;
    }

    // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- LSP can return null
    const result = await this.request<LSP.CompletionItem[] | LSP.CompletionList | null>(
      'textDocument/completion',
      parameters,
    );

    log.debug(
      'textDocumentCompletion result type:',
      result === null ? 'null' : Array.isArray(result) ? 'array' : 'object',
    );
    if (result && 'items' in result) {
      log.debug('textDocumentCompletion items count:', result.items.length);
    } else if (Array.isArray(result)) {
      log.debug('textDocumentCompletion array length:', result.length);
    }

    return result ?? undefined;
  }

  public async completionItemResolve(parameters: LSP.CompletionItem): Promise<LSP.CompletionItem> {
    return this.request('completionItem/resolve', parameters);
  }

  public async textDocumentSignatureHelp(parameters: LSP.SignatureHelpParams): Promise<LSP.SignatureHelp | undefined> {
    if (!this.serverCapabilities.signatureHelpProvider) {
      return undefined;
    }

    return this.request('textDocument/signatureHelp', parameters);
  }

  public async textDocumentFormatting(parameters: LSP.DocumentFormattingParams): Promise<LSP.TextEdit[] | undefined> {
    if (!this.serverCapabilities.documentFormattingProvider) {
      return undefined;
    }

    return this.request('textDocument/formatting', parameters);
  }

  public async textDocumentSemanticTokensFull(
    parameters: LSP.SemanticTokensParams,
  ): Promise<LSP.SemanticTokens | undefined> {
    if (!this.serverCapabilities.semanticTokensProvider) {
      return undefined;
    }

    return this.request('textDocument/semanticTokens/full', parameters);
  }

  public async textDocumentFoldingRange(parameters: LSP.FoldingRangeParams): Promise<LSP.FoldingRange[] | undefined> {
    if (!this.serverCapabilities.foldingRangeProvider) {
      return undefined;
    }

    return this.request('textDocument/foldingRange', parameters);
  }

  public async textDocumentRename(parameters: LSP.RenameParams): Promise<LSP.WorkspaceEdit | undefined> {
    if (!this.serverCapabilities.renameProvider) {
      return undefined;
    }

    return this.request('textDocument/rename', parameters);
  }

  public async textDocumentPrepareRename(
    parameters: LSP.PrepareRenameParams,
  ): Promise<LSP.Range | LSP.PrepareRenameResult | undefined> {
    if (!this.serverCapabilities.renameProvider) {
      return undefined;
    }

    return this.request('textDocument/prepareRename', parameters);
  }

  public async textDocumentDefinition(
    parameters: LSP.DefinitionParams,
  ): Promise<LSP.Definition | LSP.DefinitionLink[] | undefined> {
    if (!this.serverCapabilities.definitionProvider) {
      return undefined;
    }

    return this.request('textDocument/definition', parameters);
  }

  public async textDocumentCodeAction(
    parameters: LSP.CodeActionParams,
  ): Promise<Array<LSP.Command | LSP.CodeAction> | undefined> {
    if (!this.serverCapabilities.codeActionProvider) {
      return undefined;
    }

    return this.request('textDocument/codeAction', parameters);
  }

  public async initialize(): Promise<void> {
    log.debug('Creating worker...');
    this.worker = new Worker(new URL('kcl-lsp-worker.ts', import.meta.url), { type: 'module', name: 'kcl-lsp' });
    this.fromServer = createFromServer();
    this.intoServer = new IntoServer(kclWorkerType, this.worker);

    const handleWorkerMessage = (event: MessageEvent): void => {
      // Check if this is a file system request

      if (event.data?.eventType !== undefined) {
        const workerEvent = event.data as LspWorkerEvent;
        log.debug('Received file system request from worker:', workerEvent.eventType);
        void this.handleFileSystemRequest(workerEvent);
        return;
      }

      log.debug('Received LSP message from worker:', event.data);
      this.fromServer?.add(event.data as Uint8Array<ArrayBuffer>);
    };

    this.worker.addEventListener('message', handleWorkerMessage);
    this.worker.addEventListener('error', (error) => {
      log.error('Worker error:', error);
    });

    const sendRequest = async (request: JSONRPCRequest): Promise<void> => {
      log.debug('Sending request:', request.method, 'id:', request.id);
      const encoded = encodeMessage(request);
      this.intoServer?.enqueue(encoded);

      if (request.id !== null && request.id !== undefined) {
        log.debug('Waiting for response to id:', request.id);

        const response = await this.fromServer?.responses.get(request.id);
        log.debug('Got response for id:', request.id, response);
        if (response) {
          // Cast to match json-rpc-2.0 expected type
          this.jsonRpcClient?.client.receive(response as Parameters<typeof this.jsonRpcClient.client.receive>[0]);
        }
      }
    };

    this.jsonRpcClient = new JSONRPCServerAndClient(new JSONRPCServer(), new JSONRPCClient(sendRequest));

    this.jsonRpcClient.addMethod('client/registerCapability', (requestParameters: unknown) => {
      const { registrations } = requestParameters as { registrations: LSP.Registration[] };
      log.debug('Server registering capabilities:', registrations);
      for (const registration of registrations) {
        this.registerServerCapability(registration);
      }
    });

    this.jsonRpcClient.addMethod('client/unregisterCapability', (requestParameters: unknown) => {
      const { unregisterations } = requestParameters as { unregisterations: LSP.Unregistration[] };
      log.debug('Server unregistering capabilities:', unregisterations);
      for (const unregistration of unregisterations) {
        this.unregisterServerCapability(unregistration);
      }
    });

    this.jsonRpcClient.addMethod('window/logMessage', (requestParameters: unknown) => {
      const { type, message } = requestParameters as { type: LSP.MessageType; message: string };
      const prefix = ['', '[error]', '[warn]', '[info]', '[log]'][type] ?? '[log]';
      log.debug(`[LSP Server] ${prefix} ${message}`);
    });

    const initOptions: KclLspWorkerOptions = { wasmUrl: '', token: '', apiBaseUrl: '' };
    log.debug('Posting Init event to worker');
    this.worker.postMessage({ worker: kclWorkerType, eventType: lspWorkerEventType.init, eventData: initOptions });

    void this.processNotifications();
    void this.processRequests();

    log.debug('Starting LSP initialization...');
    await this.initializeLsp();
    log.debug('LSP initialization complete');
  }

  public dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.jsonRpcClient = undefined;
    this.isReady = false;
    this.currentDocumentDir = undefined;
    this.knownDocumentDirs.clear();
  }

  private orderedDocumentDirsForJoin(): string[] {
    const ordered: string[] = [];
    if (this.currentDocumentDir !== undefined) {
      ordered.push(this.currentDocumentDir);
    }
    for (const knownDirectory of this.knownDocumentDirs) {
      if (!ordered.includes(knownDirectory)) {
        ordered.push(knownDirectory);
      }
    }
    return ordered;
  }

  private joinDirectoryAndRelativePath(directory: string, relativePath: string): string {
    const trimmedDirectory = directory.replace(/\/$/, '');
    if (trimmedDirectory === '') {
      return relativePath;
    }
    return `${trimmedDirectory}/${relativePath}`;
  }

  /**
   * Map a path string from the WASM bridge to workspace paths to try in order.
   */
  private resolveBridgePathCandidates(rawPath: string): string[] {
    if (rawPath.startsWith('file://')) {
      return [kclUriToWorkspacePath(rawPath)];
    }
    if (rawPath.startsWith('/')) {
      return [rawPath.slice(1)];
    }
    const directories = this.orderedDocumentDirsForJoin();
    if (directories.length === 0) {
      return [rawPath];
    }
    return directories.map((directory) => this.joinDirectoryAndRelativePath(directory, rawPath));
  }

  /**
   * Try candidates in order; used so we short-circuit on first successful read (not parallel).
   */
  private async readFileFirstSuccessfulCandidate(
    fileManager: LspFileManager,
    candidates: string[],
  ): Promise<{ ok: true; data: Uint8Array<ArrayBuffer> } | { ok: false; lastErrorMessage: string | undefined }> {
    if (candidates.length === 0) {
      return { ok: false, lastErrorMessage: undefined };
    }
    const head = candidates[0];
    const tail = candidates.slice(1);
    if (head === undefined) {
      return { ok: false, lastErrorMessage: undefined };
    }
    try {
      const data = await fileManager.readFile(head);
      return { ok: true, data };
    } catch (error) {
      const thisError = error instanceof Error ? error.message : String(error);
      const rest = await this.readFileFirstSuccessfulCandidate(fileManager, tail);
      if (rest.ok) {
        return rest;
      }
      return { ok: false, lastErrorMessage: rest.lastErrorMessage ?? thisError };
    }
  }

  private async pathExistsFirstSuccessfulCandidate(
    exists: (path: string) => Promise<boolean>,
    candidates: string[],
  ): Promise<boolean> {
    if (candidates.length === 0) {
      return false;
    }
    const head = candidates[0];
    const tail = candidates.slice(1);
    if (head === undefined) {
      return false;
    }
    if (await exists(head)) {
      return true;
    }
    return this.pathExistsFirstSuccessfulCandidate(exists, tail);
  }

  private async readdirFirstSuccessfulCandidate(
    fileManager: LspFileManager,
    candidates: string[],
  ): Promise<{ ok: true; files: string[] } | { ok: false; lastErrorMessage: string | undefined }> {
    const { readdir } = fileManager;
    if (readdir === undefined) {
      return { ok: false, lastErrorMessage: undefined };
    }
    if (candidates.length === 0) {
      return { ok: false, lastErrorMessage: undefined };
    }
    const head = candidates[0];
    const tail = candidates.slice(1);
    if (head === undefined) {
      return { ok: false, lastErrorMessage: undefined };
    }
    try {
      const files = await readdir.call(fileManager, head);
      return { ok: true, files };
    } catch (error) {
      const thisError = error instanceof Error ? error.message : String(error);
      const rest = await this.readdirFirstSuccessfulCandidate(fileManager, tail);
      if (rest.ok) {
        return rest;
      }
      return { ok: false, lastErrorMessage: rest.lastErrorMessage ?? thisError };
    }
  }

  private async request<T>(method: string, parameters: unknown): Promise<T> {
    if (!this.jsonRpcClient) {
      throw new Error('LSP client not initialized');
    }

    return this.jsonRpcClient.request(method, parameters) as Promise<T>;
  }

  private notify(method: string, parameters: unknown): void {
    if (!this.jsonRpcClient) {
      throw new Error('LSP client not initialized');
    }

    this.jsonRpcClient.notify(method, parameters);
  }

  private async initializeLsp(): Promise<void> {
    const initializeParameters: LSP.InitializeParams = {
      processId: null,
      clientInfo: { name: 'monaco-kcl-lsp', version: '1.0.0' },
      capabilities: clientCapabilities,
      rootUri: null,
      workspaceFolders: null,
    };

    log.debug('Sending initialize request...');
    const result = await this.request<LSP.InitializeResult>('initialize', initializeParameters);
    log.debug('Initialize response received:', result);
    this.serverCapabilities = result.capabilities;
    log.debug('Server capabilities:', this.serverCapabilities);
    this.notify('initialized', {});
    this.isReady = true;
    this.resolveReady();
    this.options.onInitialized?.();
    log.debug('Client fully initialized');
  }

  private async processNotifications(): Promise<void> {
    if (!this.fromServer) {
      return;
    }

    for await (const notification of this.fromServer.notifications) {
      this.notificationHandler?.(notification);
    }
  }

  private async processRequests(): Promise<void> {
    if (!this.fromServer || !this.jsonRpcClient) {
      return;
    }

    for await (const request of this.fromServer.requests) {
      await this.jsonRpcClient.receiveAndSend(request);
    }
  }

  private registerServerCapability(registration: LSP.Registration): void {
    log.debug('Registered capability:', registration.method);
  }

  private unregisterServerCapability(unregistration: LSP.Unregistration): void {
    log.debug('Unregistered capability:', unregistration.method);
  }

  private async handleFileSystemRequest(event: LspWorkerEvent): Promise<void> {
    const { eventType, eventData } = event;

    switch (eventType) {
      case lspWorkerEventType.fileReadRequest: {
        const request = eventData as FileSystemRequest;
        await this.handleFileReadRequest(request);
        break;
      }

      case lspWorkerEventType.fileExistsRequest: {
        const request = eventData as FileSystemRequest;
        await this.handleFileExistsRequest(request);
        break;
      }

      case lspWorkerEventType.fileListRequest: {
        const request = eventData as FileSystemRequest;
        await this.handleFileListRequest(request);
        break;
      }

      default: {
        // Not a file system request - ignore
        break;
      }
    }
  }

  private async handleFileReadRequest(request: FileSystemRequest): Promise<void> {
    log.debug('Handling file read request:', request.path);
    const { fileManager } = this.options;

    if (!fileManager) {
      log.debug('No file manager available, returning empty');
      this.worker?.postMessage({
        worker: kclWorkerType,
        eventType: lspWorkerEventType.fileReadResponse,
        eventData: { requestId: request.requestId, data: undefined, error: 'No file manager available' },
      });
      return;
    }

    const candidates = this.resolveBridgePathCandidates(request.path);
    const readResult = await this.readFileFirstSuccessfulCandidate(fileManager, candidates);
    if (readResult.ok) {
      log.debug('File read success, bytes:', readResult.data.length);
      this.worker?.postMessage({
        worker: kclWorkerType,
        eventType: lspWorkerEventType.fileReadResponse,
        eventData: { requestId: request.requestId, data: readResult.data },
      });
      return;
    }

    this.worker?.postMessage({
      worker: kclWorkerType,
      eventType: lspWorkerEventType.fileReadResponse,
      eventData: {
        requestId: request.requestId,
        data: undefined,
        error: readResult.lastErrorMessage ?? 'File read failed for all path candidates',
      },
    });
  }

  private async handleFileExistsRequest(request: FileSystemRequest): Promise<void> {
    log.debug('Handling file exists request:', request.path);
    const { fileManager } = this.options;
    const candidates = this.resolveBridgePathCandidates(request.path);

    if (!fileManager) {
      this.worker?.postMessage({
        worker: kclWorkerType,
        eventType: lspWorkerEventType.fileExistsResponse,
        eventData: { requestId: request.requestId, exists: false },
      });
      return;
    }

    const existsFunction = fileManager.exists;
    if (existsFunction !== undefined) {
      try {
        const anyExists = await this.pathExistsFirstSuccessfulCandidate(
          async (path) => existsFunction(path),
          candidates,
        );
        log.debug('File exists result:', anyExists);
        this.worker?.postMessage({
          worker: kclWorkerType,
          eventType: lspWorkerEventType.fileExistsResponse,
          eventData: { requestId: request.requestId, exists: anyExists },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.debug('File exists error:', request.path, errorMessage);
        this.worker?.postMessage({
          worker: kclWorkerType,
          eventType: lspWorkerEventType.fileExistsResponse,
          eventData: { requestId: request.requestId, exists: false, error: errorMessage },
        });
      }
      return;
    }

    const readResult = await this.readFileFirstSuccessfulCandidate(fileManager, candidates);
    this.worker?.postMessage({
      worker: kclWorkerType,
      eventType: lspWorkerEventType.fileExistsResponse,
      eventData: { requestId: request.requestId, exists: readResult.ok },
    });
  }

  private async handleFileListRequest(request: FileSystemRequest): Promise<void> {
    log.debug('Handling file list request:', request.path);
    const { fileManager } = this.options;
    const candidates = this.resolveBridgePathCandidates(request.path);

    if (!fileManager?.readdir) {
      log.debug('No readdir available, returning empty array');
      this.worker?.postMessage({
        worker: kclWorkerType,
        eventType: lspWorkerEventType.fileListResponse,
        eventData: { requestId: request.requestId, files: [] },
      });
      return;
    }

    const listResult = await this.readdirFirstSuccessfulCandidate(fileManager, candidates);
    if (listResult.ok) {
      log.debug('File list success:', listResult.files.length, 'files');
      this.worker?.postMessage({
        worker: kclWorkerType,
        eventType: lspWorkerEventType.fileListResponse,
        eventData: { requestId: request.requestId, files: listResult.files },
      });
      return;
    }

    this.worker?.postMessage({
      worker: kclWorkerType,
      eventType: lspWorkerEventType.fileListResponse,
      eventData: {
        requestId: request.requestId,
        files: [],
        error: listResult.lastErrorMessage ?? 'File list failed for all path candidates',
      },
    });
  }
}
