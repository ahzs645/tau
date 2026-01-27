/**
 * Stream demultiplexer for LSP messages.
 * Separates incoming messages into responses, notifications, and requests.
 * Implements WritableStream for WASM compatibility.
 */

import type { Message, NotificationMessage, RequestMessage, ResponseMessage } from 'vscode-languageserver-protocol';
import { Queue } from '#lib/kcl-language/lsp/codec/queue.js';
import { PromiseMap } from '#lib/kcl-language/lsp/codec/promise-map.js';
import { decodeBytes } from '#lib/kcl-language/lsp/codec/bytes.js';
import { parseMessages } from '#lib/kcl-language/lsp/codec/headers.js';
import { createKclLogger } from '#lib/kcl-language/lsp/kcl-logs.js';

const log = createKclLogger('StreamDemuxer');

/**
 * Type guard functions for JSON-RPC message types.
 */
function isResponse(message: Message): message is ResponseMessage {
  return 'id' in message && ('result' in message || 'error' in message);
}

function isNotification(message: Message): message is NotificationMessage {
  return 'method' in message && !('id' in message);
}

function isRequest(message: Message): message is RequestMessage {
  return 'method' in message && 'id' in message;
}

/**
 * Demultiplexes incoming LSP messages into separate queues for
 * responses, notifications, and requests.
 * Implements WritableStream for WASM LSP compatibility.
 */
export class StreamDemuxer implements WritableStream<Uint8Array<ArrayBuffer>> {
  public readonly responses = new PromiseMap<number | string, ResponseMessage>();
  public readonly notifications = new Queue<NotificationMessage>();
  public readonly requests = new Queue<RequestMessage>();

  private readonly stream: WritableStream<Uint8Array<ArrayBuffer>>;

  public constructor() {
    log.debug('Creating StreamDemuxer');
    // Store reference to add method for use in stream
    const addMessage = (chunk: Uint8Array<ArrayBuffer>): void => {
      log.debug('WritableStream.write called with chunk length:', chunk.length);
      this.add(chunk);
    };

    // Create a WritableStream that processes incoming messages
    this.stream = new WritableStream<Uint8Array<ArrayBuffer>>({
      write(chunk: Uint8Array<ArrayBuffer>): void {
        addMessage(chunk);
      },
    });
  }

  /**
   * Add raw bytes (from WASM WritableStream) to the appropriate queues.
   * Handles multiple LSP messages concatenated in a single write.
   */
  public add(bytes: Uint8Array<ArrayBuffer>): void {
    log.debug('add() called with bytes length:', bytes.length);

    // Decode bytes to string and parse all LSP messages
    const data = decodeBytes(bytes);
    const jsonMessages = parseMessages(data);

    log.debug('Parsed', jsonMessages.length, 'messages from buffer');

    for (const jsonString of jsonMessages) {
      try {
        const message = JSON.parse(jsonString) as Message;
        log.debug('Decoded message:', message);
        this.routeMessage(message);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error('Failed to parse JSON:', errorMessage);
        log.error('JSON string (first 200):', jsonString.slice(0, 200));
      }
    }
  }

  // WritableStream interface implementation
  public get locked(): boolean {
    return this.stream.locked;
  }

  public async abort(reason?: unknown): Promise<void> {
    return this.stream.abort(reason);
  }

  public async close(): Promise<void> {
    return this.stream.close();
  }

  public getWriter(): WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>> {
    return this.stream.getWriter();
  }

  /**
   * Route a decoded message to the appropriate queue.
   */
  private routeMessage(message: Message): void {
    if (isResponse(message)) {
      log.debug('Message is a Response, id:', message.id);
      const responseId = message.id as string | number | undefined;

      if (typeof responseId === 'string' || typeof responseId === 'number') {
        log.debug('Setting response for id:', responseId);
        this.responses.set(responseId, message);
      }
    }

    if (isNotification(message)) {
      log.debug('Message is a Notification, method:', message.method);
      this.notifications.enqueue(message);
    }

    if (isRequest(message)) {
      log.debug('Message is a Request, method:', message.method, 'id:', message.id);
      this.requests.enqueue(message);
    }
  }
}
