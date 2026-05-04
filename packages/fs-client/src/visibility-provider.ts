/**
 * Tab visibility contract for services that throttle polling when hidden.
 *
 * @public
 * @example <caption>DOM-backed visibility (browser)</caption>
 * ```typescript
 * import { createDomVisibilityProvider } from '@taucad/fs-client/visibility-provider';
 * export function exampleScheduleWhenVisible(scheduleFastPoll: () => void): void {
 *   const visibility = createDomVisibilityProvider();
 *   if (visibility.isVisible()) {
 *     scheduleFastPoll();
 *   }
 * }
 * ```
 */
export type VisibilityProvider = {
  isVisible(): boolean;
  onVisibilityChange(callback: () => void): () => void;
};

/**
 * Always-visible provider for unit tests and non-browser hosts.
 *
 * @public
 * @example <caption>Headless hosts always treat the tab as visible</caption>
 * ```typescript
 * import { headlessVisibilityProvider } from '@taucad/fs-client/visibility-provider';
 * export function exampleHeadlessVisible(): boolean {
 *   return headlessVisibilityProvider.isVisible();
 * }
 * ```
 */
export const headlessVisibilityProvider: VisibilityProvider = {
  isVisible: () => true,
  onVisibilityChange: () => () => undefined,
};

/**
 * Browser implementation backed by `document.visibilityState` and
 * `visibilitychange`.
 *
 * @returns A {@link VisibilityProvider} wired to the current `document`, when present.
 * @public
 */
export function createDomVisibilityProvider(): VisibilityProvider {
  const callbacks = new Set<() => void>();
  const onDocumentVisibilityChange = (): void => {
    const subscribers = [...callbacks];
    for (const callback of subscribers) {
      callback();
    }
  };
  return {
    isVisible: () => (typeof document === 'undefined' ? true : document.visibilityState === 'visible'),
    onVisibilityChange(callback: () => void): () => void {
      const isFirst = callbacks.size === 0;
      callbacks.add(callback);
      if (isFirst && typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onDocumentVisibilityChange);
      }
      return () => {
        callbacks.delete(callback);
        if (callbacks.size === 0 && typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onDocumentVisibilityChange);
        }
      };
    },
  };
}
