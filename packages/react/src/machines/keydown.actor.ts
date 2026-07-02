import { fromCallback } from 'xstate';

/**
 * Keydown Listener Actor
 * Listens to keyboard events and sends back key state changes
 */
export const keydownListener = fromCallback<
  { type: 'keyStateChanged'; key: string; isPressed: boolean },
  { key: string }
>(({ sendBack, input }) => {
  const { key } = input;

  // Track current key state to avoid redundant events
  let isPressed = false;

  /**
   * Handle keydown events
   */
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === key && !isPressed) {
      isPressed = true;
      sendBack({
        type: 'keyStateChanged',
        key,
        isPressed: true,
      });
    }
  };

  /**
   * Handle keyup events
   */
  const handleKeyUp = (event: KeyboardEvent): void => {
    if (event.key === key && isPressed) {
      isPressed = false;
      sendBack({
        type: 'keyStateChanged',
        key,
        isPressed: false,
      });
    }
  };

  /**
   * Handle blur: reset key state when window loses focus (fixes stuck keys on alt-tab).
   */
  const handleBlur = (): void => {
    if (isPressed) {
      isPressed = false;
      sendBack({ type: 'keyStateChanged', key, isPressed: false });
    }
  };

  /**
   * Handle visibility change: reset key state when tab becomes hidden.
   */
  const handleVisibilityChange = (): void => {
    if (document.hidden && isPressed) {
      isPressed = false;
      sendBack({ type: 'keyStateChanged', key, isPressed: false });
    }
  };

  // Add event listeners
  globalThis.addEventListener('keydown', handleKeyDown);
  globalThis.addEventListener('keyup', handleKeyUp);
  globalThis.addEventListener('blur', handleBlur);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Cleanup function - remove listeners when actor stops
  return () => {
    globalThis.removeEventListener('keydown', handleKeyDown);
    globalThis.removeEventListener('keyup', handleKeyUp);
    globalThis.removeEventListener('blur', handleBlur);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
});
