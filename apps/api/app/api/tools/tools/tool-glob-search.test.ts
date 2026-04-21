// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { globSearchToolDefinition } from '#api/tools/tools/tool-glob-search.js';

describe('globSearchToolDefinition', () => {
  describe('tool description', () => {
    // Per docs/research/system-prompt-audit.md R19 (revised Apr 2026): a single
    // positive trailing redirect replaces the universal "When NOT to use" block.
    it('redirects to grep for content searches', () => {
      expect(globSearchToolDefinition.description).toMatch(/use\s+`grep`/);
    });

    it('does NOT carry a "When NOT to use" block (revised R19)', () => {
      expect(globSearchToolDefinition.description).not.toMatch(/When NOT to use:/);
    });
  });
});
