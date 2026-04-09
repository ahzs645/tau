import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExportFile } from '@taucad/types';
import { KernelRuntimeWorker } from '#framework/kernel-runtime-worker.js';
import { defineKernel } from '#types/runtime-kernel.types.js';
import type { KernelDefinition } from '#types/runtime-kernel.types.js';
import type { KernelIssue } from '#types/runtime.types.js';
import { seedTestFileSystem, initializeWorkerForTesting, createGeometryFile } from '#testing/kernel-testing.utils.js';
import { replicadDetectPattern } from '#kernels/replicad/replicad.plugin.js';

// ===================================================================
// Helpers
// ===================================================================

function createMockKernelDefinition(id: string, overrides?: Partial<KernelDefinition>): KernelDefinition {
  const initSpy = vi.fn().mockResolvedValue({ id });
  const definition = defineKernel({
    name: id,
    version: '1.0.0',
    initialize: initSpy,
    getDependencies: async (input) => ({ resolved: [input.filePath], unresolved: [] }),
    getParameters: async () => ({
      success: true,
      data: { defaultParameters: {}, jsonSchema: {} },
      issues: [] as KernelIssue[],
    }),
    createGeometry: async () => ({
      geometry: [{ format: 'gltf', content: new Uint8Array([1, 2, 3]) }],
      issues: [] as KernelIssue[],
      nativeHandle: undefined,
    }),
    exportGeometry: async () => ({
      success: true,
      data: [] as ExportFile[],
      issues: [] as KernelIssue[],
    }),
    ...overrides,
  });

  Object.defineProperty(definition, '_initSpy', { value: initSpy });
  return definition;
}

function getInitSpy(definition: KernelDefinition): ReturnType<typeof vi.fn> {
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- test-injected property
  return (definition as unknown as { _initSpy: ReturnType<typeof vi.fn> })._initSpy;
}

async function createMultiKernelWorker(
  modules: Array<{
    id: string;
    extensions: string[];
    definition: KernelDefinition;
    detectImport?: string;
    builtinModuleNames?: string[];
  }>,
): Promise<KernelRuntimeWorker> {
  const worker = new KernelRuntimeWorker();
  await initializeWorkerForTesting(worker, {
    workerOptions: {
      kernelModules: modules.map((m) => ({
        id: m.id,
        moduleUrl: `test://${m.id}`,
        extensions: m.extensions,
        detectImport: m.detectImport,
        builtinModuleNames: m.builtinModuleNames,
        definition: m.definition,
      })),
    },
  });
  return worker;
}

// ===================================================================
// Tests
// ===================================================================

describe('KernelRuntimeWorker kernel selection', () => {
  const basePath = '/projects/test';

  beforeEach(async () => {
    await seedTestFileSystem({
      [`${basePath}/model.scad`]: 'cube([10, 10, 10]);',
      [`${basePath}/main.ts`]: `import { draw } from 'replicad';\ndraw();`,
      [`${basePath}/plain.ts`]: 'export const main = () => ({ type: "mesh" });',
      [`${basePath}/data.xyz`]: 'some unknown format',
      [`${basePath}/model.step`]: 'ISO-10303-21;',
    });
  });

  describe('extension fast path', () => {
    it('should select a kernel by extension when no detectImport is needed', async () => {
      const scadDefinition = createMockKernelDefinition('openscad');

      const worker = await createMultiKernelWorker([
        { id: 'openscad', extensions: ['scad'], definition: scadDefinition },
      ]);

      const result = await worker.createGeometry({
        file: createGeometryFile('model.scad'),
        parameters: {},
      });

      expect(result.success).toBe(true);
      expect(getInitSpy(scadDefinition)).toHaveBeenCalledOnce();
    });

    it('should select the first matching kernel by extension order', async () => {
      const kernelA = createMockKernelDefinition('kernel-a');
      const kernelB = createMockKernelDefinition('kernel-b');

      const worker = await createMultiKernelWorker([
        { id: 'kernel-a', extensions: ['scad'], definition: kernelA },
        { id: 'kernel-b', extensions: ['scad'], definition: kernelB },
      ]);

      await worker.createGeometry({
        file: createGeometryFile('model.scad'),
        parameters: {},
      });

      expect(getInitSpy(kernelA)).toHaveBeenCalledOnce();
      expect(getInitSpy(kernelB)).not.toHaveBeenCalled();
    });
  });

  describe('regex detection', () => {
    it('should select a kernel when file content matches detectImport regex', async () => {
      const replicadDefinition = createMockKernelDefinition('replicad');

      const worker = await createMultiKernelWorker([
        {
          id: 'replicad',
          extensions: ['ts', 'js'],
          definition: replicadDefinition,
          detectImport: replicadDetectPattern.source,
        },
      ]);

      const result = await worker.createGeometry({
        file: createGeometryFile('main.ts'),
        parameters: {},
      });

      expect(result.success).toBe(true);
      expect(getInitSpy(replicadDefinition)).toHaveBeenCalledOnce();
    });

    it('should not select a kernel when file content does not match detectImport regex', async () => {
      const replicadDefinition = createMockKernelDefinition('replicad');
      const catchAllDefinition = createMockKernelDefinition('tau');

      const worker = await createMultiKernelWorker([
        {
          id: 'replicad',
          extensions: ['ts', 'js'],
          definition: replicadDefinition,
          detectImport: replicadDetectPattern.source,
        },
        { id: 'tau', extensions: ['*'], definition: catchAllDefinition },
      ]);

      await worker.createGeometry({
        file: createGeometryFile('plain.ts'),
        parameters: {},
      });

      expect(getInitSpy(replicadDefinition)).not.toHaveBeenCalled();
      expect(getInitSpy(catchAllDefinition)).toHaveBeenCalledOnce();
    });
  });

  describe('catch-all fallback', () => {
    it('should select the catch-all kernel when no other kernel matches', async () => {
      const catchAllDefinition = createMockKernelDefinition('tau');

      const worker = await createMultiKernelWorker([{ id: 'tau', extensions: ['*'], definition: catchAllDefinition }]);

      const result = await worker.createGeometry({
        file: createGeometryFile('model.step'),
        parameters: {},
      });

      expect(result.success).toBe(true);
      expect(getInitSpy(catchAllDefinition)).toHaveBeenCalledOnce();
    });

    it('should accept any extension via catch-all wildcard', async () => {
      const catchAllDefinition = createMockKernelDefinition('tau');

      const worker = await createMultiKernelWorker([{ id: 'tau', extensions: ['*'], definition: catchAllDefinition }]);

      const result = await worker.createGeometry({
        file: createGeometryFile('data.xyz'),
        parameters: {},
      });

      expect(result.success).toBe(true);
      expect(getInitSpy(catchAllDefinition)).toHaveBeenCalledOnce();
    });

    it('should defer catch-all when bundler-equipped kernels exist', async () => {
      const replicadDefinition = createMockKernelDefinition('replicad');
      const catchAllDefinition = createMockKernelDefinition('tau');

      const worker = await createMultiKernelWorker([
        {
          id: 'replicad',
          extensions: ['ts', 'js'],
          definition: replicadDefinition,
          detectImport: replicadDetectPattern.source,
          builtinModuleNames: ['replicad'],
        },
        { id: 'tau', extensions: ['*'], definition: catchAllDefinition },
      ]);

      await worker.createGeometry({
        file: createGeometryFile('model.step'),
        parameters: {},
      });

      expect(getInitSpy(replicadDefinition)).not.toHaveBeenCalled();
      expect(getInitSpy(catchAllDefinition)).toHaveBeenCalledOnce();
    });
  });

  describe('multi-kernel priority', () => {
    it('should select extension-matched kernel over catch-all', async () => {
      const scadDefinition = createMockKernelDefinition('openscad');
      const catchAllDefinition = createMockKernelDefinition('tau');

      const worker = await createMultiKernelWorker([
        { id: 'openscad', extensions: ['scad'], definition: scadDefinition },
        { id: 'tau', extensions: ['*'], definition: catchAllDefinition },
      ]);

      await worker.createGeometry({
        file: createGeometryFile('model.scad'),
        parameters: {},
      });

      expect(getInitSpy(scadDefinition)).toHaveBeenCalledOnce();
      expect(getInitSpy(catchAllDefinition)).not.toHaveBeenCalled();
    });
  });

  describe('selection cache', () => {
    it('should reuse cached kernel selection on repeated calls for the same file', async () => {
      const scadDefinition = createMockKernelDefinition('openscad');

      const worker = await createMultiKernelWorker([
        { id: 'openscad', extensions: ['scad'], definition: scadDefinition },
      ]);

      await worker.createGeometry({ file: createGeometryFile('model.scad'), parameters: {} });
      await worker.createGeometry({ file: createGeometryFile('model.scad'), parameters: {} });

      expect(getInitSpy(scadDefinition)).toHaveBeenCalledOnce();
    });
  });

  describe('file change invalidation', () => {
    it('should clear selection cache after notifyFileChanged', async () => {
      const scadDefinition = createMockKernelDefinition('openscad');

      const worker = await createMultiKernelWorker([
        { id: 'openscad', extensions: ['scad'], definition: scadDefinition },
      ]);

      await worker.createGeometry({ file: createGeometryFile('model.scad'), parameters: {} });
      expect(getInitSpy(scadDefinition)).toHaveBeenCalledOnce();

      await worker.notifyFileChanged([`${basePath}/model.scad`]);

      await worker.createGeometry({ file: createGeometryFile('model.scad'), parameters: {} });
    });

    it('should clear selection cache when a watch event fires (not just notifyFileChanged)', async () => {
      const scadDefinition = createMockKernelDefinition('openscad');

      const worker = await createMultiKernelWorker([
        { id: 'openscad', extensions: ['scad'], definition: scadDefinition },
      ]);

      await worker.createGeometry({ file: createGeometryFile('model.scad'), parameters: {} });
      expect(getInitSpy(scadDefinition)).toHaveBeenCalledOnce();

      // @ts-expect-error - accessing private for test verification
      expect(worker.selectionCache.size).toBe(1);

      let capturedWatchCallback: ((event: { type: string; path: string }) => void) | undefined;
      const mockWatch = vi
        .fn()
        .mockImplementation((_request: unknown, callback: (event: { type: string; path: string }) => void) => {
          capturedWatchCallback = callback;
          return () => {
            capturedWatchCallback = undefined;
          };
        });

      // @ts-expect-error - accessing private for test verification
      worker.fileSystem = { watch: mockWatch, dispose: vi.fn(), listen: vi.fn() };

      worker.updateWatchSet([`${basePath}/model.scad`]);
      expect(capturedWatchCallback).toBeDefined();

      capturedWatchCallback!({ type: 'change', path: `${basePath}/model.scad` });

      // @ts-expect-error - accessing private for test verification
      expect(worker.selectionCache.size).toBe(0);
    });
  });

  describe('no kernel matches', () => {
    it('should return empty geometry when no kernel matches an unrecognized extension', async () => {
      const scadDefinition = createMockKernelDefinition('openscad');

      const worker = await createMultiKernelWorker([
        { id: 'openscad', extensions: ['scad'], definition: scadDefinition },
      ]);

      const result = await worker.createGeometry({
        file: createGeometryFile('data.xyz'),
        parameters: {},
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual([]);
      }
    });
  });
});
