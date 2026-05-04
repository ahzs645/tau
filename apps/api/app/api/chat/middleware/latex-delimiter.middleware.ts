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
 * Collapses LLM over-escapes such as `\\times` (two ASCII backslashes) into
 * `\times`. In TeX/KaTeX `\\` is a line break; `times` is plain text, which
 * breaks inline dimensions like `$96\\times66\\times82$`.
 *
 * Only applies when the pair is immediately followed by `[A-Za-z]` so real
 * row breaks like `a \\ b` (space after `\\`) stay untouched.
 */
const doubleBackslashBeforeLetterPattern = /\\\\([A-Za-z])/g;

/**
 * Normalizes LaTeX-style math delimiters to markdown math delimiters.
 *
 * Converts:
 * - `\(` → `$` and `\)` → `$` (inline math)
 * - `\[` → `$$` and `\]` → `$$` (display math)
 * - `\\foo` → `\foo` when `foo` starts with an ASCII letter (LLM JSON-style doubling)
 *
 * Delimiters inside fenced code blocks and inline code spans are
 * preserved unchanged (including no over-escape collapse there).
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

    const withDelimiters = segment
      .replaceAll(String.raw`\(`, '$')
      .replaceAll(String.raw`\)`, '$')
      .replaceAll(String.raw`\[`, '$$$$')
      .replaceAll(String.raw`\]`, '$$$$');

    const collapsed = withDelimiters.replace(doubleBackslashBeforeLetterPattern, String.raw`\$1`);

    if (collapsed !== segment) {
      modified = true;
    }

    return collapsed;
  });

  // oxlint-disable-next-line typescript/no-unnecessary-condition -- loop can set modified to true
  return modified ? result.join('') : text;
}

/**
 * Middleware that normalizes LaTeX-style math delimiters in AIMessage
 * content after each model call.
 *
 * Converts `\(...\)` to `$...$` and `\[...\]` to `$$...$$` in both
 * text and reasoning content blocks, collapses `\\command` over-escapes
 * for KaTeX, so the UI's `remark-math` / `rehype-katex` pipeline can parse
 * and render them.
 */
export const latexDelimiterMiddleware = createMiddleware({
  name: 'LatexDelimiterNormalizer',

  async wrapModelCall(request, handler) {
    const response = await handler(request);
    return transformAiMessageContent(response, normalizeLatexDelimiters);
  },
});
