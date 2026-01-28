import { createMiddleware } from 'langchain';

const isLoggingEnabled = false;

const logMessage = (message: string) => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Logging is disabled by default
  if (!isLoggingEnabled) {
    return;
  }

  console.log(message);
};

/**
 * Middleware that logs messages before each model call.
 *
 * Uses the `wrapModelCall` hook to log the current message state,
 * which is useful for debugging and monitoring the conversation flow.
 */
export const messageLoggingMiddleware = createMiddleware({
  name: 'MessageLogging',

  async wrapModelCall(request, handler) {
    logMessage(`Model call with ${request.messages.length} messages:`);

    for (const message of request.messages) {
      logMessage(JSON.stringify(message.contentBlocks, null, 2));
    }

    return handler(request);
  },
});
