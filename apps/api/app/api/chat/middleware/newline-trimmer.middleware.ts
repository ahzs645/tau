import { createMiddleware } from 'langchain';
import { transformAiMessageContent } from '#api/chat/utils/transform-ai-message-content.js';

/**
 * Trims leading/trailing newlines and collapses runs of 3+ consecutive
 * newlines down to a single paragraph break (`\n\n`).
 *
 * Returns the original string when no changes are needed.
 */
export function trimNewlines(text: string): string {
  return text
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
    .replaceAll(/\n{3,}/g, '\n\n');
}

/**
 * Middleware that trims excessive newlines from AIMessage content
 * after each model call.
 *
 * Uses `wrapModelCall` to intercept the model response and strip:
 * - Leading newlines from text / reasoning blocks
 * - Trailing newlines from text / reasoning blocks
 * - Interior runs of 3+ newlines (collapsed to `\n\n`)
 *
 * This prevents models that emit leading `\n\n` sequences (common with
 * Gemini reasoning output) from producing blank-line artifacts in the
 * chat UI's "Thought process" panel.
 */
export const newlineTrimmerMiddleware = createMiddleware({
  name: 'NewlineTrimmer',

  async wrapModelCall(request, handler) {
    const response = await handler(request);
    return transformAiMessageContent(response, trimNewlines);
  },
});
