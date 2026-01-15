import { createMiddleware } from 'langchain';

/**
 * Middleware that logs messages before each model call.
 *
 * Uses the `wrapModelCall` hook to log the current message state,
 * which is useful for debugging and monitoring the conversation flow.
 */
export const messageLoggingMiddleware = createMiddleware({
  name: 'MessageLogging',

  async wrapModelCall(request, handler) {
    console.log(`Model call with ${request.messages.length} messages:`);

    for (const message of request.messages) {
      console.log(JSON.stringify(message.contentBlocks, null, 2));
    }

    return handler(request);
  },
});
