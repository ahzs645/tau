// @vitest-environment node
/* eslint-disable @typescript-eslint/naming-convention -- file-path keys (e.g. 'main.ts') aren't camelCase */
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ToolRuntime } from '@langchain/core/tools';
import { ToolError } from '@taucad/chat/utils';
import { rpcName } from '@taucad/chat/constants';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';
import { editTestsTool } from '#api/tools/tools/tool-edit-tests.js';

type RpcResult = Awaited<ReturnType<ChatRpcConfigurable['chatRpcService']['sendRpcRequest']>>;
type EditResult = Awaited<ReturnType<ChatRpcConfigurable['fileEditService']['applyFileEdit']>>;

const callTool = async (configurable: ChatRpcConfigurable, codeEdit = '// edit') => {
  const runtime = mock<ToolRuntime>({
    toolCallId: 'tc-edit',
    configurable: configurable as unknown as Record<string, unknown>,
  });
  const tool = editTestsTool as unknown as {
    invoke(input: { codeEdit: string }, runtime: ToolRuntime): Promise<unknown>;
  };
  return tool.invoke({ codeEdit }, runtime);
};

const buildConfigurable = (): ChatRpcConfigurable => ({
  chatRpcService: mock<ChatRpcConfigurable['chatRpcService']>(),
  fileEditService: mock<ChatRpcConfigurable['fileEditService']>(),
  geometryAnalysisService: mock<ChatRpcConfigurable['geometryAnalysisService']>(),
  thread_id: 'chat-1',
});

describe('editTestsTool', () => {
  it('should write the Morph result back when it parses against testFileSchema', async () => {
    const cfg = buildConfigurable();
    const validContent = JSON.stringify({
      'main.ts': {
        requirements: [{ id: 'r1', type: 'measurement', description: 'd', check: 'meshCount', expected: { count: 1 } }],
      },
    });

    vi.mocked(cfg.chatRpcService.sendRpcRequest).mockImplementation(async ({ rpcName: r }) => {
      if (r === rpcName.readFile) {
        return { success: true, content: '{}' } as unknown as RpcResult;
      }
      if (r === rpcName.createFile) {
        return { success: true } as unknown as RpcResult;
      }
      throw new Error(`Unexpected RPC: ${r}`);
    });

    vi.mocked(cfg.fileEditService.applyFileEdit).mockResolvedValue({
      success: true,
      editedContent: validContent,
      diffStats: { linesAdded: 1, linesRemoved: 0 },
    } as unknown as EditResult);

    await callTool(cfg);

    const writeCall = vi
      .mocked(cfg.chatRpcService.sendRpcRequest)
      .mock.calls.find((c) => c[0].rpcName === rpcName.createFile);
    expect(writeCall).toBeDefined();
    expect((writeCall![0].args as { content: string }).content).toBe(validContent);
  });

  it('should throw ToolError listing Zod issues when Morph result fails schema validation', async () => {
    const cfg = buildConfigurable();
    vi.mocked(cfg.chatRpcService.sendRpcRequest).mockResolvedValue({
      success: true,
      content: '{}',
    } as unknown as RpcResult);

    vi.mocked(cfg.fileEditService.applyFileEdit).mockResolvedValue({
      success: true,
      editedContent: JSON.stringify({ requirements: [] }),
      diffStats: { linesAdded: 0, linesRemoved: 0 },
    } as unknown as EditResult);

    try {
      await callTool(cfg);
      expect.fail('expected ToolError');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const { message } = (error as ToolError).data;
      expect(message).toMatch(/per[ -]file|invalid/i);
    }

    const writeCalls = vi
      .mocked(cfg.chatRpcService.sendRpcRequest)
      .mock.calls.filter((c) => c[0].rpcName === rpcName.createFile);
    expect(writeCalls).toHaveLength(0);
  });

  it('should use the multi-file default content when readFile returns FILE_NOT_FOUND', async () => {
    const cfg = buildConfigurable();
    vi.mocked(cfg.chatRpcService.sendRpcRequest).mockImplementation(async ({ rpcName: r }) => {
      if (r === rpcName.readFile) {
        return { success: false, errorCode: 'FILE_NOT_FOUND', message: 'no file' } as unknown as RpcResult;
      }
      if (r === rpcName.createFile) {
        return { success: true } as unknown as RpcResult;
      }
      throw new Error(`Unexpected RPC: ${r}`);
    });

    vi.mocked(cfg.fileEditService.applyFileEdit).mockResolvedValue({
      success: true,
      editedContent: JSON.stringify({}),
      diffStats: { linesAdded: 0, linesRemoved: 0 },
    } as unknown as EditResult);

    await callTool(cfg);

    const editCall = vi.mocked(cfg.fileEditService.applyFileEdit).mock.calls[0]?.[0];
    expect(editCall?.originalContent).toBeDefined();
    const parsed = JSON.parse(editCall!.originalContent) as Record<string, unknown>;
    expect(parsed).toEqual({});
    expect(Array.isArray(parsed.requirements)).toBe(false);
  });

  it('should propagate ToolError when readFile returns a non-FILE_NOT_FOUND client error', async () => {
    const cfg = buildConfigurable();
    vi.mocked(cfg.chatRpcService.sendRpcRequest).mockResolvedValue({
      success: false,
      errorCode: 'PERMISSION_DENIED',
      message: 'denied',
    } as unknown as RpcResult);

    try {
      await callTool(cfg);
      expect.fail('expected ToolError');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).data.message).toMatch(/denied|cannot read/i);
    }
  });

  it('should propagate ToolError with edit failure message when Morph apply fails', async () => {
    const cfg = buildConfigurable();
    vi.mocked(cfg.chatRpcService.sendRpcRequest).mockResolvedValue({
      success: true,
      content: '{}',
    } as unknown as RpcResult);
    vi.mocked(cfg.fileEditService.applyFileEdit).mockResolvedValue({
      success: false,
      error: 'morph blew up',
    } as unknown as EditResult);

    try {
      await callTool(cfg);
      expect.fail('expected ToolError');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).data.message).toMatch(/morph blew up/);
    }
  });
});
