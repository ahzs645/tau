// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { createActor, waitFor } from 'xstate';
import type { RuntimeClientOptions, KernelIssue, PerformanceEntryData } from '@taucad/runtime';
import { createMockRuntimeClient } from '@taucad/runtime/testing';
import type { Geometry, GeometryFile } from '@taucad/types';
import { fromSafeAsync } from '#lib/xstate.lib.js';
import { cadMachine } from '#machines/cad.machine.js';
import type { CadContext } from '#machines/cad.machine.js';
import type { AppRuntimeClient } from '#types/runtime-client.alias.js';

const noop = () => {
  /* No-op */
};

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function createTestActor(options?: {
  connectResult?: () => Promise<{
    type: 'kernelConnected';
    client: AppRuntimeClient;
    cleanups: Array<() => void>;
  }>;
  connectError?: Error;
  shouldInitializeKernelOnStart?: boolean;
}) {
  const mockClient = createMockRuntimeClient();
  const cleanups: Array<() => void> = [];

  const connectWork =
    options?.connectResult ??
    (options?.connectError
      ? async () => {
          // oxlint-disable-next-line @typescript-eslint/only-throw-error -- test stub
          throw options.connectError;
        }
      : async () => {
          await Promise.resolve();
          return { type: 'kernelConnected', client: mockClient, cleanups };
        });

  const machine = cadMachine.provide({
    actors: {
      connectKernelActor: fromSafeAsync(connectWork),
    },
  });

  const kernelOptions = mock<RuntimeClientOptions>();

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

const stubFile: GeometryFile = { path: '/projects/test', filename: 'main.ts' };

const stubGeometries: Geometry[] = [{ format: 'gltf', content: new Uint8Array(0), hash: 'stub' }];

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
      let resolveConnect!: () => void;
      const mockClient = createMockRuntimeClient();

      const { actor } = createTestActor({
        connectResult: async () =>
          new Promise((resolve) => {
            resolveConnect = () => {
              resolve({ type: 'kernelConnected', client: mockClient, cleanups: [] as Array<() => void> });
            };
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

      resolveConnect();
      await waitFor(actor, (s) => s.value === 'idle');

      expect(mockClient.setFile).toHaveBeenCalledWith(stubFile);
      actor.stop();
    });

    it('should buffer setFile during connecting', () => {
      const { actor } = createTestActor({
        connectResult: async () => new Promise<never>(noop),
      });
      actor.start();

      actor.send({ type: 'setFile', file: stubFile });
      expect(actor.getSnapshot().context.file).toEqual(stubFile);
      actor.stop();
    });

    it('should buffer setParameters during connecting', () => {
      const { actor } = createTestActor({
        connectResult: async () => new Promise<never>(noop),
      });
      actor.start();

      actor.send({ type: 'setParameters', parameters: { depth: 5 } });
      expect(actor.getSnapshot().context.parameters).toEqual({ depth: 5 });
      actor.stop();
    });

    it('should stay in connecting when actor never settles (simulates abort)', async () => {
      const { actor } = createTestActor({
        connectResult: async () =>
          new Promise<never>(
            // oxlint-disable-next-line no-empty-function -- mock stub for never-settling promise
            () => {},
          ),
      });
      actor.start();
      expect(actor.getSnapshot().value).toBe('connecting');

      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      expect(actor.getSnapshot().value).toBe('connecting');
      expect(actor.getSnapshot().context.kernelIssues.has('__connection__')).toBe(false);
      actor.stop();
    });

    it('should transition to error on DOMException AbortError reaching onError', async () => {
      const { actor } = await startAndConnect({
        connectError: new DOMException('The operation was aborted', 'AbortError'),
      });
      expect(actor.getSnapshot().value).toBe('error');
      const issues = actor.getSnapshot().context.kernelIssues;
      expect(issues.get('__connection__')?.[0]?.message).toBe('The operation was aborted');
      actor.stop();
    });

    it('should transition to error on non-abort DOMException', async () => {
      const { actor } = await startAndConnect({
        connectError: new DOMException('Network error', 'NetworkError'),
      });
      expect(actor.getSnapshot().value).toBe('error');
      const issues = actor.getSnapshot().context.kernelIssues;
      expect(issues.get('__connection__')?.[0]?.message).toBe('Network error');
      actor.stop();
    });
  });

  // =========================================================================
  // State: idle
  // =========================================================================
  describe('idle', () => {
    it('should forward setFile to runtime client without parameters', async () => {
      const { actor, mockClient } = await startAndConnect();

      actor.send({ type: 'setFile', file: stubFile });
      expect(mockClient.setFile).toHaveBeenCalledWith(stubFile);
      expect(actor.getSnapshot().context.file).toEqual(stubFile);
      actor.stop();
    });

    it('should update context on setParameters without forwarding to kernel', async () => {
      const { actor, mockClient } = await startAndConnect();

      actor.send({ type: 'setParameters', parameters: { height: 20 } });
      expect(mockClient.setParameters).not.toHaveBeenCalled();
      expect(actor.getSnapshot().context.parameters).toEqual({ height: 20 });
      actor.stop();
    });

    it('should forward initializeModel as setFile without parameters', async () => {
      const { actor, mockClient } = await startAndConnect();

      actor.send({
        type: 'initializeModel',
        file: stubFile,
        parameters: { width: 10 },
      });
      expect(mockClient.setFile).toHaveBeenCalledWith(stubFile);
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
      const schema = { type: 'object', properties: { width: { type: 'number' } } } as const;

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

      const codeIssues = mock<CadContext['codeIssues']>([
        { message: 'syntax error', startLineNumber: 0, endLineNumber: 0, startColumn: 0, endColumn: 0 },
      ]);
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

    it('should stay in rendering on geometryComputed and store geometries', async () => {
      const { actor } = await enterRendering();

      actor.send({
        type: 'geometryComputed',
        geometries: stubGeometries,
        issues: [],
      });
      expect(actor.getSnapshot().value).toBe('rendering');
      expect(actor.getSnapshot().context.geometries).toBe(stubGeometries);
      actor.stop();
    });

    it('should transition to idle on stateChanged(idle)', async () => {
      const { actor } = await enterRendering();

      actor.send({ type: 'stateChanged', state: 'idle' });
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    });

    it('should stay in rendering on kernelIssue and store issues', async () => {
      const { actor } = await enterRendering();

      actor.send({ type: 'setFile', file: stubFile });
      actor.send({ type: 'kernelIssue', errors: stubIssues });
      expect(actor.getSnapshot().value).toBe('rendering');
      expect(actor.getSnapshot().context.kernelIssues.get(stubFile.filename)).toBe(stubIssues);
      actor.stop();
    });

    it('should transition to error on stateChanged(error)', async () => {
      const { actor } = await enterRendering();

      actor.send({ type: 'stateChanged', state: 'error' });
      expect(actor.getSnapshot().value).toBe('error');
      actor.stop();
    });

    it('should transition to buffering on stateChanged(buffering)', async () => {
      const { actor } = await enterRendering();

      actor.send({ type: 'stateChanged', state: 'buffering' });
      expect(actor.getSnapshot().value).toBe('buffering');
      actor.stop();
    });

    it('should clear renderPhase when exiting rendering state', async () => {
      const { actor } = await enterRendering();

      actor.send({ type: 'kernelProgress', phase: 'Meshing' });
      expect(actor.getSnapshot().context.renderPhase).toBe('Meshing');

      actor.send({ type: 'stateChanged', state: 'idle' });
      expect(actor.getSnapshot().value).toBe('idle');
      expect(actor.getSnapshot().context.renderPhase).toBeUndefined();
      actor.stop();
    });

    it('should accept setFile during rendering (forwards to client without parameters)', async () => {
      const { actor, mockClient } = await enterRendering();

      actor.send({ type: 'setFile', file: stubFile });
      expect(mockClient.setFile).toHaveBeenCalledWith(stubFile);
      actor.stop();
    });

    it('should update context on setParameters during rendering without forwarding', async () => {
      const { actor, mockClient } = await enterRendering();

      actor.send({ type: 'setParameters', parameters: { depth: 5 } });
      expect(mockClient.setParameters).not.toHaveBeenCalled();
      expect(actor.getSnapshot().context.parameters).toEqual({ depth: 5 });
      actor.stop();
    });

    it('should track progress during rendering', async () => {
      const { actor } = await enterRendering();

      actor.send({ type: 'kernelProgress', phase: 'bundling' });
      expect(actor.getSnapshot().context.renderPhase).toBe('bundling');
      actor.stop();
    });

    it('should store telemetry during rendering', async () => {
      const { actor } = await enterRendering();

      const entries = mock<PerformanceEntryData[]>([
        { name: 'test', startTime: 0, duration: 100, workerTimeOrigin: 0 },
      ]);
      actor.send({ type: 'kernelTelemetry', entries });
      expect(actor.getSnapshot().context.telemetryEntries).toHaveLength(1);
      actor.stop();
    });
  });

  // =========================================================================
  // State: buffering
  // =========================================================================
  describe('buffering', () => {
    async function enterBuffering() {
      const result = await startAndConnect();
      result.actor.send({ type: 'stateChanged', state: 'buffering' });
      expect(result.actor.getSnapshot().value).toBe('buffering');
      return result;
    }

    it('should transition to buffering on stateChanged(buffering) from idle', async () => {
      const { actor } = await startAndConnect();

      actor.send({ type: 'stateChanged', state: 'buffering' });
      expect(actor.getSnapshot().value).toBe('buffering');
      actor.stop();
    });

    it('should transition to rendering on stateChanged(rendering) from buffering', async () => {
      const { actor } = await enterBuffering();

      actor.send({ type: 'stateChanged', state: 'rendering' });
      expect(actor.getSnapshot().value).toBe('rendering');
      actor.stop();
    });

    it('should transition to idle on stateChanged(idle) from buffering', async () => {
      const { actor } = await enterBuffering();

      actor.send({ type: 'stateChanged', state: 'idle' });
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    });

    it('should transition to error on stateChanged(error) from buffering', async () => {
      const { actor } = await enterBuffering();

      actor.send({ type: 'stateChanged', state: 'error' });
      expect(actor.getSnapshot().value).toBe('error');
      actor.stop();
    });

    it('should accept setFile during buffering and forward to client', async () => {
      const { actor, mockClient } = await enterBuffering();

      actor.send({ type: 'setFile', file: stubFile });
      expect(mockClient.setFile).toHaveBeenCalledWith(stubFile);
      actor.stop();
    });

    it('should accept setParameters during buffering', async () => {
      const { actor } = await enterBuffering();

      actor.send({ type: 'setParameters', parameters: { width: 10 } });
      expect(actor.getSnapshot().context.parameters).toEqual({ width: 10 });
      actor.stop();
    });

    it('should accept geometryComputed during buffering and store geometries', async () => {
      const { actor } = await enterBuffering();

      actor.send({
        type: 'geometryComputed',
        geometries: stubGeometries,
        issues: [],
      });
      expect(actor.getSnapshot().value).toBe('buffering');
      expect(actor.getSnapshot().context.geometries).toBe(stubGeometries);
      actor.stop();
    });

    it('should transition to buffering on stateChanged(buffering) from error', async () => {
      const { actor } = await startAndConnect();

      actor.send({ type: 'stateChanged', state: 'error' });
      expect(actor.getSnapshot().value).toBe('error');

      actor.send({ type: 'stateChanged', state: 'buffering' });
      expect(actor.getSnapshot().value).toBe('buffering');
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

    it('should reconnect on setFile from error state', async () => {
      const mockClient = createMockRuntimeClient();
      let connectAttempt = 0;

      const { actor } = createTestActor({
        connectResult: async () => {
          connectAttempt++;
          if (connectAttempt === 1) {
            throw new Error('Connection refused');
          }
          return { type: 'kernelConnected', client: mockClient, cleanups: [] as Array<() => void> };
        },
      });
      actor.start();
      await waitFor(actor, (s) => s.value === 'error');
      expect(actor.getSnapshot().context.kernelClient).toBeUndefined();

      actor.send({ type: 'setFile', file: stubFile });
      expect(actor.getSnapshot().value).toBe('connecting');

      await waitFor(actor, (s) => s.value === 'idle');
      expect(actor.getSnapshot().context.kernelClient).toBeDefined();
      expect(mockClient.setFile).toHaveBeenCalledWith(stubFile);
      actor.stop();
    });

    it('should reconnect on initializeModel from error state', async () => {
      const mockClient = createMockRuntimeClient();
      let connectAttempt = 0;

      const { actor } = createTestActor({
        connectResult: async () => {
          connectAttempt++;
          if (connectAttempt === 1) {
            throw new Error('Connection refused');
          }
          return { type: 'kernelConnected', client: mockClient, cleanups: [] as Array<() => void> };
        },
      });
      actor.start();
      await waitFor(actor, (s) => s.value === 'error');
      expect(actor.getSnapshot().context.kernelClient).toBeUndefined();

      actor.send({
        type: 'initializeModel',
        file: stubFile,
        parameters: { width: 10 },
      });
      expect(actor.getSnapshot().value).toBe('connecting');
      expect(actor.getSnapshot().context.file).toEqual(stubFile);

      await waitFor(actor, (s) => s.value === 'idle');
      expect(actor.getSnapshot().context.kernelClient).toBeDefined();
      expect(mockClient.setFile).toHaveBeenCalledWith(stubFile);
      actor.stop();
    });

    it('should stay in error on setParameters and only update context', async () => {
      const mockClient = createMockRuntimeClient();
      let connectAttempt = 0;

      const { actor } = createTestActor({
        connectResult: async () => {
          connectAttempt++;
          if (connectAttempt === 1) {
            throw new Error('Connection refused');
          }
          return { type: 'kernelConnected', client: mockClient, cleanups: [] as Array<() => void> };
        },
      });
      actor.start();
      await waitFor(actor, (s) => s.value === 'error');

      actor.send({ type: 'setParameters', parameters: { depth: 5 } });
      expect(actor.getSnapshot().value).toBe('error');
      expect(actor.getSnapshot().context.parameters).toEqual({ depth: 5 });
      actor.stop();
    });

    it('should reconnect on initializeModel even when kernelClient existed', async () => {
      const { actor } = await enterError();
      expect(actor.getSnapshot().context.kernelClient).toBeDefined();

      actor.send({
        type: 'initializeModel',
        file: stubFile,
        parameters: { width: 10 },
      });
      expect(actor.getSnapshot().value).toBe('connecting');
      actor.stop();
    });

    it('should reconnect on setFile even when kernelClient existed', async () => {
      const { actor } = await enterError();
      expect(actor.getSnapshot().context.kernelClient).toBeDefined();

      actor.send({ type: 'setFile', file: stubFile });
      expect(actor.getSnapshot().value).toBe('connecting');
      actor.stop();
    });

    it('should stay in error on setParameters even when kernelClient existed', async () => {
      const { actor } = await enterError();
      expect(actor.getSnapshot().context.kernelClient).toBeDefined();

      actor.send({ type: 'setParameters', parameters: { depth: 5 } });
      expect(actor.getSnapshot().value).toBe('error');
      expect(actor.getSnapshot().context.parameters).toEqual({ depth: 5 });
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

    it('should store kernel issues in error state on kernelIssue', async () => {
      const result = await startAndConnect();
      result.actor.send({ type: 'setFile', file: stubFile });
      result.actor.send({ type: 'stateChanged', state: 'error' });
      expect(result.actor.getSnapshot().value).toBe('error');

      result.actor.send({ type: 'kernelIssue', errors: stubIssues });
      expect(result.actor.getSnapshot().value).toBe('error');
      expect(result.actor.getSnapshot().context.kernelIssues.get(stubFile.filename)).toBe(stubIssues);
      result.actor.stop();
    });

    it('should preserve kernel issues set in rendering after transition to error', async () => {
      const result = await startAndConnect();
      result.actor.send({ type: 'setFile', file: stubFile });
      result.actor.send({ type: 'stateChanged', state: 'rendering' });
      expect(result.actor.getSnapshot().value).toBe('rendering');

      result.actor.send({ type: 'kernelIssue', errors: stubIssues });
      expect(result.actor.getSnapshot().context.kernelIssues.get(stubFile.filename)).toBe(stubIssues);

      result.actor.send({ type: 'stateChanged', state: 'error' });
      expect(result.actor.getSnapshot().value).toBe('error');
      expect(result.actor.getSnapshot().context.kernelIssues.get(stubFile.filename)).toBe(stubIssues);
      result.actor.stop();
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
      const mockClient = createMockRuntimeClient();
      vi.mocked(mockClient.export).mockResolvedValue({
        success: false,
        issues: [{ message: 'Export failed', type: 'runtime', severity: 'error' }],
      });

      const { actor } = await startAndConnect({
        connectResult: async () => {
          return { type: 'kernelConnected', client: mockClient, cleanups: [] as Array<() => void> };
        },
      });

      const emitted: unknown[] = [];
      actor.on('exportFailed', (event) => emitted.push(event));

      actor.send({ type: 'exportGeometry', format: 'stl' });

      await waitFor(actor, () => emitted.length > 0);

      expect(emitted).toHaveLength(1);
      actor.stop();
    });

    it('should handle export exception', async () => {
      const mockClient = createMockRuntimeClient();
      vi.mocked(mockClient.export).mockRejectedValue(new Error('Network error'));

      const { actor } = await startAndConnect({
        connectResult: async () => {
          return { type: 'kernelConnected', client: mockClient, cleanups: [] as Array<() => void> };
        },
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
      const mockClient = createMockRuntimeClient();

      const { actor } = await startAndConnect({
        connectResult: async () => {
          return { type: 'kernelConnected', client: mockClient, cleanups: [cleanup1, cleanup2] };
        },
      });

      expect(actor.getSnapshot().context.eventCleanups).toHaveLength(2);
      actor.stop();
    });

    it('should store runtime client in context after connection', async () => {
      const { actor } = await startAndConnect();

      expect(actor.getSnapshot().context.kernelClient).toBeDefined();
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
    it('should handle full render cycle: idle -> rendering -> geometryComputed + stateChanged -> idle', async () => {
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
      expect(actor.getSnapshot().value).toBe('rendering');
      expect(actor.getSnapshot().context.geometries).toEqual(stubGeometries);

      actor.send({ type: 'stateChanged', state: 'idle' });
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    });

    it('should handle setFile during rendering (abort + new render)', async () => {
      const { actor, mockClient } = await startAndConnect();

      actor.send({ type: 'stateChanged', state: 'rendering' });
      expect(actor.getSnapshot().value).toBe('rendering');

      const newFile: GeometryFile = { path: '/projects/test', filename: 'other.ts' };
      actor.send({ type: 'setFile', file: newFile });
      expect(mockClient.setFile).toHaveBeenCalledWith(newFile);
      expect(actor.getSnapshot().context.file).toEqual(newFile);

      actor.send({ type: 'stateChanged', state: 'idle' });
      actor.send({ type: 'stateChanged', state: 'rendering' });
      expect(actor.getSnapshot().value).toBe('rendering');

      actor.send({
        type: 'geometryComputed',
        geometries: stubGeometries,
        issues: [],
      });
      expect(actor.getSnapshot().value).toBe('rendering');

      actor.send({ type: 'stateChanged', state: 'idle' });
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    });

    it('should handle error recovery: error -> setFile -> reconnect -> idle -> rendering -> idle', async () => {
      const mockClient = createMockRuntimeClient();

      const { actor } = createTestActor({
        connectResult: async () => {
          return { type: 'kernelConnected', client: mockClient, cleanups: [] as Array<() => void> };
        },
      });
      actor.start();
      await waitFor(actor, (s) => s.value === 'idle');

      actor.send({ type: 'stateChanged', state: 'error' });
      expect(actor.getSnapshot().value).toBe('error');

      actor.send({ type: 'setFile', file: stubFile });
      expect(actor.getSnapshot().value).toBe('connecting');

      await waitFor(actor, (s) => s.value === 'idle');
      expect(mockClient.setFile).toHaveBeenCalledWith(stubFile);

      actor.send({ type: 'stateChanged', state: 'rendering' });
      expect(actor.getSnapshot().value).toBe('rendering');

      actor.send({
        type: 'geometryComputed',
        geometries: stubGeometries,
        issues: [],
      });
      expect(actor.getSnapshot().value).toBe('rendering');

      actor.send({ type: 'stateChanged', state: 'idle' });
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

  // ---------------------------------------------------------------------------
  // Render timeout forwarding
  // ---------------------------------------------------------------------------

  describe('render timeout', () => {
    it('should forward setRenderTimeout to kernel client', async () => {
      const { actor, mockClient } = await startAndConnect();

      actor.send({ type: 'setRenderTimeout', seconds: 60 });

      expect(actor.getSnapshot().context.renderTimeout).toBe(60);
      expect(mockClient.setRenderTimeout).toHaveBeenCalledWith(60);
      actor.stop();
    });

    it('should apply stored renderTimeout on kernel connection', async () => {
      const mockClient = createMockRuntimeClient();
      let resolveConnect!: () => void;
      const connectGate = new Promise<void>((resolve) => {
        resolveConnect = resolve;
      });

      const { actor } = createTestActor({
        connectResult: async () => {
          await connectGate;
          return { type: 'kernelConnected', client: mockClient, cleanups: [] };
        },
      });

      actor.start();

      actor.send({ type: 'setRenderTimeout', seconds: 120 });
      expect(actor.getSnapshot().context.renderTimeout).toBe(120);

      resolveConnect();
      await waitFor(actor, (s) => s.value !== 'connecting');

      expect(mockClient.setRenderTimeout).toHaveBeenCalledWith(120);
      actor.stop();
    });

    it('should default renderTimeout to 30', async () => {
      const { actor } = await startAndConnect();
      expect(actor.getSnapshot().context.renderTimeout).toBe(30);
      actor.stop();
    });
  });
});
