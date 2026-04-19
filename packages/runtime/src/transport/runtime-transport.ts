/**
 * RuntimeTransport -- low-level, event-driven communication interface.
 *
 * The transport is the true primitive of the kernel architecture.
 * It maps cleanly to any communication channel: MessagePort, WebSocket, HTTP, native FFI.
 * Most consumers use RuntimeClient instead; transport is for custom channel authors.
 */

import type { RuntimeCommand, RuntimeResponse } from '#types/runtime-protocol.types.js';

/**
 * Low-level transport interface for kernel command/response messaging.
 * Portable across MessagePort, WebSocket, HTTP, and native FFI channels.
 * @public
 */
export type RuntimeTransport = {
  /**
   * Send a command to the runtime worker.
   *
   * @param message - The kernel command to send
   * @param transferables - Optional transferable objects (e.g., MessagePort, ArrayBuffer)
   */
  send(message: RuntimeCommand, transferables?: Transferable[]): void;

  /**
   * Register a handler for incoming kernel responses.
   *
   * @param handler - Callback invoked for each response from the worker
   */
  onMessage(handler: (message: RuntimeResponse) => void): void;

  /**
   * Close the transport and release resources.
   */
  close(): void;
};
