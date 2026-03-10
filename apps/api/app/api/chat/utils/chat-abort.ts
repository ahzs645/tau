/**
 * Branded abort error and tracking utilities for chat request cancellation.
 *
 * When users cancel chat requests (stop button), LangGraph's internal abort
 * propagation creates fire-and-forget promises in node-fetch that reject with
 * generic AbortError. These utilities provide two layers of identification:
 *
 * 1. **Branded ChatAbortError** — used as the abort reason via
 *    `AbortController.abort(new ChatAbortError(chatId))`, making it accessible
 *    on `signal.reason`. The controller's catch block checks this directly.
 *
 * 2. **Abort tracker** — correlates unhandled AbortError rejections (from
 *    node-fetch's fire-and-forget promises) with known chat cancellations.
 *    Used by the process-level `unhandledRejection` handler where we don't
 *    have access to the original AbortSignal.
 */

/**
 * Module-private brand symbol. Because this is a non-global Symbol (not
 * `Symbol.for()`), it cannot be replicated or forged from outside this module.
 * Only instances created by ChatAbortError's constructor carry this property.
 */
const chatAbortBrand: unique symbol = Symbol('ChatAbortBrand');

/**
 * Branded error used as the abort reason when cancelling chat requests.
 *
 * Pass to `AbortController.abort(new ChatAbortError(chatId))` so the reason
 * is accessible on `signal.reason` for precise identification in catch blocks.
 */
export class ChatAbortError extends Error {
  public get [chatAbortBrand](): true {
    return true;
  }

  public constructor(public readonly chatId: string) {
    super(`Chat ${chatId} was cancelled by client`);
    this.name = 'ChatAbortError';
  }
}

/**
 * Type guard that verifies the runtime brand symbol on the value.
 * Returns true only for instances created by this module's ChatAbortError
 * constructor — structural look-alikes from other modules will fail.
 */
export function isChatAbortError(value: unknown): value is ChatAbortError {
  return typeof value === 'object' && value !== null && chatAbortBrand in value && value[chatAbortBrand] === true;
}

// ---------------------------------------------------------------------------
// Abort Tracking
//
// Correlates unhandled AbortError rejections from node-fetch with genuine
// chat cancellations. The process-level unhandledRejection handler doesn't
// have access to the AbortSignal, so it needs this registry to distinguish
// our aborts from unrelated AbortErrors.
// ---------------------------------------------------------------------------

const trackingWindowMs = 10_000;

const activeChatAborts = new Set<string>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Register that a chat request is about to be aborted.
 *
 * **Must be called BEFORE `AbortController.abort()`** so the tracking is in
 * place when node-fetch's rejection fires (which can happen synchronously
 * during the abort() call).
 *
 * The entry is automatically removed after {@link trackingWindowMs} to
 * prevent unbounded growth.
 */
export function registerChatAbort(chatId: string): void {
  const existingTimer = cleanupTimers.get(chatId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  activeChatAborts.add(chatId);

  const timer = setTimeout(() => {
    activeChatAborts.delete(chatId);
    cleanupTimers.delete(chatId);
  }, trackingWindowMs);

  cleanupTimers.set(chatId, timer);
}

/**
 * Check whether an unhandled rejection is a tracked chat abort error.
 *
 * Returns true only when **both** conditions are met:
 * 1. The error matches the AbortError pattern (`name` or `type` property)
 * 2. At least one chat abort was recently registered via {@link registerChatAbort}
 *
 * This two-condition check prevents accidentally swallowing unrelated
 * AbortErrors from other subsystems.
 */
export function isTrackedAbortError(error: unknown): boolean {
  if (activeChatAborts.size === 0) {
    return false;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'AbortError' || (error as { type?: string }).type === 'aborted';
}

/**
 * Clear all tracking state and pending timers. Call during module/service
 * teardown to prevent timer leaks.
 */
export function clearAbortTracking(): void {
  for (const timer of cleanupTimers.values()) {
    clearTimeout(timer);
  }

  activeChatAborts.clear();
  cleanupTimers.clear();
}
