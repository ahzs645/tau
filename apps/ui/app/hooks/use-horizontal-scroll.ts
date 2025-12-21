import type { RefObject } from 'react';
import { useEffect } from 'react';

/**
 * Hook that maps vertical mouse wheel scrolling to horizontal scrolling.
 * Useful for horizontal scroll containers where users expect to scroll with their mouse wheel.
 *
 * @param ref - Ref to the scroll container element
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- React ref object
export function useHorizontalScroll<T extends HTMLElement>(ref: RefObject<T | null>): void {
  useEffect(() => {
    const scrollContainer = ref.current;
    if (!scrollContainer) {
      return;
    }

    const handleWheel = (event: WheelEvent): void => {
      // Only handle vertical scroll when there's horizontal overflow
      if (event.deltaY !== 0 && scrollContainer.scrollWidth > scrollContainer.clientWidth) {
        event.preventDefault();
        scrollContainer.scrollLeft += event.deltaY;
      }
    };

    scrollContainer.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      scrollContainer.removeEventListener('wheel', handleWheel);
    };
  }, [ref]);
}
