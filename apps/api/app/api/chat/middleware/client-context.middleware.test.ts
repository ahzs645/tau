import { describe, it, expect, vi } from 'vitest';
import { SystemMessage } from '@langchain/core/messages';
import type { ContextPayload } from '@taucad/chat';
import {
  createClientContextMiddleware,
  formatSkillsLocations,
  formatSkillsList,
  formatMemoryContents,
  formatSkillsPrompt,
  formatMemoryPrompt,
} from '#api/chat/middleware/client-context.middleware.js';
import { resolveMiddlewareHook } from '#testing/middleware-testing.utils.js';

function makeSystemMessage(text: string): SystemMessage {
  return new SystemMessage({ content: [{ type: 'text', text }] });
}

function extractSystemText(handler: ReturnType<typeof vi.fn>): string {
  /* oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vi.fn mock.calls is typed as any[][] */
  const passedRequest = handler.mock.calls[0]![0] as { systemMessage: SystemMessage };
  const { content } = passedRequest.systemMessage;
  return Array.isArray(content)
    ? content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    : String(content);
}

// ===================================================================
// Formatting helpers
// ===================================================================

describe('formatSkillsLocations', () => {
  it('should return "None configured" for empty sources', () => {
    expect(formatSkillsLocations([])).toBe('**Skills Sources:** None configured');
  });

  it('should format a single source with higher priority suffix', () => {
    const result = formatSkillsLocations(['.tau/skills/']);
    expect(result).toContain('**Skills Skills**');
    expect(result).toContain('`.tau/skills/`');
    expect(result).toContain('(higher priority)');
  });
});

describe('formatSkillsList', () => {
  it('should format skill entries with name, description, and read path', () => {
    const skills = [
      { name: 'cad-expert', description: 'CAD modeling help', path: '.tau/skills/cad-expert' },
      { name: 'testing', description: 'Test writing support', path: '.tau/skills/testing' },
    ];

    const result = formatSkillsList(skills, ['.tau/skills/']);

    expect(result).toContain('- **cad-expert**: CAD modeling help');
    expect(result).toContain('→ Read `.tau/skills/cad-expert/SKILL.md` for full instructions');
    expect(result).toContain('- **testing**: Test writing support');
    expect(result).toContain('→ Read `.tau/skills/testing/SKILL.md` for full instructions');
  });

  it('should return placeholder when no skills available', () => {
    const result = formatSkillsList([], ['.tau/skills/']);
    expect(result).toContain('No skills available yet');
    expect(result).toContain('`.tau/skills/`');
  });
});

describe('formatMemoryContents', () => {
  it('should format memory file contents with path headers', () => {
    const agentsKey = '.tau/AGENTS.md';
    const contents = { [agentsKey]: '# Project Rules\n\nPrefer early returns.' };
    const result = formatMemoryContents(contents, [agentsKey]);

    expect(result).toContain('.tau/AGENTS.md');
    expect(result).toContain('Prefer early returns.');
  });

  it('should return "(No memory loaded)" for empty contents', () => {
    expect(formatMemoryContents({}, [])).toBe('(No memory loaded)');
  });
});

describe('formatSkillsPrompt', () => {
  it('should produce a complete skills system prompt section', () => {
    const skills = [{ name: 'my-skill', description: 'Does things', path: '.tau/skills/my-skill' }];
    const result = formatSkillsPrompt(skills, ['.tau/skills/']);

    expect(result).toContain('## Skills System');
    expect(result).toContain('- **my-skill**: Does things');
    expect(result).toContain('Progressive Disclosure');
  });
});

describe('formatMemoryPrompt', () => {
  it('should wrap memory contents in agent_memory and memory_guidelines tags', () => {
    const agentsKey = '.tau/AGENTS.md';
    const result = formatMemoryPrompt({ [agentsKey]: 'Content here' }, [agentsKey]);

    expect(result).toContain('<agent_memory>');
    expect(result).toContain('Content here');
    expect(result).toContain('</agent_memory>');
    expect(result).toContain('<memory_guidelines>');
    expect(result).toContain('</memory_guidelines>');
  });
});

// ===================================================================
// Middleware integration
// ===================================================================

describe('createClientContextMiddleware', () => {
  it('should pass through unmodified when payload is undefined', async () => {
    const middleware = createClientContextMiddleware(undefined);
    const wrapModelCall = resolveMiddlewareHook(middleware.wrapModelCall);

    const originalMessage = makeSystemMessage('Base prompt');
    const handler = vi.fn().mockResolvedValue({ content: 'response' });

    await wrapModelCall({ systemMessage: originalMessage, state: {} }, handler);

    expect(handler).toHaveBeenCalledOnce();
    /* oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vi.fn mock.calls is typed as any[][] */
    const passedRequest = handler.mock.calls[0]![0] as { systemMessage: SystemMessage };
    expect(passedRequest.systemMessage).toBe(originalMessage);
  });

  it('should pass through unmodified when payload has empty skills and no memory', async () => {
    const payload: ContextPayload = { skills: [], memory: undefined };
    const middleware = createClientContextMiddleware(payload);
    const wrapModelCall = resolveMiddlewareHook(middleware.wrapModelCall);

    const originalMessage = makeSystemMessage('Base prompt');
    const handler = vi.fn().mockResolvedValue({ content: 'response' });

    await wrapModelCall({ systemMessage: originalMessage, state: {} }, handler);

    /* oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vi.fn mock.calls is typed as any[][] */
    const passedRequest = handler.mock.calls[0]![0] as { systemMessage: SystemMessage };
    expect(passedRequest.systemMessage).toBe(originalMessage);
  });

  it('should append skills catalog to system message when payload has skills', async () => {
    const payload: ContextPayload = {
      skills: [{ name: 'test-skill', description: 'For testing', path: '.tau/skills/test-skill' }],
    };
    const middleware = createClientContextMiddleware(payload);
    const wrapModelCall = resolveMiddlewareHook(middleware.wrapModelCall);

    const handler = vi.fn().mockResolvedValue({ content: 'response' });

    await wrapModelCall({ systemMessage: makeSystemMessage('Base'), state: {} }, handler);

    const fullText = extractSystemText(handler);
    expect(fullText).toContain('## Skills System');
    expect(fullText).toContain('- **test-skill**: For testing');
    expect(fullText).toContain('Base');
  });

  it('should append memory section to system message when payload has memory', async () => {
    const agentsKey = '.tau/AGENTS.md';
    const payload: ContextPayload = {
      memory: { [agentsKey]: '# Rules\n\nUse early returns.' },
    };
    const middleware = createClientContextMiddleware(payload);
    const wrapModelCall = resolveMiddlewareHook(middleware.wrapModelCall);

    const handler = vi.fn().mockResolvedValue({ content: 'response' });

    await wrapModelCall({ systemMessage: makeSystemMessage('Base'), state: {} }, handler);

    const fullText = extractSystemText(handler);
    expect(fullText).toContain('<agent_memory>');
    expect(fullText).toContain('Use early returns.');
    expect(fullText).toContain('<memory_guidelines>');
    expect(fullText).toContain('Base');
  });

  it('should append both skills and memory sections when both present', async () => {
    const agentsKey = '.tau/AGENTS.md';
    const payload: ContextPayload = {
      skills: [{ name: 'dual', description: 'Both present', path: '.tau/skills/dual' }],
      memory: { [agentsKey]: 'Memory content' },
    };
    const middleware = createClientContextMiddleware(payload);
    const wrapModelCall = resolveMiddlewareHook(middleware.wrapModelCall);

    const handler = vi.fn().mockResolvedValue({ content: 'response' });

    await wrapModelCall({ systemMessage: makeSystemMessage('Base'), state: {} }, handler);

    const fullText = extractSystemText(handler);
    expect(fullText).toContain('## Skills System');
    expect(fullText).toContain('- **dual**: Both present');
    expect(fullText).toContain('<agent_memory>');
    expect(fullText).toContain('Memory content');
  });

  it('should call handler exactly once', async () => {
    const agentsKey = '.tau/AGENTS.md';
    const payload: ContextPayload = {
      skills: [{ name: 's', description: 'd', path: 'p' }],
      memory: { [agentsKey]: 'content' },
    };
    const middleware = createClientContextMiddleware(payload);
    const wrapModelCall = resolveMiddlewareHook(middleware.wrapModelCall);

    const handler = vi.fn().mockResolvedValue({ content: 'response' });

    await wrapModelCall({ systemMessage: makeSystemMessage('Base'), state: {} }, handler);

    expect(handler).toHaveBeenCalledOnce();
  });
});
