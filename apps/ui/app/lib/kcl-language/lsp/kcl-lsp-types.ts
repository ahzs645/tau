/**
 * Shared types for KCL LSP communication.
 */

/**
 * Worker event types for LSP communication.
 */
export const lspWorkerEventType = {
  init: 'init',
  call: 'call',
  fileReadRequest: 'fileReadRequest',
  fileReadResponse: 'fileReadResponse',
  fileExistsRequest: 'fileExistsRequest',
  fileExistsResponse: 'fileExistsResponse',
  fileListRequest: 'fileListRequest',
  fileListResponse: 'fileListResponse',
} as const;

export type LspWorkerEventType = (typeof lspWorkerEventType)[keyof typeof lspWorkerEventType];

/**
 * Worker type identifier.
 */
export const kclWorkerType = 'kcl-lsp';

/**
 * Options for initializing the KCL LSP worker.
 */
export type KclLspWorkerOptions = {
  /** URL to the WASM file */
  wasmUrl: string;
  /** Authentication token (empty for offline mode) */
  token: string;
  /** API base URL (empty for offline mode) */
  apiBaseUrl: string;
};

/**
 * File system request sent from worker to client.
 */
export type FileSystemRequest = {
  requestId: number;
  path: string;
};

/**
 * File read response sent from client to worker.
 */
export type FileReadResponse = {
  requestId: number;
  data: Uint8Array<ArrayBuffer> | undefined;
  error?: string;
};

/**
 * File exists response sent from client to worker.
 */
export type FileExistsResponse = {
  requestId: number;
  exists: boolean;
  error?: string;
};

/**
 * File list response sent from client to worker.
 */
export type FileListResponse = {
  requestId: number;
  files: string[];
  error?: string;
};

/**
 * Event sent to/from the LSP worker.
 */
export type LspWorkerEvent = {
  worker: string;
  eventType: LspWorkerEventType;
  eventData:
    | Uint8Array<ArrayBuffer>
    | KclLspWorkerOptions
    | FileSystemRequest
    | FileReadResponse
    | FileExistsResponse
    | FileListResponse;
};

/**
 * Semantic token types supported by the KCL LSP.
 * Must match the order in the server's SemanticTokensLegend.
 */
export const semanticTokenTypes = [
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
] as const;

/**
 * Semantic token modifiers supported by the KCL LSP.
 */
export const semanticTokenModifiers = ['declaration', 'definition', 'defaultLibrary', 'readonly', 'static'] as const;
