import { AIMessage } from '@langchain/core/messages';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeLatexDelimiters, latexDelimiterMiddleware } from '#api/chat/middleware/latex-delimiter.middleware.js';
import { invokeWrapModelCall } from '#testing/middleware-testing.utils.js';

// =============================================================================
// normalizeLatexDelimiters (unit)
// =============================================================================

describe('normalizeLatexDelimiters', () => {
  describe('inline math', () => {
    it(String.raw`should convert \( and \) to $`, () => {
      expect(normalizeLatexDelimiters(String.raw`\(x^2\)`)).toBe('$x^2$');
    });

    it('should convert multiple inline math expressions', () => {
      expect(normalizeLatexDelimiters(String.raw`where \(a\) and \(b\) are constants`)).toBe(
        'where $a$ and $b$ are constants',
      );
    });
  });

  describe('display math', () => {
    it(String.raw`should convert \[ and \] to $$`, () => {
      expect(normalizeLatexDelimiters(String.raw`\[E = mc^2\]`)).toBe('$$E = mc^2$$');
    });

    it('should handle multiline display math', () => {
      const input = String.raw`\[
\frac{a}{b} = c
\]`;
      const expected = `$$
\\frac{a}{b} = c
$$`;
      expect(normalizeLatexDelimiters(input)).toBe(expected);
    });
  });

  describe('mixed inline and display', () => {
    it('should convert both inline and display delimiters', () => {
      const input = String.raw`The formula \(F = ma\) can be expanded to \[F = m \cdot a\]`;
      const expected = String.raw`The formula $F = ma$ can be expanded to $$F = m \cdot a$$`;
      expect(normalizeLatexDelimiters(input)).toBe(expected);
    });
  });

  describe('code block preservation', () => {
    it('should not convert delimiters inside fenced code blocks', () => {
      const input = 'Here is code:\n```\nconst arr = [1, 2];\nfoo(bar);\n```\nAnd math: \\(x\\)';
      const expected = 'Here is code:\n```\nconst arr = [1, 2];\nfoo(bar);\n```\nAnd math: $x$';
      expect(normalizeLatexDelimiters(input)).toBe(expected);
    });

    it('should not convert delimiters inside fenced code blocks with language tag', () => {
      const input = '```typescript\nconst x = arr[0];\nfn(y);\n```\nMath: \\(z\\)';
      const expected = '```typescript\nconst x = arr[0];\nfn(y);\n```\nMath: $z$';
      expect(normalizeLatexDelimiters(input)).toBe(expected);
    });
  });

  describe('inline code preservation', () => {
    it('should not convert delimiters inside inline code', () => {
      const input = 'Use `arr[0]` and `fn(x)` for access. Math: \\(y\\)';
      const expected = 'Use `arr[0]` and `fn(x)` for access. Math: $y$';
      expect(normalizeLatexDelimiters(input)).toBe(expected);
    });
  });

  describe('no-op', () => {
    it('should return original text when no delimiters are present', () => {
      const input = 'No math here, just $existing$ dollar delimiters.';
      expect(normalizeLatexDelimiters(input)).toBe(input);
    });

    it('should return original text for empty string', () => {
      expect(normalizeLatexDelimiters('')).toBe('');
    });

    it('should return original text when only code contains bracket patterns', () => {
      const input = '```\nconst arr = [1];\ncall(x);\n```';
      expect(normalizeLatexDelimiters(input)).toBe(input);
    });
  });

  describe('complex mixed content', () => {
    it('should handle reasoning-style text with math and code', () => {
      const input = [
        "I'm looking at the quadratic formula where",
        String.raw`\(x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}\)`,
        'and I need to implement it:',
        '```typescript',
        'const discriminant = b*b - 4*a*c;',
        'const x1 = (-b + Math.sqrt(discriminant)) / (2*a);',
        '```',
        String.raw`The discriminant \(b^2 - 4ac\) must be non-negative.`,
      ].join('\n');

      const expected = [
        "I'm looking at the quadratic formula where",
        String.raw`$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$`,
        'and I need to implement it:',
        '```typescript',
        'const discriminant = b*b - 4*a*c;',
        'const x1 = (-b + Math.sqrt(discriminant)) / (2*a);',
        '```',
        'The discriminant $b^2 - 4ac$ must be non-negative.',
      ].join('\n');

      expect(normalizeLatexDelimiters(input)).toBe(expected);
    });
  });
});

// =============================================================================
// latexDelimiterMiddleware
// =============================================================================

describe('latexDelimiterMiddleware', () => {
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handler = vi.fn();
  });

  describe('string content', () => {
    it('should normalize delimiters in string content', async () => {
      handler.mockResolvedValue(new AIMessage({ content: String.raw`\(x^2\)` }));

      const result = (await invokeWrapModelCall(latexDelimiterMiddleware, { messages: [] }, handler)) as AIMessage;

      expect(result.content).toBe('$x^2$');
    });

    it('should return original message when no delimiters present', async () => {
      const original = new AIMessage({ content: 'No math here' });
      handler.mockResolvedValue(original);

      const result = (await invokeWrapModelCall(latexDelimiterMiddleware, { messages: [] }, handler)) as AIMessage;

      expect(result).toBe(original);
    });
  });

  describe('reasoning blocks', () => {
    it('should normalize delimiters in reasoning blocks', async () => {
      handler.mockResolvedValue(
        new AIMessage({
          content: [
            { type: 'reasoning', reasoning: String.raw`The formula \(E = mc^2\) means...` },
            { type: 'text', text: 'Here is the answer' },
          ],
        }),
      );

      const result = (await invokeWrapModelCall(latexDelimiterMiddleware, { messages: [] }, handler)) as AIMessage;
      const blocks = result.content as Array<{ type: string; reasoning?: string; text?: string }>;

      expect(blocks[0]!.reasoning).toBe('The formula $E = mc^2$ means...');
      expect(blocks[1]!.text).toBe('Here is the answer');
    });
  });

  describe('text blocks', () => {
    it('should normalize delimiters in text blocks', async () => {
      handler.mockResolvedValue(
        new AIMessage({
          content: [{ type: 'text', text: String.raw`\[F = ma\]` }],
        }),
      );

      const result = (await invokeWrapModelCall(latexDelimiterMiddleware, { messages: [] }, handler)) as AIMessage;
      const blocks = result.content as Array<{ type: string; text: string }>;

      expect(blocks[0]!.text).toBe('$$F = ma$$');
    });
  });

  describe('metadata preservation', () => {
    it('should preserve all metadata when normalizing', async () => {
      /* eslint-disable @typescript-eslint/naming-convention -- LangChain API uses snake_case */
      handler.mockResolvedValue(
        new AIMessage({
          content: String.raw`\(x\)`,
          id: 'msg_meta',
          tool_calls: [{ id: 'call_1', name: 'read_file', args: {} }],
          additional_kwargs: { custom: 'value' },
          response_metadata: { model: 'claude-4-sonnet' },
          usage_metadata: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            input_token_details: { cache_read: 0, cache_creation: 0 },
          },
        }),
      );
      /* eslint-enable @typescript-eslint/naming-convention -- Re-enable naming convention after LangChain metadata */

      const result = (await invokeWrapModelCall(latexDelimiterMiddleware, { messages: [] }, handler)) as AIMessage;

      expect(result.content).toBe('$x$');
      expect(result.id).toBe('msg_meta');
      expect(result.tool_calls).toHaveLength(1);
      expect(result.additional_kwargs).toEqual({ custom: 'value' });
    });
  });

  describe('handler passthrough', () => {
    it('should forward the request to the handler unchanged', async () => {
      handler.mockResolvedValue(new AIMessage({ content: 'clean' }));

      await invokeWrapModelCall(latexDelimiterMiddleware, { messages: [] }, handler);

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
