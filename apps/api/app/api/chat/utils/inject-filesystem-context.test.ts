import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { injectFilesystemContext } from '#api/chat/utils/inject-filesystem-context.js';

function createUserMessage(text: string, id = 'msg-1'): UIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

function createAssistantMessage(text: string, id = 'msg-2'): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text }],
  };
}

describe('injectFilesystemContext', () => {
  const filesystemSnapshot = `src/
  index.ts
  utils/
    helper.ts`;

  it('should inject filesystem context into last user message', () => {
    const messages = [createUserMessage('Help me with my code')];

    const result = injectFilesystemContext(messages, filesystemSnapshot);

    expect(result).toHaveLength(1);
    expect(result[0]?.parts[0]).toHaveProperty('type', 'text');
    expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toContain('<project_layout>');
    expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toContain(filesystemSnapshot);
    expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toContain('Help me with my code');
  });

  it('should return original messages if no user message exists', () => {
    const messages = [createAssistantMessage('Hello!')];

    const result = injectFilesystemContext(messages, filesystemSnapshot);

    expect(result).toEqual(messages);
  });

  it('should inject into the last user message when multiple exist', () => {
    const messages = [
      createUserMessage('First question', 'msg-1'),
      createAssistantMessage('First answer', 'msg-2'),
      createUserMessage('Second question', 'msg-3'),
    ];

    const result = injectFilesystemContext(messages, filesystemSnapshot);

    expect(result).toHaveLength(3);
    // First message should be unchanged
    expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toBe('First question');
    // Last user message should have context
    expect((result[2]?.parts[0] as { type: 'text'; text: string }).text).toContain('<project_layout>');
    expect((result[2]?.parts[0] as { type: 'text'; text: string }).text).toContain('Second question');
  });

  it('should return empty array for empty messages array', () => {
    const messages: UIMessage[] = [];

    const result = injectFilesystemContext(messages, filesystemSnapshot);

    expect(result).toEqual([]);
  });

  it('should preserve non-text parts in the message', () => {
    const messageWithImage: UIMessage = {
      id: 'msg-1',
      role: 'user',
      parts: [
        { type: 'text', text: 'Check this image' },
        {
          type: 'file',
          mediaType: 'image/png',
          url: 'https://example.com/image.png',
        },
      ],
    };
    const messages = [messageWithImage];

    const result = injectFilesystemContext(messages, filesystemSnapshot);

    expect(result[0]?.parts).toHaveLength(2);
    expect(result[0]?.parts[0]).toHaveProperty('type', 'text');
    expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toContain('<project_layout>');
    expect(result[0]?.parts[1]).toHaveProperty('type', 'file');
  });

  it('should prepend context to each text part', () => {
    const messageWithMultipleTextParts: UIMessage = {
      id: 'msg-1',
      role: 'user',
      parts: [
        { type: 'text', text: 'Part one' },
        { type: 'text', text: 'Part two' },
      ],
    };
    const messages = [messageWithMultipleTextParts];

    const result = injectFilesystemContext(messages, filesystemSnapshot);

    // Each text part gets the context prepended
    expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toContain('<project_layout>');
    expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toContain('Part one');
    expect((result[0]?.parts[1] as { type: 'text'; text: string }).text).toContain('<project_layout>');
    expect((result[0]?.parts[1] as { type: 'text'; text: string }).text).toContain('Part two');
  });

  it('should not mutate original messages array', () => {
    const originalMessage = createUserMessage('Original text');
    const messages = [originalMessage];

    const result = injectFilesystemContext(messages, filesystemSnapshot);

    expect(result).not.toBe(messages);
    expect(result[0]).not.toBe(originalMessage);
    expect((originalMessage.parts[0] as { type: 'text'; text: string }).text).toBe('Original text');
  });

  it('should format the project layout context correctly', () => {
    const messages = [createUserMessage('Hello')];

    const result = injectFilesystemContext(messages, filesystemSnapshot);

    const { text } = result[0]?.parts[0] as { type: 'text'; text: string };
    expect(text).toMatch(/^<project_layout>\nBelow is a snapshot of the current project's file structure:\n\n/);
    expect(text).toContain('</project_layout>\n\n');
    expect(text).toMatch(/Hello$/);
  });
});
