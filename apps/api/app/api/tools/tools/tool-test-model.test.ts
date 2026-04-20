// @vitest-environment node
/* eslint-disable @typescript-eslint/naming-convention -- file-path keys (e.g. 'main.ts') aren't camelCase */
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ToolRuntime } from '@langchain/core/tools';
import { ToolError } from '@taucad/chat/utils';
import { rpcName } from '@taucad/chat/constants';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';
import { testModelTool } from '#api/tools/tools/tool-test-model.js';

type RpcResult = Awaited<ReturnType<ChatRpcConfigurable['chatRpcService']['sendRpcRequest']>>;

const callTool = async (configurable: ChatRpcConfigurable, toolCallId = 'tc-1') => {
  const runtime = mock<ToolRuntime>({ toolCallId, configurable: configurable as unknown as Record<string, unknown> });

  const tool = testModelTool as unknown as {
    invoke(input: Record<string, never>, runtime: ToolRuntime): Promise<unknown>;
  };

  return tool.invoke({}, runtime);
};

const buildConfigurable = (overrides?: Partial<ChatRpcConfigurable>): ChatRpcConfigurable => {
  const chatRpcService = mock<ChatRpcConfigurable['chatRpcService']>();
  const geometryAnalysisService = mock<ChatRpcConfigurable['geometryAnalysisService']>();
  const fileEditService = mock<ChatRpcConfigurable['fileEditService']>();

  return {
    chatRpcService,
    geometryAnalysisService,
    fileEditService,
    thread_id: 'chat-1',
    ...overrides,
  };
};

const buildTestFileContent = (entries: Record<string, Array<{ id: string; check: 'meshCount'; count: number }>>) => {
  const map: Record<string, { requirements: unknown[] }> = {};
  for (const [file, reqs] of Object.entries(entries)) {
    map[file] = {
      requirements: reqs.map((r) => ({
        id: r.id,
        type: 'measurement',
        description: `${r.id} description`,
        check: r.check,
        expected: { count: r.count },
      })),
    };
  }
  return JSON.stringify(map);
};

describe('testModelTool', () => {
  describe('per-CU fan-out', () => {
    it('should fan out fetchGeometry one call per file in the parsed map', async () => {
      const cfg = buildConfigurable();

      vi.mocked(cfg.chatRpcService.sendRpcRequest).mockImplementation(async ({ rpcName: rpcNameArgument }) => {
        if (rpcNameArgument === rpcName.readFile) {
          return {
            success: true,
            content: buildTestFileContent({
              'main.ts': [{ id: 'r1', check: 'meshCount', count: 1 }],
              'pen.ts': [{ id: 'r2', check: 'meshCount', count: 2 }],
            }),
          } as unknown as RpcResult;
        }
        if (rpcNameArgument === rpcName.fetchGeometry) {
          return {
            success: true,
            glb: new Uint8Array([1, 2, 3]),
            artifactPath: '.tau/artifacts/x.glb',
          } as unknown as RpcResult;
        }
        throw new Error(`Unexpected RPC: ${rpcNameArgument}`);
      });

      vi.mocked(cfg.geometryAnalysisService.runMeasurementTests).mockResolvedValue({
        failures: [],
        passes: [],
        passed: 0,
        total: 0,
      });

      await callTool(cfg);

      const fetchCalls = vi
        .mocked(cfg.chatRpcService.sendRpcRequest)
        .mock.calls.filter((c) => c[0].rpcName === rpcName.fetchGeometry);
      expect(fetchCalls).toHaveLength(2);
      const targetFiles = fetchCalls.map((c) => (c[0].args as { targetFile: string }).targetFile);
      expect(targetFiles.sort()).toEqual(['main.ts', 'pen.ts']);
    });

    it('should pass each file requirements only to its own runMeasurementTests call', async () => {
      const cfg = buildConfigurable();

      vi.mocked(cfg.chatRpcService.sendRpcRequest).mockImplementation(async ({ rpcName: rpcNameArgument, args }) => {
        if (rpcNameArgument === rpcName.readFile) {
          return {
            success: true,
            content: buildTestFileContent({
              'main.ts': [{ id: 'r1', check: 'meshCount', count: 1 }],
              'pen.ts': [{ id: 'r2', check: 'meshCount', count: 2 }],
            }),
          } as unknown as RpcResult;
        }
        if (rpcNameArgument === rpcName.fetchGeometry) {
          const tag = (args as { targetFile: string }).targetFile;
          const glb = new TextEncoder().encode(tag);
          return { success: true, glb, artifactPath: `.tau/artifacts/${tag}.glb` } as unknown as RpcResult;
        }
        throw new Error(`Unexpected RPC: ${rpcNameArgument}`);
      });

      vi.mocked(cfg.geometryAnalysisService.runMeasurementTests).mockImplementation(
        async (_glb, requirements, targetFile) => ({
          failures: [],
          passes: requirements.map((r) => ({ id: r.id, requirement: r.description, targetFile })),
          passed: requirements.length,
          total: requirements.length,
        }),
      );

      await callTool(cfg);

      const { calls } = vi.mocked(cfg.geometryAnalysisService.runMeasurementTests).mock;
      expect(calls).toHaveLength(2);

      const byTarget = new Map(calls.map((c) => [c[2], c[1]]));
      expect(byTarget.get('main.ts')?.[0]?.id).toBe('r1');
      expect(byTarget.get('pen.ts')?.[0]?.id).toBe('r2');
    });

    it('should tag every failure and pass with its originating targetFile', async () => {
      const cfg = buildConfigurable();

      vi.mocked(cfg.chatRpcService.sendRpcRequest).mockImplementation(async ({ rpcName: rpcNameArgument }) => {
        if (rpcNameArgument === rpcName.readFile) {
          return {
            success: true,
            content: buildTestFileContent({
              'main.ts': [{ id: 'r1', check: 'meshCount', count: 1 }],
              'pen.ts': [{ id: 'r2', check: 'meshCount', count: 2 }],
            }),
          } as unknown as RpcResult;
        }
        if (rpcNameArgument === rpcName.fetchGeometry) {
          return {
            success: true,
            glb: new Uint8Array([1]),
            artifactPath: '.tau/artifacts/x.glb',
          } as unknown as RpcResult;
        }
        throw new Error(`Unexpected RPC: ${rpcNameArgument}`);
      });

      vi.mocked(cfg.geometryAnalysisService.runMeasurementTests).mockImplementation(
        async (_glb, requirements, targetFile) => ({
          failures: requirements.map((r) => ({
            id: r.id,
            requirement: r.description,
            reason: 'mismatch',
            suggestion: 'fix',
            targetFile,
          })),
          passes: [],
          passed: 0,
          total: requirements.length,
        }),
      );

      const result = (await callTool(cfg)) as {
        failures: Array<{ targetFile: string; id: string }>;
        passes: Array<{ targetFile: string; id: string }>;
      };

      expect(result.failures).toHaveLength(2);
      const targets = result.failures.map((f) => f.targetFile).sort();
      expect(targets).toEqual(['main.ts', 'pen.ts']);
    });

    it('should aggregate passed/total across all files', async () => {
      const cfg = buildConfigurable();

      vi.mocked(cfg.chatRpcService.sendRpcRequest).mockImplementation(async ({ rpcName: rpcNameArgument }) => {
        if (rpcNameArgument === rpcName.readFile) {
          return {
            success: true,
            content: buildTestFileContent({
              'main.ts': [{ id: 'r1', check: 'meshCount', count: 1 }],
              'pen.ts': [
                { id: 'r2', check: 'meshCount', count: 2 },
                { id: 'r3', check: 'meshCount', count: 3 },
              ],
            }),
          } as unknown as RpcResult;
        }
        if (rpcNameArgument === rpcName.fetchGeometry) {
          return {
            success: true,
            glb: new Uint8Array([1]),
            artifactPath: '.tau/artifacts/x.glb',
          } as unknown as RpcResult;
        }
        throw new Error(`Unexpected RPC: ${rpcNameArgument}`);
      });

      vi.mocked(cfg.geometryAnalysisService.runMeasurementTests).mockImplementation(
        async (_glb, requirements, targetFile) => {
          const half = Math.floor(requirements.length / 2);
          const passes = requirements.slice(0, half).map((r) => ({ id: r.id, requirement: r.description, targetFile }));
          const failures = requirements.slice(half).map((r) => ({
            id: r.id,
            requirement: r.description,
            reason: 'r',
            suggestion: 's',
            targetFile,
          }));
          return { failures, passes, passed: passes.length, total: requirements.length };
        },
      );

      const result = (await callTool(cfg)) as { passed: number; total: number };

      expect(result.total).toBe(3);
      expect(result.passed).toBeGreaterThanOrEqual(0);
    });

    it('should populate geometryArtifactPaths keyed by targetFile', async () => {
      const cfg = buildConfigurable();

      vi.mocked(cfg.chatRpcService.sendRpcRequest).mockImplementation(async ({ rpcName: rpcNameArgument, args }) => {
        if (rpcNameArgument === rpcName.readFile) {
          return {
            success: true,
            content: buildTestFileContent({
              'main.ts': [{ id: 'r1', check: 'meshCount', count: 1 }],
              'pen.ts': [{ id: 'r2', check: 'meshCount', count: 2 }],
            }),
          } as unknown as RpcResult;
        }
        if (rpcNameArgument === rpcName.fetchGeometry) {
          const tag = (args as { targetFile: string }).targetFile;
          return {
            success: true,
            glb: new Uint8Array([1]),
            artifactPath: `.tau/artifacts/tc-1__${tag.replaceAll('.', '_')}.glb`,
          } as unknown as RpcResult;
        }
        throw new Error(`Unexpected RPC: ${rpcNameArgument}`);
      });

      vi.mocked(cfg.geometryAnalysisService.runMeasurementTests).mockResolvedValue({
        failures: [],
        passes: [],
        passed: 0,
        total: 0,
      });

      const result = (await callTool(cfg)) as {
        geometryArtifactPaths?: Record<string, string>;
      };

      expect(result.geometryArtifactPaths).toBeDefined();
      expect(result.geometryArtifactPaths!['main.ts']).toBe('.tau/artifacts/tc-1__main_ts.glb');
      expect(result.geometryArtifactPaths!['pen.ts']).toBe('.tau/artifacts/tc-1__pen_ts.glb');
    });

    it('should run per-file fetches in parallel via Promise.all', async () => {
      const cfg = buildConfigurable();

      let resolveA: (() => void) | undefined;
      let resolveB: (() => void) | undefined;
      const pendingA = new Promise<void>((resolve) => {
        resolveA = resolve;
      });
      const pendingB = new Promise<void>((resolve) => {
        resolveB = resolve;
      });

      let inFlight = 0;
      let maxInFlight = 0;

      vi.mocked(cfg.chatRpcService.sendRpcRequest).mockImplementation(async ({ rpcName: rpcNameArgument, args }) => {
        if (rpcNameArgument === rpcName.readFile) {
          return {
            success: true,
            content: buildTestFileContent({
              'main.ts': [{ id: 'r1', check: 'meshCount', count: 1 }],
              'pen.ts': [{ id: 'r2', check: 'meshCount', count: 2 }],
            }),
          } as unknown as RpcResult;
        }
        if (rpcNameArgument === rpcName.fetchGeometry) {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const tag = (args as { targetFile: string }).targetFile;
          await (tag === 'main.ts' ? pendingA : pendingB);
          inFlight--;
          return {
            success: true,
            glb: new Uint8Array([1]),
            artifactPath: '.tau/artifacts/x.glb',
          } as unknown as RpcResult;
        }
        throw new Error(`Unexpected RPC: ${rpcNameArgument}`);
      });

      vi.mocked(cfg.geometryAnalysisService.runMeasurementTests).mockResolvedValue({
        failures: [],
        passes: [],
        passed: 0,
        total: 0,
      });

      const promise = callTool(cfg);

      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      expect(inFlight).toBe(2);
      resolveA?.();
      resolveB?.();
      await promise;

      expect(maxInFlight).toBe(2);
    });
  });

  describe('error branches', () => {
    it('should return missing_test_file failure when readFile is FILE_NOT_FOUND', async () => {
      const cfg = buildConfigurable();
      vi.mocked(cfg.chatRpcService.sendRpcRequest).mockResolvedValue({
        success: false,
        errorCode: 'FILE_NOT_FOUND',
        message: 'no test.json',
      } as unknown as RpcResult);

      const result = (await callTool(cfg)) as { failures: Array<{ id: string; suggestion: string }> };
      expect(result.failures[0]?.id).toBe('missing_test_file');
      expect(result.failures[0]?.suggestion).toMatch(/edit_tests/);
    });

    it('should return empty_test_file failure when content is empty', async () => {
      const cfg = buildConfigurable();
      vi.mocked(cfg.chatRpcService.sendRpcRequest).mockResolvedValue({
        success: true,
        content: '',
      } as unknown as RpcResult);

      const result = (await callTool(cfg)) as { failures: Array<{ id: string }> };
      expect(result.failures[0]?.id).toBe('empty_test_file');
    });

    it('should return invalid_test_file failure when JSON.parse fails', async () => {
      const cfg = buildConfigurable();
      vi.mocked(cfg.chatRpcService.sendRpcRequest).mockResolvedValue({
        success: true,
        content: '{ not valid json',
      } as unknown as RpcResult);

      const result = (await callTool(cfg)) as { failures: Array<{ id: string; suggestion: string }> };
      expect(result.failures[0]?.id).toBe('invalid_test_file');
      expect(result.failures[0]?.suggestion).toMatch(/per[ -]file|file path/i);
    });

    it('should return invalid_test_file failure when the top level is a flat { requirements: [] } object (no file-path keys)', async () => {
      const cfg = buildConfigurable();
      vi.mocked(cfg.chatRpcService.sendRpcRequest).mockResolvedValue({
        success: true,
        content: JSON.stringify({ requirements: [{ id: 'x', type: 'measurement', check: 'meshCount' }] }),
      } as unknown as RpcResult);

      const result = (await callTool(cfg)) as { failures: Array<{ id: string }> };
      expect(result.failures[0]?.id).toBe('invalid_test_file');
    });

    it('should return no_requirements failure when every file requirements array is empty', async () => {
      const cfg = buildConfigurable();
      vi.mocked(cfg.chatRpcService.sendRpcRequest).mockResolvedValue({
        success: true,
        content: JSON.stringify({ 'main.ts': { requirements: [] }, 'pen.ts': { requirements: [] } }),
      } as unknown as RpcResult);

      const result = (await callTool(cfg)) as { failures: Array<{ id: string }> };
      expect(result.failures[0]?.id).toBe('no_requirements');
    });

    it('should propagate ToolError with structured guidance when a single file fetchGeometry fails', async () => {
      const cfg = buildConfigurable();
      vi.mocked(cfg.chatRpcService.sendRpcRequest).mockImplementation(async ({ rpcName: rpcNameArgument, args }) => {
        if (rpcNameArgument === rpcName.readFile) {
          return {
            success: true,
            content: buildTestFileContent({
              'main.ts': [{ id: 'r1', check: 'meshCount', count: 1 }],
              'pen.ts': [{ id: 'r2', check: 'meshCount', count: 2 }],
            }),
          } as unknown as RpcResult;
        }
        if (rpcNameArgument === rpcName.fetchGeometry) {
          const tag = (args as { targetFile: string }).targetFile;
          if (tag === 'pen.ts') {
            return { success: false, errorCode: 'UNKNOWN_COMPILATION_UNIT', message: 'no CU' } as unknown as RpcResult;
          }
          return { success: true, glb: new Uint8Array([1]), artifactPath: undefined } as unknown as RpcResult;
        }
        throw new Error(`Unexpected RPC: ${rpcNameArgument}`);
      });

      vi.mocked(cfg.geometryAnalysisService.runMeasurementTests).mockResolvedValue({
        failures: [],
        passes: [],
        passed: 0,
        total: 0,
      });

      try {
        await callTool(cfg);
        expect.fail('expected ToolError');
      } catch (error) {
        expect(error).toBeInstanceOf(ToolError);
        const toolError = error as ToolError;
        expect(toolError.data.message).toContain('pen.ts');
        expect(toolError.data.message).toContain('No compilation unit exists for pen.ts');
        expect(toolError.data.message).toContain('get_kernel_result');
      }
    });
  });

  describe('structured fetchGeometry failure messages', () => {
    const mockSingleFileFetchFailure = (cfg: ChatRpcConfigurable, failure: { errorCode: string; message: string }) => {
      vi.mocked(cfg.chatRpcService.sendRpcRequest).mockImplementation(async ({ rpcName: rpcNameArgument }) => {
        if (rpcNameArgument === rpcName.readFile) {
          return {
            success: true,
            content: buildTestFileContent({
              'lib/main_rotor.scad': [{ id: 'r1', check: 'meshCount', count: 1 }],
            }),
          } as unknown as RpcResult;
        }
        if (rpcNameArgument === rpcName.fetchGeometry) {
          return { success: false, ...failure } as unknown as RpcResult;
        }
        throw new Error(`Unexpected RPC: ${rpcNameArgument}`);
      });
    };

    const expectToolErrorMessage = async (cfg: ChatRpcConfigurable, ...substrings: readonly string[]) => {
      try {
        await callTool(cfg);
        expect.fail('expected ToolError');
      } catch (error) {
        expect(error).toBeInstanceOf(ToolError);
        const { message } = (error as ToolError).data;
        for (const substring of substrings) {
          expect(message).toContain(substring);
        }
      }
    };

    it('should surface UNKNOWN_COMPILATION_UNIT with bootstrap guidance', async () => {
      const cfg = buildConfigurable();
      mockSingleFileFetchFailure(cfg, {
        errorCode: 'UNKNOWN_COMPILATION_UNIT',
        message: 'No compilation unit found for lib/main_rotor.scad',
      });

      await expectToolErrorMessage(
        cfg,
        'No compilation unit exists for lib/main_rotor.scad',
        'editor',
        'get_kernel_result',
      );
    });

    it('should surface UNKNOWN/no-GLTF with library-file guidance and edit_tests suggestion', async () => {
      const cfg = buildConfigurable();
      mockSingleFileFetchFailure(cfg, {
        errorCode: 'UNKNOWN',
        message: 'No GLTF geometry available for lib/main_rotor.scad',
      });

      await expectToolErrorMessage(
        cfg,
        'lib/main_rotor.scad compiled successfully but produced no top-level geometry',
        'OpenSCAD library files',
        'remove the entry for lib/main_rotor.scad from test.json with edit_tests',
        'add a top-level invocation',
      );
    });

    it('should preserve underlying error.message for unrecognized UNKNOWN errors', async () => {
      const cfg = buildConfigurable();
      mockSingleFileFetchFailure(cfg, {
        errorCode: 'UNKNOWN',
        message: 'No graphics view is currently mounted',
      });

      await expectToolErrorMessage(
        cfg,
        'Failed to fetch geometry for lib/main_rotor.scad: No graphics view is currently mounted',
      );
    });

    it('should include errorCode in fallback for unrecognized error codes', async () => {
      const cfg = buildConfigurable();
      mockSingleFileFetchFailure(cfg, {
        errorCode: 'IO_ERROR',
        message: 'disk read failed',
      });

      await expectToolErrorMessage(
        cfg,
        'Failed to fetch geometry for lib/main_rotor.scad [IO_ERROR]: disk read failed',
      );
    });

    it('should preserve targetFile in every failure message variant', async () => {
      const variants: ReadonlyArray<{ errorCode: string; message: string }> = [
        { errorCode: 'UNKNOWN_COMPILATION_UNIT', message: 'no CU' },
        { errorCode: 'UNKNOWN', message: 'No GLTF geometry available for lib/main_rotor.scad' },
        { errorCode: 'UNKNOWN', message: 'something else' },
        { errorCode: 'TIMEOUT_ERROR', message: 'timed out' },
      ];

      await Promise.all(
        variants.map(async (failure) => {
          const cfg = buildConfigurable();
          mockSingleFileFetchFailure(cfg, failure);
          await expectToolErrorMessage(cfg, 'lib/main_rotor.scad');
        }),
      );
    });
  });
});
