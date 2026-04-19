/**
 * Web Worker that hosts the KCL WASM LSP server.
 *
 * This worker:
 * 1. Loads the WASM module
 * 2. Creates the LSP server configuration
 * 3. Runs the KCL LSP server
 * 4. Routes messages between the main thread and the WASM LSP
 */

import type { JSONRPCRequest, JSONRPCResponse } from 'json-rpc-2.0';
import init, { LspServerConfig, lsp_run_kcl } from '@taucad/kcl-wasm-lib';
import wasmPath from '@taucad/kcl-wasm-lib/kcl.wasm?url';
import { Queue } from '#lib/kcl-language/lsp/codec/queue.js';
import { StreamDemuxer } from '#lib/kcl-language/lsp/codec/stream-demuxer.js';
import { createKclLogger } from '#lib/kcl-language/lsp/kcl-logs.js';
import { lspWorkerEventType, kclWorkerType } from '#lib/kcl-language/lsp/kcl-lsp-types.js';
import type {
  KclLspWorkerOptions,
  LspWorkerEvent,
  FileReadResponse,
  FileExistsResponse,
  FileListResponse,
} from '#lib/kcl-language/lsp/kcl-lsp-types.js';
import { encodeMessage, decodeMessage } from '#lib/kcl-language/lsp/codec/utils.js';

const log = createKclLogger('LSP Worker');

/**
 * FileSystemBridge provides filesystem access to the WASM LSP by
 * forwarding requests to the main thread where the fileManager lives.
 */
type PendingReadRequest = { resolve: (data: Uint8Array<ArrayBuffer>) => void; reject: (error: Error) => void };
type PendingExistsRequest = { resolve: (exists: boolean) => void; reject: (error: Error) => void };
// The inner resolve is called with files[], but it's wrapped in getAllFiles to JSON.stringify
type PendingListRequest = { resolve: (files: string[]) => void; reject: (error: Error) => void };

class FileSystemBridge {
  private nextRequestId = 1;
  private readonly pendingReadRequests = new Map<number, PendingReadRequest>();
  private readonly pendingExistsRequests = new Map<number, PendingExistsRequest>();
  private readonly pendingListRequests = new Map<number, PendingListRequest>();

  /**
   * Called from WASM to read a file.
   */
  public async readFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
    log.debug('FileSystem.readFile called:', path);
    const requestId = this.nextRequestId++;

    return new Promise((resolve, reject) => {
      this.pendingReadRequests.set(requestId, { resolve, reject });

      globalThis.postMessage({
        worker: kclWorkerType,
        eventType: lspWorkerEventType.fileReadRequest,
        eventData: { requestId, path },
      });
    });
  }

  /**
   * Called from WASM to check if a file exists.
   */
  public async exists(path: string): Promise<boolean> {
    log.debug('FileSystem.exists called:', path);
    const requestId = this.nextRequestId++;

    return new Promise((resolve, reject) => {
      this.pendingExistsRequests.set(requestId, { resolve, reject });

      globalThis.postMessage({
        worker: kclWorkerType,
        eventType: lspWorkerEventType.fileExistsRequest,
        eventData: { requestId, path },
      });
    });
  }

  /**
   * Called from WASM to list files in a directory.
   * WASM expects this to return a Promise<string> (JSON stringified array).
   */
  public async getAllFiles(path: string): Promise<string> {
    log.debug('FileSystem.getAllFiles called:', path);
    const requestId = this.nextRequestId++;

    return new Promise((resolve, reject) => {
      this.pendingListRequests.set(requestId, {
        resolve(files: string[]) {
          // WASM expects JSON stringified array
          resolve(JSON.stringify(files));
        },
        reject,
      });

      globalThis.postMessage({
        worker: kclWorkerType,
        eventType: lspWorkerEventType.fileListRequest,
        eventData: { requestId, path },
      });
    });
  }

  /**
   * Handle file read response from main thread.
   */
  public handleFileReadResponse(response: FileReadResponse): void {
    const pending = this.pendingReadRequests.get(response.requestId);
    if (!pending) {
      log.debug('No pending read request for id:', response.requestId);
      return;
    }

    this.pendingReadRequests.delete(response.requestId);

    if (response.error) {
      log.debug('File read error:', response.error);
      pending.reject(new Error(response.error));
    } else if (response.data) {
      log.debug('File read success, bytes:', response.data.length);
      pending.resolve(response.data);
    } else {
      log.debug('File not found');
      // Return empty array for files that don't exist (WASM expects this)
      pending.resolve(new Uint8Array());
    }
  }

  /**
   * Handle file exists response from main thread.
   */
  public handleFileExistsResponse(response: FileExistsResponse): void {
    const pending = this.pendingExistsRequests.get(response.requestId);
    if (!pending) {
      log.debug('No pending exists request for id:', response.requestId);
      return;
    }

    this.pendingExistsRequests.delete(response.requestId);

    if (response.error) {
      log.debug('File exists error:', response.error);
      pending.reject(new Error(response.error));
    } else {
      log.debug('File exists result:', response.exists);
      pending.resolve(response.exists);
    }
  }

  /**
   * Handle file list response from main thread.
   */
  public handleFileListResponse(response: FileListResponse): void {
    const pending = this.pendingListRequests.get(response.requestId);
    if (!pending) {
      log.debug('No pending list request for id:', response.requestId);
      return;
    }

    this.pendingListRequests.delete(response.requestId);

    if (response.error) {
      log.debug('File list error:', response.error);
      pending.reject(new Error(response.error));
    } else {
      log.debug('File list result:', response.files.length, 'files');
      pending.resolve(response.files);
    }
  }
}

const intoServer = new Queue<Uint8Array<ArrayBuffer>>();
const fromServer = new StreamDemuxer();
const fileSystemBridge = new FileSystemBridge();
let isWasmReady = false;

// Initialize wasmReadyPromise and resolveWasmReady at declaration to ensure
// resolveWasmReady is always defined when called (lines 204, 213, 238).
// handleInitEvent will replace these with fresh instances.
let resolveWasmReady: () => void = () => {
  // Placeholder - replaced by handleInitEvent
};

let wasmReadyPromise: Promise<void> = new Promise<void>((resolve) => {
  resolveWasmReady = resolve;
});

async function initializeWasm(wasmUrl: string): Promise<void> {
  log.debug('Fetching WASM from:', wasmUrl);
  const input = await fetch(wasmUrl);
  log.debug('WASM fetch complete, getting buffer...');
  const buffer = await input.arrayBuffer();
  log.debug('Initializing WASM module...');
  await init(buffer);
  log.debug('WASM module initialized successfully');
}

async function runKclLsp(token: string, apiBaseUrl: string): Promise<void> {
  try {
    log.debug('Creating LSP server configuration...');
    log.debug('FileSystemBridge methods:', {
      readFile: typeof fileSystemBridge.readFile,
      exists: typeof fileSystemBridge.exists,
      getAllFiles: typeof fileSystemBridge.getAllFiles,
    });
    const config = new LspServerConfig(intoServer, fromServer, fileSystemBridge);
    log.debug('LspServerConfig created successfully');
    log.debug(
      'Starting KCL LSP server (token:',
      token ? 'provided' : 'empty',
      ', baseUrl:',
      apiBaseUrl || 'empty',
      ')',
    );

    // Signal that WASM is ready before starting the server
    isWasmReady = true;
    resolveWasmReady();
    log.debug('WASM ready signal sent');

    await lsp_run_kcl(config, token, apiBaseUrl);
    log.debug('LSP server exited normally');
  } catch (error) {
    log.error('LSP server error:', error);
    // Even on error, mark as ready so pending requests don't hang forever
    isWasmReady = true;
    resolveWasmReady();
  }
}

async function handleInitEvent(eventData: KclLspWorkerOptions): Promise<void> {
  const { wasmUrl, token, apiBaseUrl } = eventData;
  const actualWasmUrl = wasmUrl || wasmPath;
  log.debug('Init event received, wasmUrl:', actualWasmUrl);

  // Create the ready promise
  wasmReadyPromise = new Promise((resolve) => {
    resolveWasmReady = resolve;
  });

  try {
    await initializeWasm(actualWasmUrl);
    log.debug('WASM module loaded, starting LSP...');
    // Don't await - let it run in background
    void runKclLsp(token, apiBaseUrl);
    // Wait for the LSP to be ready before processing more messages
    await wasmReadyPromise;
    log.debug('LSP initialization complete');
  } catch (error) {
    log.error('Failed to initialize WASM:', error);
    isWasmReady = true;
    resolveWasmReady();
  }
}

async function handleCallEvent(data: Uint8Array<ArrayBuffer>): Promise<void> {
  const json = decodeMessage<JSONRPCRequest>(data);
  log.debug('Call event received:', json.method, 'id:', json.id);

  // Wait for WASM to be ready
  if (!isWasmReady) {
    log.debug('Waiting for WASM to be ready...');
    await wasmReadyPromise;
    log.debug('WASM is ready, processing request');
  }

  // Enqueue the message for the WASM LSP to process
  intoServer.enqueue(data);
  log.debug('Message enqueued for LSP');

  // If this is a request (has an ID), wait for the response
  if (json.id !== null && json.id !== undefined) {
    log.debug('Waiting for response to request id:', json.id);
    try {
      const response = await fromServer.responses.get(json.id);
      log.debug('Got response for id:', json.id, response);
      const encoded = encodeMessage(response as JSONRPCResponse);
      globalThis.postMessage(encoded);
      log.debug('Response sent to client');
    } catch (error) {
      log.error('Error getting response:', error);
      // Send JSON-RPC error response back to client per spec
      const errorResponse: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: json.id,
        error: {
          code: -32_603,
          message: error instanceof Error ? error.message : 'Internal error',
        },
      };
      globalThis.postMessage(encodeMessage(errorResponse));
      log.debug('Error response sent to client');
    }
  }
}

function handleMessage(event: MessageEvent): void {
  const { eventType, eventData } = event.data as LspWorkerEvent;
  log.debug('Message received, type:', eventType);

  switch (eventType) {
    case lspWorkerEventType.init: {
      void handleInitEvent(eventData as KclLspWorkerOptions);
      break;
    }

    case lspWorkerEventType.call: {
      void handleCallEvent(eventData as Uint8Array<ArrayBuffer>);
      break;
    }

    case lspWorkerEventType.fileReadResponse: {
      fileSystemBridge.handleFileReadResponse(eventData as FileReadResponse);
      break;
    }

    case lspWorkerEventType.fileExistsResponse: {
      fileSystemBridge.handleFileExistsResponse(eventData as FileExistsResponse);
      break;
    }

    case lspWorkerEventType.fileListResponse: {
      fileSystemBridge.handleFileListResponse(eventData as FileListResponse);
      break;
    }

    default: {
      log.error('Unknown event type:', eventType);
    }
  }
}

globalThis.addEventListener('message', handleMessage);

async function forwardRequests(): Promise<void> {
  log.debug('Starting request forwarder...');
  for await (const request of fromServer.requests) {
    log.debug('Forwarding request from server:', request);
    const encoded = encodeMessage(request as JSONRPCRequest);
    globalThis.postMessage(encoded);
  }
}

async function forwardNotifications(): Promise<void> {
  log.debug('Starting notification forwarder...');
  for await (const notification of fromServer.notifications) {
    log.debug('Forwarding notification from server:', notification);
    const encoded = encodeMessage(notification as JSONRPCRequest);
    globalThis.postMessage(encoded);
  }
}

// oxlint-disable-next-line unicorn/prefer-top-level-await -- worker context
void forwardRequests();
// oxlint-disable-next-line unicorn/prefer-top-level-await -- worker context
void forwardNotifications();

log.debug('Worker initialized, waiting for messages...');
