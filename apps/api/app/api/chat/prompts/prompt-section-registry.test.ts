import { describe, it, expect } from 'vitest';
import { createSectionRegistry } from '#api/chat/prompts/prompt-section-registry.js';

describe('createSectionRegistry', () => {
  it('should register and resolve static sections into static output', () => {
    const registry = createSectionRegistry();
    registry.register({ name: 'role', compute: () => '<role>You are Tau</role>', cacheBreak: false });
    const { static: staticPrompt } = registry.resolve();
    expect(staticPrompt).toContain('<role>You are Tau</role>');
  });

  it('should register and resolve dynamic sections into dynamic output', () => {
    const registry = createSectionRegistry();
    registry.register({ name: 'git_status', compute: () => '<git_status>M file.ts</git_status>', cacheBreak: true });
    const { dynamic } = registry.resolve();
    expect(dynamic).toContain('<git_status>M file.ts</git_status>');
  });

  it('should partition sections by cacheBreak flag', () => {
    const registry = createSectionRegistry();
    registry.register({ name: 'role', compute: () => 'STATIC_CONTENT', cacheBreak: false });
    registry.register({ name: 'workflow', compute: () => 'ALSO_STATIC', cacheBreak: false });
    registry.register({ name: 'env', compute: () => 'DYNAMIC_CONTENT', cacheBreak: true });
    registry.register({ name: 'git', compute: () => 'ALSO_DYNAMIC', cacheBreak: true });

    const { static: staticPrompt, dynamic } = registry.resolve();

    expect(staticPrompt).toContain('STATIC_CONTENT');
    expect(staticPrompt).toContain('ALSO_STATIC');
    expect(staticPrompt).not.toContain('DYNAMIC_CONTENT');
    expect(staticPrompt).not.toContain('ALSO_DYNAMIC');

    expect(dynamic).toContain('DYNAMIC_CONTENT');
    expect(dynamic).toContain('ALSO_DYNAMIC');
    expect(dynamic).not.toContain('STATIC_CONTENT');
    expect(dynamic).not.toContain('ALSO_STATIC');
  });

  it('should preserve section registration order', () => {
    const registry = createSectionRegistry();
    registry.register({ name: 'first', compute: () => 'AAA', cacheBreak: false });
    registry.register({ name: 'second', compute: () => 'BBB', cacheBreak: false });
    registry.register({ name: 'third', compute: () => 'CCC', cacheBreak: false });

    const { static: staticPrompt } = registry.resolve();
    const aIndex = staticPrompt.indexOf('AAA');
    const bIndex = staticPrompt.indexOf('BBB');
    const cIndex = staticPrompt.indexOf('CCC');
    expect(aIndex).toBeLessThan(bIndex);
    expect(bIndex).toBeLessThan(cIndex);
  });

  it('should allow invalidating a section by name', () => {
    const registry = createSectionRegistry();
    let counter = 0;
    registry.register({ name: 'counter', compute: () => `count=${counter}`, cacheBreak: false });

    const first = registry.resolve();
    expect(first.static).toContain('count=0');

    counter = 1;
    registry.invalidate('counter');

    const second = registry.resolve();
    expect(second.static).toContain('count=1');
  });

  it('should return empty strings when no sections registered', () => {
    const registry = createSectionRegistry();
    const { static: staticPrompt, dynamic } = registry.resolve();
    expect(staticPrompt).toBe('');
    expect(dynamic).toBe('');
  });

  it('should skip empty section outputs', () => {
    const registry = createSectionRegistry();
    registry.register({ name: 'empty', compute: () => '', cacheBreak: false });
    registry.register({ name: 'content', compute: () => 'visible', cacheBreak: false });

    const { static: staticPrompt } = registry.resolve();
    expect(staticPrompt).toBe('visible');
  });
});
