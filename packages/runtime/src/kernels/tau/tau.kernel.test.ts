import { describe, it, expect, vi, afterEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { importToGlb } from '@taucad/converter';
import type {
  KernelRuntime,
  GetDependenciesInput,
  GetParametersInput,
  CreateGeometryInput,
} from '#types/runtime-kernel.types.js';
import { createMockKernelRuntime } from '#testing/kernel-testing.utils.js';
import tauKernel from '#kernels/tau/tau.kernel.js';

vi.mock('@taucad/converter', () => ({
  importToGlb: vi.fn(),
}));

const stepBytes = new Uint8Array([0x53, 0x54, 0x45, 0x50]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TauKernel', () => {
  describe('getDependencies', () => {
    it('should return array containing the input filePath', async () => {
      const result = await tauKernel.getDependencies(
        mock<GetDependenciesInput>({ filePath: '/models/part.step' }),
        mock<KernelRuntime>(),
        {},
      );
      expect(result).toEqual({ resolved: ['/models/part.step'], unresolved: [] });
    });
  });

  describe('getParameters', () => {
    it('should return empty default parameters and empty JSON schema', async () => {
      const result = await tauKernel.getParameters(mock<GetParametersInput>(), mock<KernelRuntime>(), {});
      expect(result).toEqual({
        success: true,
        data: {
          defaultParameters: {},
          jsonSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        issues: [],
      });
    });
  });

  describe('initialize', () => {
    it('should resolve with empty config', async () => {
      const result = await tauKernel.initialize({}, mock<KernelRuntime>());
      expect(result).toEqual({});
    });
  });

  describe('createGeometry', () => {
    it('should call importToGlb with file content and return geometry with gltf format', async () => {
      const glbData = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
      vi.mocked(importToGlb).mockResolvedValue(glbData);

      const runtime = createMockKernelRuntime({
        filesystemOverrides: { readFileResult: stepBytes },
      });

      const result = await tauKernel.createGeometry(
        mock<CreateGeometryInput>({ filePath: '/models/part.step', basePath: '/models', options: {} }),
        runtime,
        {},
      );

      /* oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() returns any for matchers */
      expect(importToGlb).toHaveBeenCalledWith(
        /* oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() matcher */
        [{ name: 'part.step', bytes: expect.any(Uint8Array) }],
        'step',
        /* oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() matcher */
        expect.objectContaining({ exists: expect.any(Function), readFile: expect.any(Function) }),
      );
      expect(result).toEqual({
        geometry: [{ format: 'gltf', content: glbData }],
        nativeHandle: glbData,
      });
    });

    it('should throw with structured issues when importToGlb fails', async () => {
      vi.mocked(importToGlb).mockRejectedValue(new Error('conversion failed'));

      const runtime = createMockKernelRuntime({
        filesystemOverrides: { readFileResult: stepBytes },
      });

      try {
        await tauKernel.createGeometry(
          mock<CreateGeometryInput>({ filePath: '/models/part.step', basePath: '/models', options: {} }),
          runtime,
          {},
        );
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('conversion failed');
        expect((error as { issues: Array<{ message: string }> }).issues).toBeDefined();
        expect((error as { issues: Array<{ message: string }> }).issues[0]!.message).toBe('conversion failed');
      }
    });
  });

  describe('exportGeometry', () => {
    it('should return GLB file when format is glb', async () => {
      const runtime = createMockKernelRuntime();
      const nativeHandle = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

      const result = await tauKernel.exportGeometry({ format: 'glb', options: {}, nativeHandle }, runtime, {});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]!.name).toBe('model.glb');
        expect(result.data[0]!.mimeType).toBe('model/gltf-binary');
        expect(result.data[0]!.bytes).toBe(nativeHandle);
      }
    });

    it('should return glTF file when format is gltf', async () => {
      const runtime = createMockKernelRuntime();
      const nativeHandle = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

      const result = await tauKernel.exportGeometry({ format: 'gltf', options: {}, nativeHandle }, runtime, {});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]!.name).toBe('model.gltf');
      }
    });

    it('should reject unsupported formats with error result', async () => {
      const runtime = createMockKernelRuntime();
      const nativeHandle = new Uint8Array([1, 2, 3]);

      const result = await tauKernel.exportGeometry({ format: 'stl' as 'glb', options: {}, nativeHandle }, runtime, {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues[0]!.message).toContain('Use a transcoder');
      }
    });

    it('should return error result when nativeHandle is empty', async () => {
      const runtime = createMockKernelRuntime();

      const result = await tauKernel.exportGeometry(
        { format: 'glb', options: {}, nativeHandle: new Uint8Array(0) },
        runtime,
        {},
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues[0]!.message).toContain('No geometry available');
      }
    });
  });
});
