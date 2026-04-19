import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useFileManager } from '#hooks/use-file-manager.js';

const noop = (): void => {
  /* Intentional no-op when subscribe is unavailable (useSyncExternalStore fallback). */
};

export type FileContentResult = {
  content: Uint8Array<ArrayBuffer> | undefined;
  isOrphaned: boolean;
};

/**
 * Auto-loading hook for file content with orphan tracking.
 * Uses `useSyncExternalStore` for targeted re-renders when content or
 * orphan state changes. Derives `isOrphaned` from `FileContentService`
 * (VS Code `inOrphanMode` pattern).
 *
 * On cache miss, automatically triggers `contentService.resolve()` which
 * reads from the worker and populates the cache, causing a re-render
 * with the loaded content.
 */
export function useFileContent(path: string | undefined): FileContentResult {
  const { contentService } = useFileManager();

  const content = useSyncExternalStore(
    useCallback((callback: () => void) => contentService?.subscribe(path, callback) ?? noop, [contentService, path]),
    useCallback(() => (path ? contentService?.peek(path) : undefined), [contentService, path]),
    () => undefined,
  );

  const isOrphaned = useSyncExternalStore(
    useCallback(
      (callback: () => void) => {
        if (!contentService || !path) {
          return noop;
        }
        return contentService.onDidChangeOrphaned((event) => {
          if (event.path === path) {
            callback();
          }
        });
      },
      [contentService, path],
    ),
    useCallback(() => (path ? (contentService?.isOrphaned(path) ?? false) : false), [contentService, path]),
    () => false,
  );

  useEffect(() => {
    if (path && content === undefined && contentService) {
      void contentService.resolve(path);
    }
  }, [contentService, path, content]);

  return { content, isOrphaned };
}
