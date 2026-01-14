import type { UIMessageChunk } from 'ai';
import { normalizeError } from '#api/chat/utils/error-normalizer.js';

type ErrorChunk = UIMessageChunk & { type: 'error'; errorText: string };

function isErrorChunk(chunk: UIMessageChunk): chunk is ErrorChunk {
  return chunk.type === 'error';
}

/**
 * Creates a TransformStream that intercepts error chunks and rewrites them
 * using the structured `normalizeError` format.
 *
 * The `@ai-sdk/langchain` adapter's `toUIMessageStream()` catches errors internally
 * and emits error chunks with simple `error.message` text. This transform intercepts
 * those chunks and replaces the `errorText` with a structured JSON format from
 * `normalizeError` for better UI display.
 *
 * @returns A TransformStream that processes UIMessageChunk events
 */
export function createErrorTransform(): TransformStream<UIMessageChunk, UIMessageChunk> {
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (isErrorChunk(chunk)) {
        // Normalize the error message using our structured format
        const normalizedErrorText = normalizeError(new Error(chunk.errorText));
        controller.enqueue({ ...chunk, errorText: normalizedErrorText });
        return;
      }

      controller.enqueue(chunk);
    },
  });
}
