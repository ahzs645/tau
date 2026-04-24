// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createWebSearchTool } from '#api/tools/tools/tool-web-search.js';

describe('createWebSearchTool', () => {
  describe('tool description', () => {
    const tool = createWebSearchTool({ tavilyApiKey: 'test-key' });

    // A single positive trailing redirect replaces the universal
    // "When NOT to use" block.
    it('redirects to web_browser for fetching the body of a known URL', () => {
      expect(tool.description).toMatch(/use\s+`web_browser`/);
    });

    it('does NOT carry a "When NOT to use" block', () => {
      expect(tool.description).not.toMatch(/When NOT to use:/);
    });
  });
});
