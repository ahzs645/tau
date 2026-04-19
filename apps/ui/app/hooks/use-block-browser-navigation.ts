import { useEffect } from 'react';

const sentinelState = 'navigation-blocked';

/**
 * Prevents browser back/forward navigation (including trackpad swipe gestures)
 * by pushing a sentinel history entry and intercepting popstate events.
 *
 * While active, the back and forward buttons become no-ops.
 * The sentinel entry is cleaned up on unmount.
 */
export const useBlockBrowserNavigation = (): void => {
  useEffect(() => {
    history.pushState(sentinelState, '');

    const onPopState = (): void => {
      history.pushState(sentinelState, '');
    };

    globalThis.addEventListener('popstate', onPopState);

    return () => {
      globalThis.removeEventListener('popstate', onPopState);

      if (history.state === sentinelState) {
        history.back();
      }
    };
  }, []);
};
