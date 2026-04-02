import { describe, it, expect, vi, afterEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { importToGlb, exportFromGlb } from '@taucad/converter';
import type {
  KernelRuntime,
  CanHandleInput,
  GetDependenciesInput,
  GetParametersInput,
  CreateGeometryInput,
} from '#types/runtime-kernel.types.js';
import { createMockKernelRuntime } from '#testing/kernel-testing.utils.js';
import tauKernel from '#kernels/tau/tau.kernel.js';

vi.mock('@taucad/converter', () => ({
  importToGlb: vi.fn(),
  exportFromGlb: vi.fn(),
  supportedImportFormats: ['step', 'stl', 'obj', 'iges', 'brep', 'gltf', 'glb', '3mf', 'fbx', 'dxf'],
}));

const stepBytes = new Uint8Array([0x53, 0x54, 0x45, 0x50]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TauKernel', () => {
  describe('canHandle', () => {
    it('should return true for STEP extension', async () => {
      const result = await tauKernel.canHandle!(mock<CanHandleInput>({ extension: 'step' }), mock<KernelRuntime>(), {});
      expect(result).toBe(true);
    });

    it('should return false for unsupported extension', async () => {
      const result = await tauKernel.canHandle!(mock<CanHandleInput>({ extension: 'xyz' }), mock<KernelRuntime>(), {});
      expect(result).toBe(false);
    });
  });

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
        mock<CreateGeometryInput>({ filePath: '/models/part.step', basePath: '/models' }),
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
          mock<CreateGeometryInput>({ filePath: '/models/part.step', basePath: '/models' }),
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
    it('should call exportFromGlb with native handle and file type', async () => {
      const exportedFiles = [{ name: 'model.stl', bytes: new Uint8Array([1, 2, 3]), mimeType: 'model/stl' } as const];
      vi.mocked(exportFromGlb).mockResolvedValue(exportedFiles);

      const runtime = createMockKernelRuntime();
      const nativeHandle = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

      const result = await tauKernel.exportGeometry({ fileType: 'stl', nativeHandle }, runtime, {});

      expect(exportFromGlb).toHaveBeenCalledWith(nativeHandle, 'stl');
      expect(result).toEqual({
        success: true,
        data: exportedFiles,
        issues: [],
      });
    });

    it('should return error result when nativeHandle is empty', async () => {
      const runtime = createMockKernelRuntime();

      const result = await tauKernel.exportGeometry({ fileType: 'stl', nativeHandle: new Uint8Array(0) }, runtime, {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues[0]!.message).toContain('No geometry available');
      }
    });

    it('should return error result when exportFromGlb throws', async () => {
      vi.mocked(exportFromGlb).mockRejectedValue(new Error('export failed'));

      const runtime = createMockKernelRuntime();
      const nativeHandle = new Uint8Array([1, 2, 3]);

      const result = await tauKernel.exportGeometry({ fileType: 'stl', nativeHandle }, runtime, {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues[0]!.message).toBe('export failed');
      }
    });
  });
});
