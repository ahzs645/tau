// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { globSearchToolDefinition } from '#api/tools/tools/tool-glob-search.js';

describe('globSearchToolDefinition', () => {
  describe('tool description', () => {
    // A single positive trailing redirect replaces the universal
    // "When NOT to use" block.
    it('redirects to grep for content searches', () => {
      expect(globSearchToolDefinition.description).toMatch(/use\s+`grep`/);
    });

    it('does NOT carry a "When NOT to use" block', () => {
      expect(globSearchToolDefinition.description).not.toMatch(/When NOT to use:/);
    });
  });
});
