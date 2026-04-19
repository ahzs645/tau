import { describe, it, expect } from 'vitest';
import { SystemMessage } from '@langchain/core/messages';
import { createCachedSystemMessage } from '#api/chat/utils/create-cached-system-message.js';

type ContentBlock = {
  type: string;
  text: string;
  cache_control?: { type: string; scope?: string };
};

describe('createCachedSystemMessage', () => {
  it('should return a SystemMessage', () => {
    const message = createCachedSystemMessage({
      staticPrompt: 'static',
      dynamicPrompt: 'dynamic',
    });
    expect(message).toBeInstanceOf(SystemMessage);
  });

  it('should produce 2 content blocks (static + dynamic)', () => {
    const message = createCachedSystemMessage({
      staticPrompt: 'static content',
      dynamicPrompt: 'dynamic content',
    });
    const content = message.content as ContentBlock[];
    expect(content).toHaveLength(2);
    expect(content[0]!.text).toBe('static content');
    expect(content[1]!.text).toBe('dynamic content');
  });

  it('should add global scope to Block 1 when useGlobalScope is true', () => {
    const message = createCachedSystemMessage({
      staticPrompt: 'static',
      dynamicPrompt: 'dynamic',
      useGlobalScope: true,
    });
    const content = message.content as ContentBlock[];
    expect(content[0]!.cache_control).toEqual({ type: 'ephemeral', scope: 'global' });
  });

  it('should NOT add global scope to Block 1 when useGlobalScope is false', () => {
    const message = createCachedSystemMessage({
      staticPrompt: 'static',
      dynamicPrompt: 'dynamic',
      useGlobalScope: false,
    });
    const content = message.content as ContentBlock[];
    expect(content[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(content[0]!.cache_control).not.toHaveProperty('scope');
  });

  it('should NOT add cache_control to the dynamic block', () => {
    const message = createCachedSystemMessage({
      staticPrompt: 'static',
      dynamicPrompt: 'dynamic',
      useGlobalScope: true,
    });
    const content = message.content as ContentBlock[];
    expect(content[1]!.cache_control).toBeUndefined();
  });

  it('should default to no global scope when useGlobalScope is omitted', () => {
    const message = createCachedSystemMessage({
      staticPrompt: 'static',
      dynamicPrompt: 'dynamic',
    });
    const content = message.content as ContentBlock[];
    expect(content[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });
});
