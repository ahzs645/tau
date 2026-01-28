import { IndexedDbStorageProvider } from '#db/indexeddb-storage.js';
import { isBrowser } from '#constants/browser.constants.js';
import { ensureGitMountConfigured, fs } from '#filesystem/zenfs-config.js';

/**
 * Ensure git filesystem is configured before performing operations.
 * Uses the centralized ZenFS configuration from zenfs-config.ts.
 */
export async function ensureGitFsConfigured(): Promise<void> {
  if (!isBrowser) {
    return;
  }

  await ensureGitMountConfigured();
}

/**
 * Git filesystem mount point.
 * All git operations should use paths under this mount.
 */

/**
 * ZenFS instance for git filesystem operations.
 * Uses IndexedDB backend in browser, undefined during SSR.
 *
 * Note: isomorphic-git expects a Node.js-compatible fs interface,
 * which ZenFS provides. Call ensureGitFsConfigured() before using.
 * Git files are stored under the /git mount point.
 */
export const gitFs = isBrowser ? fs : undefined;

// IndexedDB storage for build metadata and domain data
export const storage = new IndexedDbStorageProvider();
