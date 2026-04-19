import { describe, it, expect } from 'vitest';
import { getCadSystemPrompt } from '#api/chat/prompts/cad-agent.prompt.js';

describe('getCadSystemPrompt', () => {
  // ===================================================================
  // R3: Anti-gold-plating rules (Finding 3)
  // ===================================================================

  describe('R3: anti-gold-plating constraints', () => {
    it('should include a <constraints> section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toContain('<constraints>');
      expect(result.static).toContain('</constraints>');
    });

    it('should forbid adding unrequested features', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toMatch(/do not add features.*beyond what was asked/i);
    });

    it('should forbid unnecessary error handling', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toMatch(/do not add error handling.*cannot happen/i);
    });

    it('should forbid premature abstractions', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toMatch(/do not create helpers.*one-time/i);
    });
  });

  // ===================================================================
  // R12: Rationalization inoculation (Finding 12)
  // ===================================================================

  describe('R12: rationalization inoculation in visual inspection', () => {
    it('should enumerate avoidance patterns in <visual_inspection>', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toContain('approximately right');
      expect(result.static).toContain("hasn't complained");
      expect(result.static).toContain('too complex to verify');
      expect(result.static).toContain('Tests are passing');
    });

    it('should instruct to call screenshot if about to write explanation', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toMatch(/catch yourself writing an explanation.*call screenshot/i);
    });
  });

  // ===================================================================
  // R1: Static/dynamic split (Finding 1)
  // ===================================================================

  describe('R1: static/dynamic prompt split', () => {
    it('should return an object with static and dynamic properties', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result).toHaveProperty('static');
      expect(result).toHaveProperty('dynamic');
      expect(typeof result.static).toBe('string');
      expect(typeof result.dynamic).toBe('string');
    });

    it('should place <role> in static section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toContain('<role>');
    });

    it('should place <workflow> in static section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toContain('<workflow>');
    });

    it('should place <code_standards> in static section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toContain('<code_standards>');
    });

    it('should place <canonical_example> in static section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toContain('<canonical_example>');
    });

    it('should place <constraints> in static section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toContain('<constraints>');
    });

    it('should place <visual_inspection> in static section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toContain('<visual_inspection>');
    });

    it('should NOT contain chatId in static section', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, { chatId: 'test-chat-123' });
      expect(result.static).not.toContain('test-chat-123');
    });

    it('should place transcript path with chatId in dynamic section', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, { chatId: 'test-chat-123' });
      expect(result.dynamic).toContain('test-chat-123');
    });
  });

  // ===================================================================
  // R7: Model self-awareness (Finding 8)
  // ===================================================================

  describe('R7: model self-awareness', () => {
    it('should include model name in dynamic section when modelId provided', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, {
        chatId: 'test',
        modelId: 'anthropic-claude-sonnet-4.6',
      });
      expect(result.dynamic).toContain('anthropic-claude-sonnet-4.6');
    });

    it('should include <environment> section in dynamic', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, {
        chatId: 'test',
        modelId: 'test-model',
        contextWindow: 200_000,
      });
      expect(result.dynamic).toContain('<environment>');
      expect(result.dynamic).toContain('200000');
    });

    it('should include knowledge cutoff in <environment> when provided', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, {
        chatId: 'test',
        modelId: 'test-model',
        contextWindow: 200_000,
        knowledgeCutoff: '2025-08',
      });
      expect(result.dynamic).toContain('knowledge cutoff: 2025-08');
    });

    it('should omit knowledge cutoff from <environment> when not provided', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, {
        chatId: 'test',
        modelId: 'test-model',
        contextWindow: 200_000,
      });
      expect(result.dynamic).not.toContain('knowledge cutoff');
    });

    it('should NOT include model info in static section', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, {
        chatId: 'test',
        modelId: 'test-model',
      });
      expect(result.static).not.toContain('test-model');
    });
  });

  // ===================================================================
  // R6: Git status injection (Finding 6)
  // ===================================================================

  describe('R6: git status injection', () => {
    it('should include git status in dynamic section when provided', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, {
        chatId: 'test',
        gitStatus: 'M src/main.scad\nA src/lib/component.scad',
      });
      expect(result.dynamic).toContain('<git_status>');
      expect(result.dynamic).toContain('M src/main.scad');
    });

    it('should truncate git status at 2000 chars', async () => {
      const longStatus = 'M '.padEnd(2500, 'x');
      const result = await getCadSystemPrompt('openscad', 'agent', true, {
        chatId: 'test',
        gitStatus: longStatus,
      });
      const gitStatusSection = /<git_status>([\S\s]*?)<\/git_status>/.exec(result.dynamic)?.[1] ?? '';
      expect(gitStatusSection.length).toBeLessThanOrEqual(2200);
      expect(result.dynamic).toContain('Truncated');
    });

    it('should show git-aware fallback text when truncated', async () => {
      const longStatus = 'M '.padEnd(2500, 'x');
      const result = await getCadSystemPrompt('openscad', 'agent', true, {
        chatId: 'test',
        gitStatus: longStatus,
      });
      expect(result.dynamic).toContain('git status');
      expect(result.dynamic).not.toContain('list_directory');
    });

    it('should NOT include git status in static section', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, {
        chatId: 'test',
        gitStatus: 'M unique-file.scad',
      });
      expect(result.static).not.toContain('unique-file.scad');
    });
  });

  // ===================================================================
  // R14: Anti-vague-reference instruction (Finding 9)
  // ===================================================================

  describe('R14: anti-vague-reference instruction', () => {
    it('should include anti-delegation instruction in dynamic section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.dynamic).toMatch(/specific file paths|line numbers|never.*vague/i);
    });
  });

  // ===================================================================
  // R16: Ack-then-work-then-result pattern (Finding 14)
  // ===================================================================

  describe('R16: ack-then-work-then-result pattern', () => {
    it('should include ack instruction in dynamic section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.dynamic).toMatch(/acknowledge the task|progress updates.*information/i);
    });
  });

  // ===================================================================
  // R5: Golden structural test (Finding 5)
  // ===================================================================

  describe('R5: golden structural test for section registry refactor', () => {
    const goldenOptions = {
      chatId: 'golden-test',
      modelId: 'test-model',
      contextWindow: 200_000,
      knowledgeCutoff: '2025-08',
      gitStatus: 'M main.scad',
    } as const;

    it('should contain all expected static sections', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, goldenOptions);

      const expectedSections = [
        '<role>',
        '</role>',
        '<workflow>',
        '</workflow>',
        '<constraints>',
        '</constraints>',
        '<test_requirements>',
        '</test_requirements>',
        '<visual_inspection>',
        '</visual_inspection>',
        '<code_standards>',
        '</code_standards>',
        '<error_handling>',
        '</error_handling>',
        '<canonical_example>',
        '</canonical_example>',
        '<research_capabilities>',
        '</research_capabilities>',
        '<transcript_search>',
        '</transcript_search>',
      ];

      for (const tag of expectedSections) {
        expect(result.static).toContain(tag);
      }
    });

    it('should contain all expected dynamic sections', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, goldenOptions);

      expect(result.dynamic).toContain('.tau/transcripts/golden-test.jsonl');
      expect(result.dynamic).toContain('<environment>');
      expect(result.dynamic).toContain('knowledge cutoff: 2025-08');
      expect(result.dynamic).toContain('<git_status>');
      expect(result.dynamic).toContain('M main.scad');
    });

    it('should place dynamic sections in correct order', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, goldenOptions);

      const transcriptIndex = result.dynamic.indexOf('.tau/transcripts/');
      const envIndex = result.dynamic.indexOf('<environment>');
      const gitIndex = result.dynamic.indexOf('<git_status>');

      expect(transcriptIndex).toBeLessThan(envIndex);
      expect(envIndex).toBeLessThan(gitIndex);
    });

    it('should not have triple+ blank lines in output', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, goldenOptions);

      expect(result.static).not.toMatch(/\n{4,}/);
      expect(result.dynamic).not.toMatch(/\n{4,}/);
    });

    it('should not leak dynamic content into static prompt', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, goldenOptions);

      expect(result.static).not.toContain('golden-test');
      expect(result.static).not.toContain('test-model');
      expect(result.static).not.toContain('M main.scad');
    });
  });

  // ===================================================================
  // R10: Numeric length anchors (Finding 10)
  // ===================================================================

  describe('R10: numeric length anchors', () => {
    it('should include word-count limits in static prompt', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toMatch(/<=\s*25\s*words/i);
      expect(result.static).toMatch(/<=\s*100\s*words/i);
    });
  });

  // ===================================================================
  // Plan mode and testing mode behavior
  // ===================================================================

  describe('mode and testing variations', () => {
    it('should include <plan_mode> in static when mode is plan', async () => {
      const result = await getCadSystemPrompt('openscad', 'plan');
      expect(result.static).toContain('<plan_mode>');
    });

    it('should include <test_requirements> in static when testing enabled', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true);
      expect(result.static).toContain('<test_requirements>');
    });

    it('should omit <test_requirements> when testing disabled', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', false);
      expect(result.static).not.toContain('<test_requirements>');
    });
  });
});
