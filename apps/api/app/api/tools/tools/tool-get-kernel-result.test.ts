// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getKernelResultToolDefinition } from '#api/tools/tools/tool-get-kernel-result.js';

describe('getKernelResultToolDefinition', () => {
  describe('tool description', () => {
    // Per docs/research/system-prompt-audit.md R19 (revised Apr 2026): a single
    // positive trailing redirect replaces the universal "When NOT to use" block.
    it('redirects to test_model for geometry-measurement requirements', () => {
      expect(getKernelResultToolDefinition.description).toMatch(/use\s+`test_model`/);
    });

    it('does NOT carry a "When NOT to use" block (revised R19)', () => {
      expect(getKernelResultToolDefinition.description).not.toMatch(/When NOT to use:/);
    });
  });
});
