import { fs, configure } from '@zenfs/core';
import { IndexedDB } from '@zenfs/dom';
import { IndexedDbStorageProvider } from '#db/indexeddb-storage.js';
import { isBrowser } from '#constants/browser.constants.js';
import { metaConfig } from '#constants/meta.constants.js';

/**
 * Track git filesystem configuration state.
 */
let gitFsConfigured = false;
let gitFsConfigPromise: Promise<void> | undefined;

/**
 * Configure ZenFS for git operations.
 * This should be called before using gitFs.
 * Uses a separate IndexedDB store to isolate git data.
 */
export async function configureGitFs(): Promise<void> {
  if (!isBrowser) {
    return;
  }

  if (gitFsConfigured && gitFsConfigPromise) {
    return gitFsConfigPromise;
  }

  gitFsConfigPromise = (async (): Promise<void> => {
    await configure({
      mounts: {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- ZenFS uses '/' as mount point key
        '/': { backend: IndexedDB, storeName: `${metaConfig.databasePrefix}fs-git` },
      },
    });
    gitFsConfigured = true;
  })();

  return gitFsConfigPromise;
}

/**
 * Ensure git filesystem is configured before performing operations.
 */
export async function ensureGitFsConfigured(): Promise<void> {
  // eslint-disable-next-line unicorn/prefer-ternary -- better readability
  if (gitFsConfigPromise) {
    await gitFsConfigPromise;
  } else {
    await configureGitFs();
  }
}

/**
 * ZenFS instance for git filesystem operations.
 * Uses IndexedDB backend in browser, undefined during SSR.
 *
 * Note: isomorphic-git expects a Node.js-compatible fs interface,
 * which ZenFS provides. Call ensureGitFsConfigured() before using.
 */
export const gitFs = isBrowser ? fs : undefined;

// IndexedDB storage for build metadata and domain data
export const storage = new IndexedDbStorageProvider();
