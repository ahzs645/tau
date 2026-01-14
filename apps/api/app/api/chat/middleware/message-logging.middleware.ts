import { createMiddleware } from 'langchain';

/**
 * Middleware that logs messages before each model call.
 *
 * Uses the `beforeModel` hook to log the current message state,
 * which is useful for debugging and monitoring the conversation flow.
 */
export const messageLoggingMiddleware = createMiddleware({
  name: 'MessageLogging',

  beforeModel(state) {
    console.log(`Model call with ${state.messages.length} messages:`);

    for (const message of state.messages) {
      console.log(JSON.stringify(message.content, null, 2));
    }
  },
});
