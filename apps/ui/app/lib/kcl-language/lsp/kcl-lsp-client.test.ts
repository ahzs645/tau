/**
 * KclLspClient protocol and lifecycle tests.
 *
 * Uses a thin generic mock Worker that responds to any JSON-RPC request
 * with a valid response. No method-specific logic — we test the client's
 * protocol handling, not the server's behavior. Actual LSP feature
 * correctness is validated by the integration test (kcl-lsp-integration.test.ts)
 * which runs the real KCL WASM.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JSONRPCRequest } from 'json-rpc-2.0';
import { KclLspClient } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import { lspWorkerEventType } from '#lib/kcl-language/lsp/kcl-lsp-types.js';
import type { LspWorkerEvent, KclLspWorkerOptions } from '#lib/kcl-language/lsp/kcl-lsp-types.js';
import { addHeaders } from '#lib/kcl-language/lsp/codec/headers.js';
import { decodeMessage } from '#lib/kcl-language/lsp/codec/utils.js';

// =============================================================================
// Thin generic mock Worker
// =============================================================================

type MessageListener = (event: MessageEvent) => void;
type ErrorListener = (event: ErrorEvent) => void;

/**
 * Generic mock Worker that responds to any JSON-RPC request with a valid
 * response. Only the `initialize` method gets a special response (with
 * capabilities) because the client requires it to complete setup.
 * All other methods get `{ result: {} }`.
 */
class GenericMockWorker {
  public postMessageCalls: unknown[] = [];
  public terminated = false;

  private messageListeners: MessageListener[] = [];
  private errorListeners: ErrorListener[] = [];

  public addEventListener(type: string, listener: MessageListener | ErrorListener): void {
    if (type === 'message') {
      this.messageListeners.push(listener as MessageListener);
    } else if (type === 'error') {
      this.errorListeners.push(listener as ErrorListener);
    }
  }

  public removeEventListener(type: string, listener: MessageListener | ErrorListener): void {
    if (type === 'message') {
      this.messageListeners = this.messageListeners.filter((l) => l !== listener);
    } else if (type === 'error') {
      this.errorListeners = this.errorListeners.filter((l) => l !== listener);
    }
  }

  public postMessage(data: unknown): void {
    this.postMessageCalls.push(data);

    const event = data as LspWorkerEvent;
    if (event.eventType === lspWorkerEventType.init) {
      return;
    }

    if (event.eventType === lspWorkerEventType.call) {
      this.respondToMessage(event.eventData as Uint8Array<ArrayBuffer>);
    }
  }

  public terminate(): void {
    this.terminated = true;
  }

  private respondToMessage(data: Uint8Array<ArrayBuffer>): void {
    const request = decodeMessage<JSONRPCRequest>(data);

    // Only respond to requests (with id), not notifications
    if (request.id === null || request.id === undefined) {
      return;
    }

    // `initialize` needs capabilities so the client can complete setup
    const result =
      request.method === 'initialize'
        ? {
            capabilities: { hoverProvider: true, completionProvider: {} },
            serverInfo: { name: 'mock', version: '0.0.1' },
          }
        : {};

    const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
    const encoded = new TextEncoder().encode(addHeaders(response));

    queueMicrotask(() => {
      for (const listener of this.messageListeners) {
        listener(new MessageEvent('message', { data: encoded }));
      }
    });
  }
}

// =============================================================================
// Stub the Worker constructor
// =============================================================================

let mockWorker: GenericMockWorker;

beforeEach(() => {
  mockWorker = new GenericMockWorker();

  vi.stubGlobal(
    'Worker',
    new Proxy(GenericMockWorker, {
      construct() {
        return mockWorker;
      },
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// =============================================================================
// Tests — protocol and lifecycle only
// =============================================================================

describe('KclLspClient', () => {
  describe('initialization', () => {
    it('should initialize and become ready', async () => {
      const client = new KclLspClient();
      expect(client.ready).toBe(false);

      await client.initialize();
      await client.waitForReady();

      expect(client.ready).toBe(true);
    });

    it('should send init event with correct options to worker', async () => {
      const client = new KclLspClient();
      await client.initialize();

      const initCall = mockWorker.postMessageCalls.find(
        (call) => (call as LspWorkerEvent).eventType === lspWorkerEventType.init,
      ) as LspWorkerEvent | undefined;

      expect(initCall).toBeDefined();
      const options = initCall!.eventData as KclLspWorkerOptions;
      expect(options).toHaveProperty('wasmUrl');
      expect(options).toHaveProperty('token');
      expect(options).toHaveProperty('apiBaseUrl');
    });

    it('should populate server capabilities after initialization', async () => {
      const client = new KclLspClient();
      await client.initialize();

      const capabilities = client.getServerCapabilities();
      expect(capabilities.hoverProvider).toBe(true);
    });

    it('should call onInitialized callback', async () => {
      const onInitialized = vi.fn();
      const client = new KclLspClient({ onInitialized });
      await client.initialize();

      expect(onInitialized).toHaveBeenCalledOnce();
    });
  });

  describe('request/response protocol', () => {
    it('should send a request and receive a response without error', async () => {
      const client = new KclLspClient();
      await client.initialize();

      const result = await client.textDocumentHover({
        textDocument: { uri: 'file:///test.kcl' },
        position: { line: 0, character: 0 },
      });

      expect(result).toBeDefined();
    });

    it('should serialize requests as LSP call events', async () => {
      const client = new KclLspClient();
      await client.initialize();

      const callCountBefore = mockWorker.postMessageCalls.filter(
        (call) => (call as LspWorkerEvent).eventType === lspWorkerEventType.call,
      ).length;

      await client.textDocumentHover({
        textDocument: { uri: 'file:///test.kcl' },
        position: { line: 0, character: 0 },
      });

      const callCountAfter = mockWorker.postMessageCalls.filter(
        (call) => (call as LspWorkerEvent).eventType === lspWorkerEventType.call,
      ).length;

      expect(callCountAfter).toBeGreaterThan(callCountBefore);
    });
  });

  describe('notifications', () => {
    it('should send didOpen notification to worker', async () => {
      const client = new KclLspClient();
      await client.initialize();

      const callCountBefore = mockWorker.postMessageCalls.filter(
        (call) => (call as LspWorkerEvent).eventType === lspWorkerEventType.call,
      ).length;

      client.textDocumentDidOpen({
        textDocument: {
          uri: 'file:///test.kcl',
          languageId: 'kcl',
          version: 1,
          text: 'const x = 1',
        },
      });

      const callCountAfter = mockWorker.postMessageCalls.filter(
        (call) => (call as LspWorkerEvent).eventType === lspWorkerEventType.call,
      ).length;

      expect(callCountAfter).toBeGreaterThan(callCountBefore);
    });

    it('should send didChange notification to worker', async () => {
      const client = new KclLspClient();
      await client.initialize();

      const callCountBefore = mockWorker.postMessageCalls.filter(
        (call) => (call as LspWorkerEvent).eventType === lspWorkerEventType.call,
      ).length;

      client.textDocumentDidChange({
        textDocument: { uri: 'file:///test.kcl', version: 2 },
        contentChanges: [{ text: 'const y = 2' }],
      });

      const callCountAfter = mockWorker.postMessageCalls.filter(
        (call) => (call as LspWorkerEvent).eventType === lspWorkerEventType.call,
      ).length;

      expect(callCountAfter).toBeGreaterThan(callCountBefore);
    });

    it('should send didClose notification to worker', async () => {
      const client = new KclLspClient();
      await client.initialize();

      const callCountBefore = mockWorker.postMessageCalls.filter(
        (call) => (call as LspWorkerEvent).eventType === lspWorkerEventType.call,
      ).length;

      client.textDocumentDidClose({
        textDocument: { uri: 'file:///test.kcl' },
      });

      const callCountAfter = mockWorker.postMessageCalls.filter(
        (call) => (call as LspWorkerEvent).eventType === lspWorkerEventType.call,
      ).length;

      expect(callCountAfter).toBeGreaterThan(callCountBefore);
    });
  });

  describe('file system forwarding', () => {
    it('should accept and update file manager', async () => {
      const readFile = vi.fn().mockResolvedValue(new Uint8Array([104, 105]));
      const client = new KclLspClient({ fileManager: { readFile } });
      await client.initialize();

      expect(client.getFileManager()?.readFile).toBe(readFile);

      const newReadFile = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
      client.setFileManager({ readFile: newReadFile });
      expect(client.getFileManager()?.readFile).toBe(newReadFile);
    });
  });

  describe('dispose', () => {
    it('should terminate the worker and clear ready state', async () => {
      const client = new KclLspClient();
      await client.initialize();
      expect(client.ready).toBe(true);

      client.dispose();
      expect(mockWorker.terminated).toBe(true);
      expect(client.ready).toBe(false);
    });

    it('should reject requests after dispose', async () => {
      const client = new KclLspClient();
      await client.initialize();
      client.dispose();

      await expect(
        client.textDocumentHover({
          textDocument: { uri: 'file:///test.kcl' },
          position: { line: 0, character: 0 },
        }),
      ).rejects.toThrow();
    });
  });
});
