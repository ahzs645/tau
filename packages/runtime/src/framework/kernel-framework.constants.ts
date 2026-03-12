/**
 * Centralized configuration constants for the kernel framework.
 *
 * All timing, debounce, timeout, polling, and buffer-size constants live here
 * so they can be adjusted in a single place.
 */

/** Debounce delay (ms) for parameter-change re-renders. */
export const parameterDebounceMs = 50;

/** Debounce delay (ms) for file-change re-renders. */
export const fileChangeDebounceMs = 500;

/** Debounce delay (ms) for flushing batched worker logs to the main thread. */
export const logFlushDebounceMs = 250;

/** Timeout (ms) for a single MessagePort bridge call before it is rejected. */
export const messagePortCallTimeoutMs = 30_000;

/** Polling interval (ms) used when `Atomics.waitAsync` is unavailable. Matches one frame at 60 fps. */
export const waitAsyncPollIntervalMs = 16;

/** Byte length of the SharedArrayBuffer signal channel (4 Int32 slots x 4 bytes). */
export const signalBufferByteLength = 16;

/** Maximum byte length the growable SharedArrayBuffer can expand to. */
export const signalBufferMaxByteLength = 64;
