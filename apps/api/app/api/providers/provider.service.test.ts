import { describe, it, expect } from 'vitest';
import { convertMessagesToResponsesInput } from '@langchain/openai';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

/**
 * Regression test for @langchain/openai Responses API converter.
 *
 * The converter's `phase` extraction calls `content.findIndex()` without
 * guarding for string content, crashing with "content.findIndex is not a
 * function" when an AIMessage has string content (the default shape).
 *
 * Patched in `patches/@langchain__openai@1.4.0.patch`. This test ensures
 * the fix holds across dependency updates.
 */
describe('OpenAI Responses API converter', () => {
  it('should handle AIMessage with string content without crashing', () => {
    const messages = [new HumanMessage('Hello'), new AIMessage('Here is my response.')];

    const result = convertMessagesToResponsesInput({
      messages,
      zdrEnabled: false,
      model: 'gpt-5.4',
    });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'message', role: 'user' }),
        expect.objectContaining({ type: 'message', role: 'assistant' }),
      ]),
    );
  });
});
