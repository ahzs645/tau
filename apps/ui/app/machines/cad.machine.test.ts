import { describe, it, expect, vi, afterEach } from 'vitest';
import { createActor, fromPromise, waitFor } from 'xstate';
import type { KernelIssue } from '@taucad/kernels';
import type { Geometry, GeometryFile } from '@taucad/types';
import { cadMachine } from '#machines/cad.machine.js';
import type { CadContext } from '#machines/cad.machine.js';

// ---------------------------------------------------------------------------
// Mock KernelClient
// ---------------------------------------------------------------------------

const noop = () => {
  /* No-op */
};

function createMockKernelClient() {
  return {
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    setFile: vi.fn<(file: GeometryFile, params: Record<string, unknown>) => void>(),
    setParameters: vi.fn<(params: Record<string, unknown>) => void>(),
    export: vi.fn().mockResolvedValue({
      success: true,
      data: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'model/stl' },
      issues: [],
    }),
    render: vi.fn(),
    notifyFileChanged: vi.fn(),
    terminate: vi.fn(),
    on: vi.fn<(event: string, handler: (...args: never[]) => void) => () => void>().mockReturnValue(noop),
  };
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function createTestActor(options?: {
  connectResult?: () => Promise<{ client: ReturnType<typeof createMockKernelClient>; cleanups: Array<() => void> }>;
  connectError?: Error;
  shouldInitializeKernelOnStart?: boolean;
}) {
  const mockClient = createMockKernelClient();
  const cleanups: Array<() => void> = [];

  const connectResult =
    options?.connectResult ??
    (options?.connectError
      ? async () => {
          // oxlint-disable-next-line @typescript-eslint/only-throw-error -- test stub
          throw options.connectError;
        }
      : async () => ({ client: mockClient, cleanups }));

  const machine = cadMachine.provide({
    actors: {
      // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock actor for test
      connectKernelActor: fromPromise(connectResult) as never,
    },
  });

  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock stubs for unit test
  const kernelOptions = {} as never;

  const actor = createActor(machine, {
    input: {
      shouldInitializeKernelOnStart: options?.shouldInitializeKernelOnStart ?? false,
      kernelOptions,
    },
  });

  return { actor, mockClient, cleanups };
}

async function startAndConnect(options?: Parameters<typeof createTestActor>[0]) {
  const result = createTestActor(options);
  result.actor.start();
  await waitFor(result.actor, (s) => s.value !== 'connecting');
  return result;
}

// ---------------------------------------------------------------------------
// Stub data
// ---------------------------------------------------------------------------

const stubFile: GeometryFile = { path: '/builds/test', filename: 'main.ts' };

// oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal stub
const stubGeometries = [{ format: 'gltf', data: new ArrayBuffer(0) }] as unknown as Geometry[];

const stubIssues: KernelIssue[] = [{ message: 'test issue', type: 'runtime', severity: 'warning' }];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cadMachine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // State: connecting
  // =========================================================================
  describe('connecting', () => {
    it('should start in connecting state', () => {
      const { actor } = createTestActor();
      actor.start();
      expect(actor.getSnapshot().value).toBe('connecting');
      actor.stop();
    });

    it('should transition to idle on successful connection', async () => {
      const { actor } = await startAndConnect();
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    });

    it('should set kernelClient in context after connection', async () => {
      const { actor } = await startAndConnect();
      expect(actor.getSnapshot().context.kernelClient).toBeDefined();
      actor.stop();
    });

    it('should transition to error on connection failure', async () => {
      const { actor } = await startAndConnect({
        connectError: new Error('Connection refused'),
      });
      expect(actor.getSnapshot().value).toBe('error');
      const issues = actor.getSnapshot().context.kernelIssues;
      expect(issues.get('__connection__')?.[0]?.message).toBe('Connection refused');
      actor.stop();
    });

    it('should buffer initializeModel during connecting and forward on connect', async () => {
      let resolveConnect!: (value: {
        client: ReturnType<typeof createMockKernelClient>;
        cleanups: Array<() => void>;
      }) => void;
      const mockClient = createMockKernelClient();

      const { actor } = createTestActor({
        connectResult: async () =>
          new Promise((resolve) => {
            resolveConnect = resolve;
          }),
      });
      actor.start();
      expect(actor.getSnapshot().value).toBe('connecting');

      actor.send({
        type: 'initializeModel',
        file: stubFile,
        parameters: { width: 10 },
      });

      expect(actor.getSnapshot().context.file).toEqual(stubFile);
      expect(actor.getSnapshot().context.parameters).toEqual({ width: 10 });

      resolveConnect({ client: mockClient, cleanups: [] });
      await waitFor(actor, (s) => s.value === 'idle');

      expect(mockClient.setFile).toHaveBeenCalledWith(stubFile, { width: 10 });
      actor.stop();
    });

    it('should buffer setFile during connecting', () => {
      const { actor } = createTestActor({
        connectResult: async () => new Promise(noop),
      });
      actor.start();

      actor.send({ type: 'setFile', file: stubFile });
      expect(actor.getSnapshot().context.file).toEqual(stubFile);
      actor.stop();
    });

    it('should buffer setParameters during connecting', () => {
      const { actor } = createTestActor({
        connectResult: async () => new Promise(noop),
      });
      actor.start();

      actor.send({ type: 'setParameters', parameters: { depth: 5 } });
      expect(actor.getSnapshot().context.parameters).toEqual({ depth: 5 });
      actor.stop();
    });
  });

  // =========================================================================
  // State: idle
  // =========================================================================
  describe('idle', () => {
    it('should forward setFile to kernel client', async () => {
      const { actor, mockClient } = await startAndConnect();

      actor.send({ type: 'setFile', file: stubFile });
      expect(mockClient.setFile).toHaveBeenCalledWith(stubFile, {});
      expect(actor.getSnapshot().context.file).toEqual(stubFile);
      actor.stop();
    });

    it('should forward setParameters to kernel client', async () => {
      const { actor, mockClient } = await startAndConnect();

      actor.send({ type: 'setParameters', parameters: { height: 20 } });
      expect(mockClient.setParameters).toHaveBeenCalledWith({ height: 20 });
      expect(actor.getSnapshot().context.parameters).toEqual({ height: 20 });
      actor.stop();
    });

    it('should forward initializeModel as setFile to kernel client', async () => {
      const { actor, mockClient } = await startAndConnect();

      actor.send({
        type: 'initializeModel',
        file: stubFile,
        parameters: { width: 10 },
      });
      expect(mockClient.setFile).toHaveBeenCalledWith(stubFile, { width: 10 });
      expect(actor.getSnapshot().context.file).toEqual(stubFile);
      actor.stop();
    });

    it('should transition to rendering on stateChanged(rendering)', async () => {
      const { actor } = await startAndConnect();

      actor.send({ type: 'stateChanged', state: 'rendering' });
      expect(actor.getSnapshot().value).toBe('rendering');
      actor.stop();
    });

    it('should transition to error on stateChanged(error)', async () => {
      const { actor } = await startAndConnect();

      actor.send({ type: 'stateChanged', state: 'error' });
      expect(actor.getSnapshot().value).toBe('error');
      actor.stop();
    });

    it('should stay in idle on stateChanged(idle)', async () => {
      const { actor } = await startAndConnect();

      actor.send({ type: 'stateChanged', state: 'idle' });
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    });

    it('should update geometries on geometryComputed', async () => {
      const { actor } = await startAndConnect();

      actor.send({ type: 'setFile', file: stubFile });
      actor.send({
        type: 'geometryComputed',
        geometries: stubGeometries,
        issues: [],
      });
      expect(actor.getSnapshot().context.geometries).toEqual(stubGeometries);
      actor.stop();
    });

    it('should store kernel issues with geometryComputed', async () => {
      const { actor } = await startAndConnect();

      actor.send({ type: 'setFile', file: stubFile });
      actor.send({
        type: 'geometryComputed',
        geometries: stubGeometries,
        issues: stubIssues,
      });

      const issues = actor.getSnapshot().context.kernelIssues;
      expect(issues.get('main.ts')).toEqual(stubIssues);
      actor.stop();
    });

    it('should clear kernel issues on geometryComputed with no issues', async () => {
      const { actor } = await startAndConnect();

      actor.send({ type: 'setFile', file: stubFile });
      actor.send({
        type: 'geometryComputed',
        geometries: stubGeometries,
        issues: stubIssues,
      });
      expect(actor.getSnapshot().context.kernelIssues.has('main.ts')).toBe(true);

      actor.send({
        type: 'geometryComputed',
        geometries: stubGeometries,
        issues: [],
      });
      expect(actor.getSnapshot().context.kernelIssues.has('main.ts')).toBe(false);
      actor.stop();
    });

    it('should set default parameters on parametersParsed', async () => {
      const { actor } = await startAndConnect();
      const schema = { type: 'object' as const, properties: { width: { type: 'number' as const } } };

      actor.send({
        type: 'parametersParsed',
        defaultParameters: { width: 42 },
        jsonSchema: schema,
      });

      expect(actor.getSnapshot().context.defaultParameters).toEqual({ width: 42 });
      expect(actor.getSnapshot().context.jsonSchema).toEqual(schema);
      actor.stop();
    });

    it('should set code issues on setCodeIssues', async () => {
      const { actor } = await startAndConnect();

      // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal stub
      const codeIssues = [
        { message: 'syntax error', severity: 'error' as const },
      ] as unknown as CadContext['codeIssues'];
      actor.send({ type: 'setCodeIssues', errors: codeIssues });
      expect(actor.getSnapshot().context.codeIssues).toEqual(codeIssues);
      actor.stop();
    });

    it('should emit geometryEvaluated on geometryComputed', async () => {
      const { actor } = await startAndConnect();
      const emitted: unknown[] = [];
      actor.on('geometryEvaluated', (event) => emitted.push(event));

      actor.send({ type: 'setFile', file: stubFile });
      actor.send({
        type: 'geometryComputed',
        geometries: stubGeometries,
        issues: [],
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ type: 'geometryEvaluated', geometries: stubGeometries });
      actor.stop();
    });

    it('should handle kernelFilesChanged as no-op', async () => {
      const { actor } = await startAndConnect();

      actor.send({ type: 'kernelFilesChanged', paths: ['/builds/test/main.ts'] });
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    });
  });

  // =========================================================================
  // State: rendering
  // =========================================================================
  describe('rendering', () => {
    async function enterRendering() {
      const result = await startAndConnect();
      result.actor.send({ type: 'stateChanged', state: 'rendering' });
      expect(result.actor.getSnapshot().value).toBe('rendering');
      return result;
    }

    it('should transition to idle on geometryComputed', async () => {
      const { actor } = await enterRendering();

      actor.send({
        type: 'geometryComputed',
        geometries: stubGeometries,
        issues: [],
      });
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    });

    it('should transition to idle on stateChanged(idle)', async () => {
      const { actor } = await enterRendering();

      actor.send({ type: 'stateChanged', state: 'idle' });
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    });

    it('should transition to error on kernelIssue', async () => {
      const { actor } = await enterRendering();

      actor.send({ type: 'setFile', file: stubFile });
      actor.send({ type: 'kernelIssue', errors: stubIssues });
      expect(actor.getSnapshot().value).toBe('error');
      actor.stop();
    });

    it('should transition to error on stateChanged(error)', async () => {
      const { actor } = await enterRendering();

      actor.send({ type: 'stateChanged', state: 'error' });
      expect(actor.getSnapshot().value).toBe('error');
      actor.stop();
    });

    it('should accept setFile during rendering (forwards to client)', async () => {
      const { actor, mockClient } = await enterRendering();

      actor.send({ type: 'setFile', file: stubFile });
      expect(mockClient.setFile).toHaveBeenCalledWith(stubFile, {});
      actor.stop();
    });

    it('should accept setParameters during rendering (forwards to client)', async () => {
      const { actor, mockClient } = await enterRendering();

      actor.send({ type: 'setParameters', parameters: { depth: 5 } });
      expect(mockClient.setParameters).toHaveBeenCalledWith({ depth: 5 });
      actor.stop();
    });

    it('should track progress during rendering', async () => {
      const { actor } = await enterRendering();

      // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal stub
      actor.send({ type: 'kernelProgress', phase: 'bundling' as never });
      expect(actor.getSnapshot().context.renderPhase).toBe('bundling');
      actor.stop();
    });

    it('should store telemetry during rendering', async () => {
      const { actor } = await enterRendering();

      // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal stub
      const entries = [{ name: 'test', duration: 100 }] as never[];
      actor.send({ type: 'kernelTelemetry', entries });
      expect(actor.getSnapshot().context.telemetryEntries).toHaveLength(1);
      actor.stop();
    });
  });

  // =========================================================================
  // State: error
  // =========================================================================
  describe('error', () => {
    async function enterError() {
      const result = await startAndConnect();
      result.actor.send({ type: 'stateChanged', state: 'error' });
      expect(result.actor.getSnapshot().value).toBe('error');
      return result;
    }

    it('should recover to idle on setFile', async () => {
      const { actor, mockClient } = await enterError();

      actor.send({ type: 'setFile', file: stubFile });
      expect(actor.getSnapshot().value).toBe('idle');
      expect(mockClient.setFile).toHaveBeenCalled();
      actor.stop();
    });

    it('should recover to idle on initializeModel', async () => {
      const { actor, mockClient } = await enterError();

      actor.send({
        type: 'initializeModel',
        file: stubFile,
        parameters: { width: 10 },
      });
      expect(actor.getSnapshot().value).toBe('idle');
      expect(mockClient.setFile).toHaveBeenCalledWith(stubFile, { width: 10 });
      actor.stop();
    });

    it('should recover to idle on setParameters', async () => {
      const { actor, mockClient } = await enterError();

      actor.send({ type: 'setParameters', parameters: { depth: 5 } });
      expect(actor.getSnapshot().value).toBe('idle');
      expect(mockClient.setParameters).toHaveBeenCalledWith({ depth: 5 });
      actor.stop();
    });

    it('should transition to idle on stateChanged(idle)', async () => {
      const { actor } = await enterError();

      actor.send({ type: 'stateChanged', state: 'idle' });
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    });

    it('should transition to rendering on stateChanged(rendering)', async () => {
      const { actor } = await enterError();

      actor.send({ type: 'stateChanged', state: 'rendering' });
      expect(actor.getSnapshot().value).toBe('rendering');
      actor.stop();
    });
  });

  // =========================================================================
  // Export handling
  // =========================================================================
  describe('export', () => {
    it('should handle export via dispatchExport in idle', async () => {
      const { actor } = await startAndConnect();

      const emitted: unknown[] = [];
      actor.on('geometryExported', (event) => emitted.push(event));

      actor.send({ type: 'exportGeometry', format: 'stl' });

      // Wait for the async export to complete
      await waitFor(actor, (s) => s.context.exportedBlob !== undefined);

      expect(actor.getSnapshot().context.exportedBlob).toBeDefined();
      expect(emitted).toHaveLength(1);
      actor.stop();
    });

    it('should handle export failure', async () => {
      const mockClient = createMockKernelClient();
      mockClient.export.mockResolvedValue({
        success: false,
        issues: [{ message: 'Export failed', type: 'runtime', severity: 'error' }],
      });

      const { actor } = await startAndConnect({
        connectResult: async () => ({ client: mockClient, cleanups: [] }),
      });

      const emitted: unknown[] = [];
      actor.on('exportFailed', (event) => emitted.push(event));

      actor.send({ type: 'exportGeometry', format: 'stl' });

      await waitFor(actor, () => emitted.length > 0);

      expect(emitted).toHaveLength(1);
      actor.stop();
    });

    it('should handle export exception', async () => {
      const mockClient = createMockKernelClient();
      mockClient.export.mockRejectedValue(new Error('Network error'));

      const { actor } = await startAndConnect({
        connectResult: async () => ({ client: mockClient, cleanups: [] }),
      });

      const emitted: unknown[] = [];
      actor.on('exportFailed', (event) => emitted.push(event));

      actor.send({ type: 'exportGeometry', format: 'stl' });

      await waitFor(actor, () => emitted.length > 0);

      expect(emitted).toHaveLength(1);
      actor.stop();
    });
  });

  // =========================================================================
  // Cleanup (destroyKernel exit action)
  // =========================================================================
  describe('cleanup', () => {
    it('should wire destroyKernel as a root exit action', () => {
      expect(cadMachine.config.exit).toContainEqual('destroyKernel');
    });

    it('should store event cleanups from connect result', async () => {
      const cleanup1 = vi.fn();
      const cleanup2 = vi.fn();
      const mockClient = createMockKernelClient();

      const { actor } = await startAndConnect({
        connectResult: async () => ({
          client: mockClient,
          cleanups: [cleanup1, cleanup2],
        }),
      });

      expect(actor.getSnapshot().context.eventCleanups).toHaveLength(2);
      actor.stop();
    });

    it('should store kernel client in context after connection', async () => {
      const { actor, mockClient } = await startAndConnect();

      expect(actor.getSnapshot().context.kernelClient).toBe(mockClient);
      actor.stop();
    });
  });

  // =========================================================================
  // Context initialization
  // =========================================================================
  describe('context initialization', () => {
    it('should initialize with correct defaults', () => {
      const { actor } = createTestActor();
      actor.start();
      const { context } = actor.getSnapshot();

      expect(context.file).toBeUndefined();
      expect(context.screenshot).toBeUndefined();
      expect(context.parameters).toEqual({});
      expect(context.defaultParameters).toEqual({});
      expect(context.geometries).toEqual([]);
      expect(context.kernelIssues.size).toBe(0);
      expect(context.codeIssues).toEqual([]);
      expect(context.exportedBlob).toBeUndefined();
      expect(context.kernelClient).toBeUndefined();
      expect(context.eventCleanups).toEqual([]);
      expect(context.renderPhase).toBeUndefined();
      expect(context.telemetryEntries).toEqual([]);
      expect(context.units).toEqual({ length: 'mm' });

      actor.stop();
    });
  });

  // =========================================================================
  // Multi-event flows
  // =========================================================================
  describe('multi-event flows', () => {
    it('should handle full render cycle: idle -> rendering -> geometryComputed -> idle', async () => {
      const { actor } = await startAndConnect();

      actor.send({ type: 'setFile', file: stubFile });
      expect(actor.getSnapshot().value).toBe('idle');

      actor.send({ type: 'stateChanged', state: 'rendering' });
      expect(actor.getSnapshot().value).toBe('rendering');

      actor.send({
        type: 'geometryComputed',
        geometries: stubGeometries,
        issues: [],
      });
      expect(actor.getSnapshot().value).toBe('idle');
      expect(actor.getSnapshot().context.geometries).toEqual(stubGeometries);
      actor.stop();
    });

    it('should handle setFile during rendering (abort + new render)', async () => {
      const { actor, mockClient } = await startAndConnect();

      actor.send({ type: 'stateChanged', state: 'rendering' });
      expect(actor.getSnapshot().value).toBe('rendering');

      const newFile: GeometryFile = { path: '/builds/test', filename: 'other.ts' };
      actor.send({ type: 'setFile', file: newFile });
      expect(mockClient.setFile).toHaveBeenCalledWith(newFile, {});
      expect(actor.getSnapshot().context.file).toEqual(newFile);

      actor.send({ type: 'stateChanged', state: 'idle' });
      actor.send({ type: 'stateChanged', state: 'rendering' });
      expect(actor.getSnapshot().value).toBe('rendering');

      actor.send({
        type: 'geometryComputed',
        geometries: stubGeometries,
        issues: [],
      });
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    });

    it('should handle error recovery: error -> setFile -> idle -> rendering -> idle', async () => {
      const { actor, mockClient } = await startAndConnect();

      actor.send({ type: 'stateChanged', state: 'error' });
      expect(actor.getSnapshot().value).toBe('error');

      actor.send({ type: 'setFile', file: stubFile });
      expect(actor.getSnapshot().value).toBe('idle');
      expect(mockClient.setFile).toHaveBeenCalled();

      actor.send({ type: 'stateChanged', state: 'rendering' });
      expect(actor.getSnapshot().value).toBe('rendering');

      actor.send({
        type: 'geometryComputed',
        geometries: stubGeometries,
        issues: [],
      });
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    });

    it('should clear file-specific issues on setFile', async () => {
      const { actor } = await startAndConnect();

      actor.send({ type: 'setFile', file: stubFile });
      actor.send({
        type: 'geometryComputed',
        geometries: stubGeometries,
        issues: stubIssues,
      });
      expect(actor.getSnapshot().context.kernelIssues.has('main.ts')).toBe(true);

      actor.send({ type: 'setFile', file: stubFile });
      expect(actor.getSnapshot().context.kernelIssues.has('main.ts')).toBe(false);
      actor.stop();
    });
  });
});
