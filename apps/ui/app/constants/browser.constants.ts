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
export const isOpfsSupported = 'storage' in navigator && 'getDirectory' in navigator.storage;

/**
 * Check if the File System Access API is supported.
 * This API allows the app to read/write files in a user-selected directory
 * on their local filesystem via showDirectoryPicker().
 *
 * Supported in Chrome 86+, Edge 86+, Opera 72+. Not available in Firefox or Safari.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker
 */
export const isFileSystemAccessSupported = isBrowser && 'showDirectoryPicker' in globalThis.window;
