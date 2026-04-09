import { createMiddleware } from 'langchain';
import { transformAiMessageContent } from '#api/chat/utils/transform-ai-message-content.js';

/**
 * Regex that matches segments of text where LaTeX delimiters should NOT
 * be converted: fenced code blocks and inline code spans.
 *
 * Captures (in order of priority):
 * 1. Fenced code blocks: ``` ... ``` (with optional language tag)
 * 2. Inline code: `...`
 * 3. Non-code text segments (captured for processing)
 */
const codeOrTextSegment = /(```[\S\s]*?```|`[^`]*`)/g;

/**
 * Normalizes LaTeX-style math delimiters to markdown math delimiters.
 *
 * Converts:
 * - `\(` → `$` and `\)` → `$` (inline math)
 * - `\[` → `$$` and `\]` → `$$` (display math)
 *
 * Delimiters inside fenced code blocks and inline code spans are
 * preserved unchanged.
 *
 * LLM reasoning/thinking output typically uses LaTeX-native `\(...\)`
 * and `\[...\]` delimiters, while the UI's `remark-math` only supports
 * `$...$` and `$$...$$`.
 */
export function normalizeLatexDelimiters(text: string): string {
  const segments = text.split(codeOrTextSegment);
  let modified = false;

  const result = segments.map((segment) => {
    if (segment.startsWith('`')) {
      return segment;
    }

    const normalized = segment
      .replaceAll(String.raw`\(`, '$')
      .replaceAll(String.raw`\)`, '$')
      .replaceAll(String.raw`\[`, '$$$$')
      .replaceAll(String.raw`\]`, '$$$$');

    if (normalized !== segment) {
      modified = true;
    }

    return normalized;
  });

  // oxlint-disable-next-line typescript/no-unnecessary-condition -- loop can set modified to true
  return modified ? result.join('') : text;
}

/**
 * Middleware that normalizes LaTeX-style math delimiters in AIMessage
 * content after each model call.
 *
 * Converts `\(...\)` to `$...$` and `\[...\]` to `$$...$$` in both
 * text and reasoning content blocks, so the UI's `remark-math` /
 * `rehype-katex` pipeline can parse and render them.
 */
export const latexDelimiterMiddleware = createMiddleware({
  name: 'LatexDelimiterNormalizer',

  async wrapModelCall(request, handler) {
    const response = await handler(request);
    return transformAiMessageContent(response, normalizeLatexDelimiters);
  },
});
