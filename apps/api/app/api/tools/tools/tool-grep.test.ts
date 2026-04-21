// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { grepToolDefinition } from '#api/tools/tools/tool-grep.js';

describe('grepToolDefinition', () => {
  describe('tool description', () => {
    // Per docs/research/system-prompt-audit.md R19 (revised Apr 2026): a single
    // positive trailing redirect replaces the universal "When NOT to use" block.
    it('redirects to glob for file-name-pattern searches', () => {
      expect(grepToolDefinition.description).toMatch(/use\s+`glob`/);
    });

    it('does NOT carry a "When NOT to use" block (revised R19)', () => {
      expect(grepToolDefinition.description).not.toMatch(/When NOT to use:/);
    });
  });
});
