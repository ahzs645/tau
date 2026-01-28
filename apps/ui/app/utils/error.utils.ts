import { errorCategory, errorCategories } from '@taucad/types/constants';
import type { ErrorCategory, ChatError } from '@taucad/types';
import { errorCategoryTitles } from '@taucad/chat/utils';

/**
 * Checks if error is a client-side network error (never reaches the API).
 */
function isNetworkError(message: string): boolean {
  return (
    message.includes('Failed to fetch') ||
    message.includes('NetworkError') ||
    message.includes('net::ERR_') ||
    message.includes('Load failed')
  );
}

/**
 * Parses a ChatError from JSON.
 * The API always sends errors in ChatError format, so we just parse and validate.
 */
function tryParseChatError(message: string): ChatError | undefined {
  if (!message.startsWith('{')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;

    // Validate required fields
    if (
      typeof parsed['category'] === 'string' &&
      typeof parsed['title'] === 'string' &&
      typeof parsed['message'] === 'string'
    ) {
      // Validate category against known values, fallback to generic if unknown
      const parsedCategory = parsed['category'];
      const category: ErrorCategory = errorCategories.includes(parsedCategory as ErrorCategory)
        ? (parsedCategory as ErrorCategory)
        : errorCategory.generic;

      return {
        category,
        title: parsed['title'],
        message: parsed['message'],
        code: typeof parsed['code'] === 'string' ? parsed['code'] : undefined,
        httpStatus: typeof parsed['httpStatus'] === 'number' ? parsed['httpStatus'] : undefined,
        raw: typeof parsed['raw'] === 'string' ? parsed['raw'] : undefined,
        requestId: typeof parsed['requestId'] === 'string' ? parsed['requestId'] : undefined,
        helpUrl: typeof parsed['helpUrl'] === 'string' ? parsed['helpUrl'] : undefined,
      };
    }
  } catch {
    // Not valid JSON
  }

  return undefined;
}

/**
 * Parses an Error object into a ChatError for persistence.
 * This is used to store errors in the chat entity so they survive page reloads.
 *
 * The API always sends errors in ChatError format, so this function just:
 * 1. Handles client-side network errors (which never reach the API)
 * 2. Parses the structured ChatError from the API response
 * 3. Falls back to a generic error for unexpected formats
 */
export function parseErrorForPersistence(error: Error): ChatError {
  // Handle client-side network errors (these never reach the API)
  if (isNetworkError(error.message)) {
    return {
      category: errorCategory.network,
      title: errorCategoryTitles[errorCategory.network],
      message: 'Unable to connect to the server. Please check your internet connection.',
      raw: error.message,
    };
  }

  // Parse structured ChatError from API
  const parsed = tryParseChatError(error.message);
  if (parsed) {
    return parsed;
  }

  // Fallback for unexpected formats
  return {
    category: errorCategory.generic,
    title: errorCategoryTitles[errorCategory.generic],
    message: error.message,
    raw: error.message,
  };
}
