/**
 * KernelTransport -- low-level, event-driven communication interface.
 *
 * The transport is the true primitive of the kernel architecture.
 * It maps cleanly to any communication channel: MessagePort, WebSocket, HTTP, native FFI.
 * Most consumers use KernelClient instead; transport is for custom channel authors.
 */

import type { KernelCommand, KernelResponse } from '#types/kernel-protocol.types.js';

/**
 * Low-level transport interface for kernel command/response messaging.
 * Portable across MessagePort, WebSocket, HTTP, and native FFI channels.
 */
export type KernelTransport = {
  /**
   * Send a command to the kernel worker.
   *
   * @param message - The kernel command to send
   * @param transferables - Optional transferable objects (e.g., MessagePort, ArrayBuffer)
   */
  send(message: KernelCommand, transferables?: Transferable[]): void;

  /**
   * Register a handler for incoming kernel responses.
   *
   * @param handler - Callback invoked for each response from the worker
   */
  onMessage(handler: (message: KernelResponse) => void): void;

  /**
   * Close the transport and release resources.
   */
  close(): void;
};
