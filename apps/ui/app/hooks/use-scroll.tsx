import type { RefObject } from 'react';
import { useEffect, useState, useCallback } from 'react';

export type ScrollToProperties = {
  behavior?: ScrollBehavior;
  // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- required by React
  reference: RefObject<HTMLDivElement | null>;
};

/**
 * Scroll to a reference element.
 * @param root0 - The scroll properties.
 * @param root0.behavior - The behavior of the scroll.
 * @param root0.reference - The reference element to scroll to.
 * @param dependencies - The dependencies of the scroll. Useful when elements are rendered asynchronously to ensure the `isScrolledTo` state is updated when the element is in view.
 *
 * @example
 * ```tsx
 *   const { isScrolledTo } = useScroll(
 *     {
 *       reference: chatEndReference,
 *     },
 *     [hasContent],
 *   );
 *
 *   // Handler to scroll to the end of the chat.
 *   const handleScrollTo = useCallback(() => {
 *     if (containerRef.current) {
 *     containerRef.current.scrollTo({
 *       top: containerRef.current.scrollHeight,
 *       behavior: 'smooth',
 *     });
 *     }
 *   }, [containerRef]);
 * ```
 *
 * @returns The scroll to properties, `{ isScrolledTo: boolean, scrollTo: () => void }`.
 */
// oxlint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- infer type for hooks
export function useScroll({ behavior, reference }: ScrollToProperties, dependencies: readonly unknown[] = []) {
  const [isScrolledTo, setIsScrolledTo] = useState(false);

  const scrollTo = useCallback(() => {
    if (reference.current) {
      // Find the scrollable parent container by traversing up and checking the
      // computed styles for overflow
      // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- the parent element can be null
      let element: HTMLElement | null = reference.current;
      let scrollContainer: HTMLElement | undefined;

      while (element && !scrollContainer) {
        const style = globalThis.getComputedStyle(element);
        if (['auto', 'scroll'].includes(style.overflowY)) {
          scrollContainer = element;
        }

        element = element.parentElement;
      }

      if (scrollContainer) {
        scrollContainer.scrollTo({
          top: scrollContainer.scrollHeight,
          behavior: behavior ?? 'smooth',
        });
      }
    }
  }, [reference, behavior]);

  useEffect(() => {
    const currentReference = reference.current;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsScrolledTo(entry?.isIntersecting ?? false);
      },
      { root: undefined, threshold: 1 },
    );

    if (currentReference) {
      observer.observe(currentReference);
    }

    return () => {
      if (currentReference) {
        observer.unobserve(currentReference);
      }
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- we are accepting that dependencies are not fully known.
  }, [reference, ...dependencies]);

  return {
    isScrolledTo,
    scrollTo,
  };
}
