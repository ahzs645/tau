import type { UIMessageChunk } from 'ai';
import { createDeltaTransform } from '#api/chat/utils/create-delta-transform.js';
import { normalizeLatexDelimiters } from '#api/chat/middleware/latex-delimiter.middleware.js';

/**
 * Creates a TransformStream that normalizes LaTeX-style math delimiters
 * in streaming `text-delta` and `reasoning-delta` chunks.
 *
 * Converts `\(...\)` to `$...$` and `\[...\]` to `$$...$$` so the
 * client-side `remark-math` / `rehype-katex` pipeline can render them.
 */
export function createLatexDelimiterTransform(): TransformStream<UIMessageChunk, UIMessageChunk> {
  return createDeltaTransform(normalizeLatexDelimiters);
}
