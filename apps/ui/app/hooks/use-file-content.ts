import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useFileManager } from '#hooks/use-file-manager.js';
import type { FileContentResult } from '#lib/file-content-service.js';

const noop = (): void => {
  /* Intentional no-op when subscribe is unavailable (useSyncExternalStore fallback). */
};

const loadingResult: FileContentResult = { kind: 'loading' };

/**
 * Auto-loading hook for file content with a discriminated outcome.
 *
 * The render layer routes on `result.kind` (`loading` / `text` / `binary` /
 * `too-large` / `orphaned` / `error`) instead of guessing intent from the
 * presence or absence of cached bytes. The decision lives inside the read
 * pipeline, not in the editor.
 *
 * On cache miss the hook triggers `contentService.resolve()` once; the
 * service publishes the resulting outcome through its outcome channel so
 * the next render picks it up via `useSyncExternalStore`.
 */
export function useFileContent(path: string | undefined): FileContentResult {
  const { contentService } = useFileManager();

  const result = useSyncExternalStore(
    useCallback((callback: () => void) => contentService?.subscribe(path, callback) ?? noop, [contentService, path]),
    useCallback(() => {
      if (!path || !contentService) {
        return loadingResult;
      }
      return contentService.peekOutcome(path);
    }, [contentService, path]),
    () => loadingResult,
  );

  useEffect(() => {
    if (path && contentService && result.kind === 'loading') {
      void contentService.resolve(path);
    }
  }, [contentService, path, result.kind]);

  return result;
}
