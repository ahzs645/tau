// @vitest-environment node
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { KernelProvider } from '@taucad/runtime';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { toolName } from '@taucad/chat/constants';
import { ToolService } from '#api/tools/tool.service.js';
import { getKernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.js';

const allKernels: readonly KernelProvider[] = ['openscad', 'replicad', 'jscad', 'manifold', 'opencascadejs', 'zoo'];

describe('ToolService.getTools', () => {
  let service: ToolService;
  let module: TestingModule;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ToolService, { provide: ConfigService, useValue: { get: vi.fn(() => 'fake-tavily-key') } }],
    }).compile();
    service = moduleRef.get<ToolService>(ToolService);
    module = moduleRef;
  });

  afterEach(async () => {
    await module.close();
  });

  describe.each(allKernels)('%s kernel', (kernel) => {
    it('routes the kernel to the edit_tests tool description (kernel-native file extension)', () => {
      const { tools } = service.getTools('auto', kernel);
      const description = tools[toolName.editTests]?.description ?? '';
      const config = getKernelConfig(kernel);
      const exampleKeyPattern = new RegExp(`"main\\${config.fileExtension}"`);
      expect(description).toMatch(exampleKeyPattern);
    });
  });

  describe('per-kernel cache', () => {
    it('returns the same tool instance across repeated calls for the same kernel', () => {
      const a = service.getTools('auto', 'openscad').tools[toolName.testModel];
      const b = service.getTools('auto', 'openscad').tools[toolName.testModel];
      expect(a).toBeDefined();
      expect(a).toBe(b);
    });

    it('returns distinct tool instances for different kernels', () => {
      const openscadTool = service.getTools('auto', 'openscad').tools[toolName.testModel];
      const replicadTool = service.getTools('auto', 'replicad').tools[toolName.testModel];
      expect(openscadTool).toBeDefined();
      expect(replicadTool).toBeDefined();
      expect(openscadTool).not.toBe(replicadTool);
    });

    it('caches the edit_tests tool per kernel as well', () => {
      const a = service.getTools('auto', 'replicad').tools[toolName.editTests];
      const b = service.getTools('auto', 'replicad').tools[toolName.editTests];
      expect(a).toBeDefined();
      expect(a).toBe(b);
    });
  });

  describe('selection passthrough', () => {
    it('returns resolvedToolChoice for plain choice values', () => {
      const { resolvedToolChoice } = service.getTools('auto', 'openscad');
      expect(resolvedToolChoice).toBe('auto');
    });

    it('filters tools when an array choice is provided', () => {
      const { tools, resolvedToolChoice } = service.getTools([toolName.testModel], 'openscad');
      expect(Object.keys(tools)).toEqual([toolName.testModel]);
      expect(resolvedToolChoice).toBe('required');
    });
  });
});
