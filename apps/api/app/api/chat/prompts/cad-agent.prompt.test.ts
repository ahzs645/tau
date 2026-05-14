import type { KernelProvider } from '@taucad/runtime';
import { describe, it, expect, vi } from 'vitest';
import { getCadSystemPrompt } from '#api/chat/prompts/cad-agent.prompt.js';
import { getKernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.js';

describe('getCadSystemPrompt', () => {
  // ===================================================================
  // Anti-gold-plating rules
  // ===================================================================

  describe('anti-gold-plating constraints', () => {
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
  // Rationalization inoculation
  // ===================================================================

  describe('rationalization inoculation in visual inspection', () => {
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
  // Static/dynamic split
  // ===================================================================

  describe('static/dynamic prompt split', () => {
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
  // Model self-awareness
  // ===================================================================

  describe('model self-awareness', () => {
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
  // Anti-vague-reference instruction
  // ===================================================================

  describe('anti-vague-reference instruction', () => {
    it('should include anti-delegation instruction in dynamic section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.dynamic).toMatch(/specific file paths|line numbers|never.*vague/i);
    });
  });

  // ===================================================================
  // Ack-then-work-then-result pattern
  // ===================================================================

  describe('ack-then-work-then-result pattern', () => {
    it('should include ack instruction in dynamic section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.dynamic).toMatch(/acknowledge the task|progress updates.*information/i);
    });
  });

  // ===================================================================
  // Golden structural test for section registry refactor
  // ===================================================================

  describe('golden structural test for section registry refactor', () => {
    const goldenOptions = {
      chatId: 'golden-test',
      modelId: 'test-model',
      contextWindow: 200_000,
      knowledgeCutoff: '2025-08',
    } as const;

    it('should contain all expected static sections', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, goldenOptions);

      const expectedSections = [
        '<role>',
        '</role>',
        '<workflow>',
        '</workflow>',
        '<tool_usage_policy>',
        '</tool_usage_policy>',
        '<constraints>',
        '</constraints>',
        '<tone>',
        '</tone>',
        '<test_requirements>',
        '</test_requirements>',
        '<visual_inspection>',
        '</visual_inspection>',
        '<code_standards>',
        '</code_standards>',
        '<error_handling>',
        '</error_handling>',
        '<system_rules>',
        '</system_rules>',
        '<safety>',
        '</safety>',
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
    });

    it('should place dynamic sections in correct order', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true, goldenOptions);

      const transcriptIndex = result.dynamic.indexOf('.tau/transcripts/');
      const envIndex = result.dynamic.indexOf('<environment>');

      expect(transcriptIndex).toBeLessThan(envIndex);
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
  // Numeric length anchors
  // ===================================================================

  describe('numeric length anchors', () => {
    it('should include word-count limits in static prompt', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toMatch(/<=\s*25\s*words/i);
      expect(result.static).toMatch(/<=\s*100\s*words/i);
    });
  });

  // ===================================================================
  // <system-reminder> recognition contract
  // ===================================================================

  describe('<system-reminder> recognition contract', () => {
    it('should declare a <system_reminder_contract> inside <error_handling>', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toContain('<system_reminder_contract>');
      expect(result.static).toContain('</system_reminder_contract>');

      const errorBlock = result.static.slice(
        result.static.indexOf('<error_handling>'),
        result.static.indexOf('</error_handling>'),
      );
      expect(errorBlock).toContain('<system_reminder_contract>');
    });

    it('should explicitly state that <system-reminder> messages are NOT user input', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toMatch(/<system-reminder>[\S\s]*?are not user input/i);
    });

    it('should instruct the model to stop the offending behaviour and pick one of (a)/(b)/(c)', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toMatch(/stop the behaviour/i);
      expect(result.static).toMatch(/\(a\)/);
      expect(result.static).toMatch(/\(b\)/);
      expect(result.static).toMatch(/\(c\)/);
    });

    it('should instruct the model NOT to echo / quote / apologise for the reminder', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toMatch(/never echo, quote, or apologise/i);
    });
  });

  // ===================================================================
  // <tone> static section
  // ===================================================================

  describe('tone block', () => {
    it('should include a <tone> static section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toContain('<tone>');
      expect(result.static).toContain('</tone>');
    });

    it('should require objectivity (no flattery / congratulations / apology)', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(result.static.indexOf('<tone>'), result.static.indexOf('</tone>'));
      expect(block).toMatch(/Be objective/);
      expect(block).toMatch(/flatter/i);
      expect(block).toMatch(/congratulate/i);
      expect(block).toMatch(/apologise/i);
    });

    it('should ban completion-time estimates and filler text', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(result.static.indexOf('<tone>'), result.static.indexOf('</tone>'));
      expect(block).toMatch(/estimate completion times/i);
      expect(block).toMatch(/filler/i);
    });

    it('should ban a colon before a tool call', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(result.static.indexOf('<tone>'), result.static.indexOf('</tone>'));
      expect(block).toMatch(/colon before a tool call/i);
    });

    it('should ban unrequested emojis', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(result.static.indexOf('<tone>'), result.static.indexOf('</tone>'));
      expect(block).toMatch(/emoji/i);
    });

    it('should NOT appear in dynamic section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.dynamic).not.toContain('<tone>');
    });
  });

  // ===================================================================
  // <test_requirements> top-level-export guidance (per-kernel)
  // ===================================================================

  describe('<test_requirements> top-level-export guidance (per-kernel)', () => {
    const allKernels: readonly KernelProvider[] = ['openscad', 'replicad', 'jscad', 'manifold', 'opencascadejs', 'zoo'];

    const extractTestRequirementsBlock = (prompt: string): string =>
      prompt.slice(prompt.indexOf('<test_requirements>'), prompt.indexOf('</test_requirements>'));

    describe.each(allKernels)('%s', (kernel) => {
      it('should embed the kernel-specific top-level export example from KernelConfig.topLevelExportExample', async () => {
        const config = getKernelConfig(kernel);
        const result = await getCadSystemPrompt(kernel, 'agent', true);
        const block = extractTestRequirementsBlock(result.static);
        expect(block).toContain(config.topLevelExportExample);
      });

      it('should NOT instruct the agent to remove files from test.json', async () => {
        const result = await getCadSystemPrompt(kernel, 'agent', true);
        const block = extractTestRequirementsBlock(result.static);
        expect(block).not.toMatch(/remove .* from test\.json/i);
        expect(block).not.toMatch(/skip(?:ping)? the test/i);
      });

      it('should NOT bake in OpenSCAD-only "modules / functions" copy on non-OpenSCAD kernels', async () => {
        if (kernel === 'openscad') {
          return;
        }
        const result = await getCadSystemPrompt(kernel, 'agent', true);
        const block = extractTestRequirementsBlock(result.static);
        expect(block).not.toMatch(/modules?\s*\/\s*functions?/i);
        expect(block).not.toMatch(/lib\/\S*\.scad/i);
      });

      it('should NOT use "compilation unit" or the "CU" acronym', async () => {
        const result = await getCadSystemPrompt(kernel, 'agent', true);
        const block = extractTestRequirementsBlock(result.static);
        expect(block).not.toMatch(/compilation unit|\bCU\b/);
      });

      it('should encourage adding more tests rather than removing entries', async () => {
        const result = await getCadSystemPrompt(kernel, 'agent', true);
        const block = extractTestRequirementsBlock(result.static);
        expect(block).toMatch(/add|cover|prefer/i);
      });
    });

    it('should not include the top-level-export guidance when testing is disabled', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', false);
      expect(result.static).not.toContain('<test_requirements>');
    });
  });

  // ===================================================================
  // Multi-shape pattern guidance for Replicad-style kernels
  // ===================================================================

  describe('<multi_shape_pattern> for kernels with a multi-shape return type', () => {
    const nonReplicadKernels: readonly KernelProvider[] = ['openscad', 'jscad', 'manifold', 'opencascadejs', 'zoo'];

    it('should embed a Multi-shape pattern section in the Replicad prompt showing ShapeConfig[]', async () => {
      const result = await getCadSystemPrompt('replicad', 'agent', true);
      expect(result.static).toContain('<multi_shape_pattern>');
      expect(result.static).toContain('ShapeConfig[]');
    });

    it('should explicitly note that connectedComponents:1 is appropriate when ShapeConfig parts touch', async () => {
      const result = await getCadSystemPrompt('replicad', 'agent', true);
      const block = result.static.slice(
        result.static.indexOf('<multi_shape_pattern>'),
        result.static.indexOf('</multi_shape_pattern>'),
      );
      expect(block).toContain('connectedComponents');
      expect(block).toMatch(/touch/i);
      expect(block).toMatch(/count":\s*1|count: 1/);
    });

    describe.each(nonReplicadKernels)('%s', (kernel) => {
      it('should NOT include the Multi-shape pattern section', async () => {
        const result = await getCadSystemPrompt(kernel, 'agent', true);
        expect(result.static).not.toContain('<multi_shape_pattern>');
      });
    });
  });

  // ===================================================================
  // Multi-file pattern guidance (per-kernel idiomatic library imports)
  //   Source: dollhouse `include`-duplicate smoking gun — `include <…>`
  //   re-emits every top-level invocation in the imported file, so a
  //   standalone `dollhouse_base()` call inside `lib/base.scad` renders
  //   alongside the assembled house. Each kernel ships a minimal
  //   multi-file canonical example so the agent mirrors the correct
  //   import token rather than guessing.
  // ===================================================================

  describe('<multi_file_pattern> for every kernel', () => {
    const allKernels: readonly KernelProvider[] = ['openscad', 'replicad', 'jscad', 'manifold', 'opencascadejs', 'zoo'];

    describe.each(allKernels)('%s', (kernel) => {
      it('should embed a <multi_file_pattern> section in the static prompt', async () => {
        const result = await getCadSystemPrompt(kernel, 'agent', true);
        expect(result.static).toContain('<multi_file_pattern>');
        expect(result.static).toContain('</multi_file_pattern>');
      });

      it('should embed each declared file path verbatim', async () => {
        const config = getKernelConfig(kernel);
        const example = config.multiFileExample;
        if (!example) {
          throw new Error(`${kernel} must ship multiFileExample`);
        }
        const result = await getCadSystemPrompt(kernel, 'agent', true);
        const block = result.static.slice(
          result.static.indexOf('<multi_file_pattern>'),
          result.static.indexOf('</multi_file_pattern>'),
        );
        for (const file of example.files) {
          expect(block).toContain(`\`${file.path}\``);
        }
      });

      it('should NOT leak into the dynamic prompt', async () => {
        const result = await getCadSystemPrompt(kernel, 'agent', true);
        expect(result.dynamic).not.toContain('<multi_file_pattern>');
      });
    });

    it('should render OpenSCAD with `use <…>` and never `include <…>` (regression guard)', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true);
      const block = result.static.slice(
        result.static.indexOf('<multi_file_pattern>'),
        result.static.indexOf('</multi_file_pattern>'),
      );
      expect(block).toMatch(/use\s*</);
      expect(block).not.toMatch(/include\s*</);
    });

    it("should render TS-based kernels with `from './lib/<name>.js'` ESM relative imports", async () => {
      const tsKernels = ['replicad', 'jscad', 'manifold', 'opencascadejs'] as const;
      const results = await Promise.all(tsKernels.map(async (k) => getCadSystemPrompt(k, 'agent', true)));
      for (const result of results) {
        const block = result.static.slice(
          result.static.indexOf('<multi_file_pattern>'),
          result.static.indexOf('</multi_file_pattern>'),
        );
        expect(block).toMatch(/from\s+["']\.\/lib\/[\w-]+\.js["']/);
      }
    });

    it('should render KCL flat (no `lib/`) with the `import … from "…"` idiom', async () => {
      const result = await getCadSystemPrompt('zoo', 'agent', true);
      const block = result.static.slice(
        result.static.indexOf('<multi_file_pattern>'),
        result.static.indexOf('</multi_file_pattern>'),
      );
      expect(block).not.toContain('lib/');
      expect(block).toMatch(/import\s+\w+\s+from\s+"[^"]+\.kcl"/);
    });
  });

  // ===================================================================
  // Screenshot frequency cap in <visual_inspection>
  // ===================================================================

  describe('screenshot budget cap', () => {
    it('should cap screenshots at 2 per inspection cycle inside <visual_inspection>', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(
        result.static.indexOf('<visual_inspection>'),
        result.static.indexOf('</visual_inspection>'),
      );
      expect(block).toMatch(/at most 2 screenshots/i);
    });

    it('should warn against chaining a single screenshot after multi_angle', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(
        result.static.indexOf('<visual_inspection>'),
        result.static.indexOf('</visual_inspection>'),
      );
      expect(block).toMatch(/multi_angle/);
      expect(block).toMatch(/six orthographic views/i);
    });
  });

  // ===================================================================
  // <tool_usage_policy> static section
  // ===================================================================

  describe('tool usage policy', () => {
    it('should include a <tool_usage_policy> static section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toContain('<tool_usage_policy>');
      expect(result.static).toContain('</tool_usage_policy>');
    });

    it('should instruct to call independent tools in parallel and dependent ones sequentially', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(
        result.static.indexOf('<tool_usage_policy>'),
        result.static.indexOf('</tool_usage_policy>'),
      );
      expect(block).toMatch(/parallel/i);
      expect(block).toMatch(/sequentially/i);
    });

    it('should forbid placeholder values in tool calls', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(
        result.static.indexOf('<tool_usage_policy>'),
        result.static.indexOf('</tool_usage_policy>'),
      );
      expect(block).toMatch(/never use placeholders/i);
    });

    it('should direct the agent to prefer offset and limit for large source reads', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(
        result.static.indexOf('<tool_usage_policy>'),
        result.static.indexOf('</tool_usage_policy>'),
      );
      expect(block).toMatch(/prefer `offset` \+ `limit`/);
      expect(block).toMatch(/>2000 lines/);
    });

    it('should direct the agent to use narrow grep + headLimit before read_file on dense generated code', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(
        result.static.indexOf('<tool_usage_policy>'),
        result.static.indexOf('</tool_usage_policy>'),
      );
      expect(block).toMatch(/narrow regex/);
      expect(block).toMatch(/headLimit/);
      expect(block).toMatch(/most-relevant ranges/);
    });

    it('should endorse node_modules as the canonical location for third-party reads', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(
        result.static.indexOf('<tool_usage_policy>'),
        result.static.indexOf('</tool_usage_policy>'),
      );
      expect(block).toMatch(/node_modules\//);
      expect(block).toMatch(/canonical location/);
      expect(block).toMatch(/read it freely/);
    });

    it('should NOT appear in dynamic section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.dynamic).not.toContain('<tool_usage_policy>');
    });
  });

  // ===================================================================
  // Faithful-reporting bullet in <constraints>
  // ===================================================================

  describe('faithful reporting', () => {
    it('should include a faithful-reporting bullet inside <constraints>', async () => {
      const result = await getCadSystemPrompt('openscad');
      const constraintsBlock = result.static.slice(
        result.static.indexOf('<constraints>'),
        result.static.indexOf('</constraints>'),
      );
      expect(constraintsBlock).toContain('Report outcomes faithfully');
      expect(constraintsBlock).toContain('"all tests pass"');
      expect(constraintsBlock).toContain('incomplete work as done');
      expect(constraintsBlock).toContain('without hedging');
    });
  });

  // ===================================================================
  // Diagnose-before-switching guidance in <error_handling>
  //   Source: claude-code repos/claude-code/src/constants/prompts.ts:233
  // ===================================================================

  describe('diagnose-before-switching tactics', () => {
    it('should tell the model to diagnose before switching tactics inside <error_handling>', async () => {
      const result = await getCadSystemPrompt('openscad');
      const errorBlock = result.static.slice(
        result.static.indexOf('<error_handling>'),
        result.static.indexOf('</error_handling>'),
      );
      expect(errorBlock).toContain('diagnose');
      expect(errorBlock).toContain('switching tactics');
      expect(errorBlock).toContain('identical action');
    });

    it('should NOT contain the deleted "stop after 1-2 retries" guidance', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).not.toContain('stop after 1-2 retries');
    });

    it('should warn against abandoning a viable approach after a single failure', async () => {
      const result = await getCadSystemPrompt('openscad');
      const errorBlock = result.static.slice(
        result.static.indexOf('<error_handling>'),
        result.static.indexOf('</error_handling>'),
      );
      expect(errorBlock).toMatch(/single failure/i);
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

  // ===================================================================
  // Destructive-action <safety> static section
  // ===================================================================

  describe('<safety> static section', () => {
    it('should include a <safety> static section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toContain('<safety>');
      expect(result.static).toContain('</safety>');
    });

    it('should warn before delete_file removes a referenced file', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(result.static.indexOf('<safety>'), result.static.indexOf('</safety>'));
      expect(block).toMatch(/delete_file/);
      expect(block).toMatch(/referenced/);
    });

    it('should warn before overwriting a previously-committed export artifact', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(result.static.indexOf('<safety>'), result.static.indexOf('</safety>'));
      expect(block).toMatch(/overwrit/i);
      expect(block).toMatch(/committed/i);
    });

    it('should warn before mutating a mounted filesystem path', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(result.static.indexOf('<safety>'), result.static.indexOf('</safety>'));
      expect(block).toMatch(/mount/);
    });

    it('should NOT appear in dynamic section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.dynamic).not.toContain('<safety>');
    });
  });

  // ===================================================================
  // Export gate — `export_geometry` is opt-in only
  // ===================================================================

  describe('<safety> export gate', () => {
    const extractSafety = (prompt: string): string =>
      prompt.slice(prompt.indexOf('<safety>'), prompt.indexOf('</safety>'));

    it('should mention export_geometry inside <safety>', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = extractSafety(result.static);
      expect(block).toContain('export_geometry');
    });

    it('should require an explicit user request before calling export_geometry', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = extractSafety(result.static);
      expect(block).toMatch(/explicitly ask/i);
    });

    it('should follow the `Before X, confirm Y` style used by other safety bullets', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = extractSafety(result.static);
      expect(block).toMatch(/Before calling `export_geometry`, confirm/);
      expect(block).not.toMatch(/Never call `export_geometry`/);
    });

    it('should still keep the previously-committed-overwrite warning', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = extractSafety(result.static);
      expect(block).toMatch(/overwrit/i);
      expect(block).toMatch(/committed/i);
    });
  });

  describe('workflow does not list export as a step', () => {
    const extractWorkflow = (prompt: string): string =>
      prompt.slice(prompt.indexOf('<workflow>'), prompt.indexOf('</workflow>'));

    it('should not list export_geometry inside the workflow when testing enabled', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true);
      const block = extractWorkflow(result.static);
      expect(block).not.toContain('export_geometry');
      expect(block).not.toContain('exportGeometry');
      expect(block).not.toContain('Deliver interchange');
    });

    it('should not list export_geometry inside the workflow when testing disabled', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', false);
      const block = extractWorkflow(result.static);
      expect(block).not.toContain('export_geometry');
      expect(block).not.toContain('exportGeometry');
      expect(block).not.toContain('Deliver interchange');
    });
  });

  // ===================================================================
  // <system_rules> (no-identical-retry on denial, URL guard)
  // ===================================================================

  describe('<system_rules> static section', () => {
    it('should include a <system_rules> static section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.static).toContain('<system_rules>');
      expect(result.static).toContain('</system_rules>');
    });

    it('should forbid re-attempting the identical call after a denial / permission error', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(
        result.static.indexOf('<system_rules>'),
        result.static.indexOf('</system_rules>'),
      );
      expect(block).toMatch(/denial or permission error/i);
      expect(block).toMatch(/identical call/i);
    });

    it('should forbid inventing URLs', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(
        result.static.indexOf('<system_rules>'),
        result.static.indexOf('</system_rules>'),
      );
      expect(block).toMatch(/Never invent URLs/);
      expect(block).toMatch(/web_search/);
    });

    it('should NOT appear in dynamic section', async () => {
      const result = await getCadSystemPrompt('openscad');
      expect(result.dynamic).not.toContain('<system_rules>');
    });
  });

  // ===================================================================
  // Self-grounded verification prepend in <visual_inspection>
  // ===================================================================

  describe('self-grounded verification', () => {
    it('should require predicting expected properties before taking the screenshot', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(
        result.static.indexOf('<visual_inspection>'),
        result.static.indexOf('</visual_inspection>'),
      );
      expect(block).toMatch(/predict the expected properties/i);
      expect(block).toMatch(/vertex-count range/i);
      expect(block).toMatch(/bounding box/i);
      expect(block).toMatch(/silhouette/i);
    });

    it('should require comparing prediction against actual render', async () => {
      const result = await getCadSystemPrompt('openscad');
      const block = result.static.slice(
        result.static.indexOf('<visual_inspection>'),
        result.static.indexOf('</visual_inspection>'),
      );
      expect(block).toMatch(/Compare against the actual render/);
    });
  });

  // ===================================================================
  // Iterative verification loop — universal, no <complex_task> dep
  // ===================================================================

  describe('iterative verification loop', () => {
    it('should require re-render on any defect found in the inspect step (testing enabled)', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true);
      const workflow = result.static.slice(result.static.indexOf('<workflow>'), result.static.indexOf('</workflow>'));
      expect(workflow).toMatch(/re-render/i);
      expect(workflow).toMatch(/Continue iterating until no defects remain/);
    });

    it('should require re-render on any defect found in the inspect step (testing disabled)', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', false);
      const workflow = result.static.slice(result.static.indexOf('<workflow>'), result.static.indexOf('</workflow>'));
      expect(workflow).toMatch(/re-render/i);
      expect(workflow).toMatch(/Continue iterating until no defects remain/);
    });

    it('should NOT reference the deferred <complex_task> tag or "2 cycles" sub-rule', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true);
      const workflow = result.static.slice(result.static.indexOf('<workflow>'), result.static.indexOf('</workflow>'));
      expect(workflow).not.toContain('complex_task');
      expect(workflow).not.toMatch(/2 cycles/i);
    });
  });

  // ===================================================================
  // Workflow step 0 (decompose) — universal, no <complex_task> dep
  // ===================================================================

  describe('workflow step 0 (decompose)', () => {
    it('should prepend a step 0 (Decompose) to the workflow when testing enabled', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true);
      const workflow = result.static.slice(result.static.indexOf('<workflow>'), result.static.indexOf('</workflow>'));
      expect(workflow).toMatch(/0\.\s*\*\*Decompose\*\*/);
      expect(workflow).toMatch(/multi-component/i);
    });

    it('should preserve workflow numbering through step 6 when testing enabled', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true);
      const workflow = result.static.slice(result.static.indexOf('<workflow>'), result.static.indexOf('</workflow>'));
      for (const stepNumber of [0, 1, 2, 3, 4, 5, 6]) {
        expect(workflow).toMatch(new RegExp(`${stepNumber}\\.\\s\\*\\*`));
      }
    });

    it('should include a "skip when single shape / trivial parameter change" escape hatch', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true);
      const workflow = result.static.slice(result.static.indexOf('<workflow>'), result.static.indexOf('</workflow>'));
      expect(workflow).toMatch(/skip when/i);
      expect(workflow).toMatch(/single shape|trivial parameter/i);
    });

    it('should NOT reference the deferred <complex_task> tag', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true);
      const workflow = result.static.slice(result.static.indexOf('<workflow>'), result.static.indexOf('</workflow>'));
      expect(workflow).not.toContain('<complex_task>');
      expect(workflow).not.toContain('complex_task');
    });

    it('should still prepend step 0 when testing is disabled', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', false);
      const workflow = result.static.slice(result.static.indexOf('<workflow>'), result.static.indexOf('</workflow>'));
      expect(workflow).toMatch(/0\.\s*\*\*Decompose\*\*/);
    });
  });

  // ===================================================================
  // Plan-mode strictness
  //   Source: claude-code system-reminder-plan-mode-is-active-iterative.md L12
  // ===================================================================

  describe('plan-mode strictness', () => {
    it('should forbid all non-readonly tool calls except .plan.md edit when in plan mode', async () => {
      const result = await getCadSystemPrompt('openscad', 'plan');
      const block = result.static.slice(result.static.indexOf('<plan_mode>'), result.static.indexOf('</plan_mode>'));
      expect(block).toMatch(/MUST NOT make any edits/);
      expect(block).toMatch(/non-readonly tools/i);
      expect(block).toMatch(/\.plan\.md/);
    });

    it('should state that the plan-mode rules supersede other instructions', async () => {
      const result = await getCadSystemPrompt('openscad', 'plan');
      const block = result.static.slice(result.static.indexOf('<plan_mode>'), result.static.indexOf('</plan_mode>'));
      expect(block).toMatch(/supersedes/i);
    });

    it('should NOT include the plan-mode block when mode is agent', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent');
      expect(result.static).not.toContain('<plan_mode>');
      expect(result.static).not.toContain('MUST NOT make any edits');
    });

    it('should still tell the model to stop after creating the plan', async () => {
      const result = await getCadSystemPrompt('openscad', 'plan');
      const block = result.static.slice(result.static.indexOf('<plan_mode>'), result.static.indexOf('</plan_mode>'));
      expect(block).toMatch(/Stop after creating the plan/);
    });
  });

  // ===================================================================
  // Multi-file test.json migration
  // ===================================================================

  describe('multi-file test.json shape in <test_requirements>', () => {
    const extractTestRequirements = (prompt: string) =>
      /<test_requirements>([\S\s]*?)<\/test_requirements>/.exec(prompt)?.[1] ?? '';

    it('should embed the multi-file test.json shape in <test_requirements>', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true);
      const block = extractTestRequirements(result.static);

      // The fenced JSON example must contain a quoted source-path key
      // (e.g. "main.ts" / "main.scad") at the top level
      expect(block).toMatch(/"main\.\w+"\s*:\s*{/);
      // The JSON example must NOT start with a flat top-level { "requirements": [...] }
      // — every example requires a source-file-path key at the top.
      const jsonExample = /```json\s*([\S\s]*?)```/.exec(block)?.[1] ?? '';
      expect(jsonExample).not.toMatch(/^\s*{\s*"requirements"\s*:/);
    });

    it('should explain that adding a new file requires a new key, not deleting existing ones', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true);
      const block = extractTestRequirements(result.static);
      expect(block).toMatch(/per[ -]file|keyed by source file/i);
      expect(block).toMatch(/preserve|never delete|do not delete|keep sibling/i);
    });

    it('should embed exactly the 3-check vocabulary in the canonical example (no meshCount/vertexCount)', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true);
      const block = extractTestRequirements(result.static);
      expect(block).toContain('boundingBox');
      expect(block).toContain('connectedComponents');
      expect(block).toContain('watertight');
      expect(block).not.toContain('meshCount');
      expect(block).not.toContain('vertexCount');
    });

    it('should describe the 3 checks with their unique-question framing and the connectedComponents tolerance knob', async () => {
      const result = await getCadSystemPrompt('openscad', 'agent', true);
      const block = extractTestRequirements(result.static);
      expect(block).toMatch(/Available checks/);
      expect(block).toContain('SIZE / POSITION');
      expect(block).toContain('SPATIALLY-DISJOINT CHUNKS');
      expect(block).toContain('CLOSED (manifold / 3D-printable)');
      expect(block).toContain('tolerance');
      expect(block).toContain('default 0.1');
    });
  });

  // ===================================================================
  // <error_handling> guidance for connectedComponents failures
  // ===================================================================

  describe('<error_handling> stops prescribing screenshots for connectedComponents failures', () => {
    const extractErrorHandling = (prompt: string) =>
      /<error_handling>([\S\s]*?)<\/error_handling>/.exec(prompt)?.[1] ?? '';

    it('should not tell the agent to use screenshot for connectedComponents failures', async () => {
      const result = await getCadSystemPrompt('replicad', 'agent', true);
      const block = extractErrorHandling(result.static);
      expect(block).not.toMatch(/screenshot[^.]*connectedComponents/);
      expect(block).not.toMatch(/connectedComponents[^.]*screenshot/);
    });

    it('should encourage diagnosing whether the requirement still matches the agent intent', async () => {
      const result = await getCadSystemPrompt('replicad', 'agent', true);
      const block = extractErrorHandling(result.static);
      expect(block).toMatch(/intent|tolerance/i);
    });
  });

  // ===================================================================
  // Per-section telemetry hook
  // ===================================================================

  describe('onSectionResolved telemetry callback', () => {
    it('should invoke onSectionResolved for every non-empty static section (incl. role and workflow)', async () => {
      const onSectionResolved = vi.fn();
      await getCadSystemPrompt('openscad', 'agent', true, { onSectionResolved });

      const calls = onSectionResolved.mock.calls.map(([resolved]) => resolved as { name: string; cacheBreak: boolean });
      const names = new Set(calls.map((c) => c.name));

      expect(names).toContain('role');
      expect(names).toContain('workflow');
      expect(names).toContain('constraints');
      expect(names).toContain('tone');
    });

    it('should tag dynamic sections with cacheBreak: true and static ones with cacheBreak: false', async () => {
      const onSectionResolved = vi.fn();
      await getCadSystemPrompt('openscad', 'agent', true, {
        onSectionResolved,
        chatId: 'chat-r23',
        modelId: 'm-r23',
        contextWindow: 200_000,
      });

      const calls = onSectionResolved.mock.calls.map(([resolved]) => resolved as { name: string; cacheBreak: boolean });
      const role = calls.find((c) => c.name === 'role');
      const environment = calls.find((c) => c.name === 'environment');
      const transcriptPath = calls.find((c) => c.name === 'transcript_path');

      expect(role?.cacheBreak).toBe(false);
      expect(environment?.cacheBreak).toBe(true);
      expect(transcriptPath?.cacheBreak).toBe(true);
    });

    it('should report positive byte sizes for every observation', async () => {
      const onSectionResolved = vi.fn();
      await getCadSystemPrompt('openscad', 'agent', true, { onSectionResolved });

      for (const [resolved] of onSectionResolved.mock.calls) {
        const observation = resolved as { name: string; byteSize: number };
        expect(observation.byteSize).toBeGreaterThan(0);
      }
    });
  });
});
