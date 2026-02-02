// Check if we're in a browser environment
// eslint-disable-next-line unicorn/no-typeof-undefined -- window can be undefined during SSR
export const isBrowser = typeof globalThis.window !== 'undefined';

/**
 * Check if OPFS (Origin Private File System) is supported.
 * OPFS is available in modern browsers via navigator.storage.getDirectory().
 *
 * Enabled in dev mode due to localhost SSL exception for OPFS.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory
 */
export const isOpfsSupported =
  import.meta.env.DEV || (isBrowser && typeof globalThis.navigator.storage.getDirectory === 'function');
