// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { grepToolDefinition } from '#api/tools/tools/tool-grep.js';

describe('grepToolDefinition', () => {
  describe('tool description', () => {
    // A single positive trailing redirect replaces the universal
    // "When NOT to use" block.
    it('redirects to glob for file-name-pattern searches', () => {
      expect(grepToolDefinition.description).toMatch(/use\s+`glob`/);
    });

    it('does NOT carry a "When NOT to use" block', () => {
      expect(grepToolDefinition.description).not.toMatch(/When NOT to use:/);
    });
  });
});
