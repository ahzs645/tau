import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';

/**
 * Default screenshot quality for chat (0.1 to 1.0).
 */
const defaultScreenshotQuality = 0.3;

type UseImageQualityReturn = {
  readonly quality: number;
  readonly setQuality: (value: number | ((previous: number) => number)) => void;
};

/**
 * Hook to manage the screenshot quality setting for chat.
 * Quality ranges from 0.1 (low quality, small file size) to 1.0 (high quality, larger file size).
 */
export function useImageQuality(): UseImageQualityReturn {
  const [quality, setQuality] = useCookie(cookieName.chatScreenshotQuality, defaultScreenshotQuality);

  return { quality, setQuality };
}
