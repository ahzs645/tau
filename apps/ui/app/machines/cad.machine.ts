import { assign, assertEvent, setup, enqueueActions, waitFor } from 'xstate';
import type { ActorRefFrom, AnyActorRef } from 'xstate';
import type { CodeIssue, ExportFormat, Geometry, GeometryFile, LogLevel, LogOrigin } from '@taucad/types';
import { createKernelClient } from '@taucad/runtime';
import type {
  ExportResult,
  GetParametersResult,
  HashedGeometryResult,
  KernelClient,
  KernelClientOptions,
  KernelIssue,
  RenderPhase,
  PerformanceEntryData,
  WorkerState,
} from '@taucad/runtime';
import { createFileSystemBridge } from '@taucad/runtime/filesystem';
import { safeDispose } from '@taucad/utils/dispose';
import type { JSONSchema7 } from 'json-schema';
import type { LengthSymbol } from '@taucad/units';
import { fromSafeAsync } from '#lib/xstate.lib.js';
import type { logMachine } from '#machines/logs.machine.js';
import type { fileManagerMachine } from '#machines/file-manager.machine.js';

export type CadContext = {
  file: GeometryFile | undefined;
  screenshot: string | undefined;
  parameters: Record<string, unknown>;
  units: { length: LengthSymbol };
  defaultParameters: Record<string, unknown>;
  geometries: Geometry[];
  kernelIssues: Map<string, KernelIssue[]>;
  codeIssues: CodeIssue[];
  exportedBlob: Blob | undefined;
  shouldInitializeKernelOnStart: boolean;
  logActorRef?: ActorRefFrom<typeof logMachine>;
  fileManagerRef?: ActorRefFrom<typeof fileManagerMachine>;
  kernelOptions: KernelClientOptions;
  jsonSchema?: JSONSchema7;
  renderPhase: RenderPhase | undefined;
  telemetryEntries: PerformanceEntryData[];
  kernelClient?: KernelClient;
  eventCleanups: Array<() => void>;
};

type KernelConnectedEvent = {
  type: 'kernelConnected';
  client: KernelClient;
  cleanups: Array<() => void>;
};

type CadEvent =
  | { type: 'initializeModel'; file: GeometryFile; parameters: Record<string, unknown> }
  | { type: 'setFile'; file: GeometryFile }
  | { type: 'setParameters'; parameters: Record<string, unknown> }
  | { type: 'setCodeIssues'; errors: CadContext['codeIssues'] }
  | { type: 'exportGeometry'; format: ExportFormat }
  | { type: 'geometryComputed'; geometries: Geometry[]; issues: KernelIssue[] }
  | { type: 'parametersParsed'; defaultParameters: Record<string, unknown>; jsonSchema: JSONSchema7 }
  | { type: 'kernelIssue'; errors: KernelIssue[] }
  | { type: 'kernelProgress'; phase: RenderPhase }
  | { type: 'kernelTelemetry'; entries: PerformanceEntryData[] }
  | { type: 'kernelLog'; level: LogLevel; message: string; origin?: LogOrigin; data?: unknown }
  | { type: 'stateChanged'; state: WorkerState; detail?: string }
  | { type: 'geometryExported'; blob: Blob; format: ExportFormat }
  | { type: 'geometryExportFailed'; errors: KernelIssue[] }
  | { type: 'kernelFilesChanged'; paths: string[] }
  | KernelConnectedEvent;

type CadEmitted =
  | { type: 'geometryEvaluated'; geometries: Geometry[] }
  | { type: 'geometryExported'; blob: Blob; format: ExportFormat }
  | { type: 'exportFailed'; errors: KernelIssue[] };

type CadInput = {
  shouldInitializeKernelOnStart: boolean;
  logRef?: ActorRefFrom<typeof logMachine>;
  fileManagerRef?: ActorRefFrom<typeof fileManagerMachine>;
  kernelOptions: KernelClientOptions;
};

type ConnectKernelInput = {
  kernelOptions: KernelClientOptions;
  fileManagerRef?: ActorRefFrom<typeof fileManagerMachine>;
  machineRef: AnyActorRef;
};

const connectKernelActor = fromSafeAsync<KernelConnectedEvent, ConnectKernelInput>(async ({ input, signal }) => {
  const { kernelOptions, fileManagerRef, machineRef } = input;

  console.log('[CadMachine] connectKernelActor: start', { hasFileManagerRef: Boolean(fileManagerRef) });

  if (!fileManagerRef) {
    throw new Error('File manager not initialized');
  }

  console.log('[CadMachine] connectKernelActor: waiting for fileManager ready...');
  const snapshot = await waitFor(fileManagerRef, (state) => state.matches('ready'), { signal });
  console.log('[CadMachine] connectKernelActor: fileManager ready', { hasWorker: Boolean(snapshot.context.worker) });

  if (!snapshot.context.worker) {
    throw new Error('File manager worker not available');
  }

  signal.throwIfAborted();

  console.log('[CadMachine] connectKernelActor: creating kernel client...');
  const client = createKernelClient(kernelOptions);
  const cleanups: Array<() => void> = [];

  cleanups.push(
    client.on('geometry', (result: HashedGeometryResult) => {
      console.log('[CadMachine] geometry event received', {
        success: result.success,
        dataLength: result.success ? result.data.length : 0,
      });
      if (result.success) {
        machineRef.send({
          type: 'geometryComputed',
          geometries: result.data,
          issues: result.issues,
        });
      } else {
        machineRef.send({ type: 'kernelIssue', errors: result.issues });
      }
    }),
    client.on('state', (state: WorkerState) => {
      machineRef.send({ type: 'stateChanged', state });
    }),
    client.on('progress', (phase: RenderPhase) => {
      machineRef.send({ type: 'kernelProgress', phase });
    }),
    client.on('parametersResolved', (parametersResult: GetParametersResult) => {
      if (parametersResult.success) {
        machineRef.send({
          type: 'parametersParsed',
          defaultParameters: parametersResult.data.defaultParameters,
          jsonSchema: parametersResult.data.jsonSchema as JSONSchema7,
        });
      }
    }),
    client.on('filesChanged', (paths: string[]) => {
      machineRef.send({ type: 'kernelFilesChanged', paths });
    }),
    client.on('log', (entry: { level: string; message: string; origin?: LogOrigin; data?: unknown }) => {
      machineRef.send({
        type: 'kernelLog',
        level: entry.level as LogLevel,
        message: entry.message,
        origin: entry.origin,
        data: entry.data,
      });
    }),
    client.on('telemetry', (entries: PerformanceEntryData[]) => {
      machineRef.send({ type: 'kernelTelemetry', entries });
    }),
  );

  signal.throwIfAborted();

  const { port, dispose } = createFileSystemBridge(snapshot.context.worker);
  cleanups.push(dispose);
  console.log('[CadMachine] connectKernelActor: connecting client...');
  await client.connect({ port });
  console.log('[CadMachine] connectKernelActor: connected successfully');

  return { type: 'kernelConnected', client, cleanups };
});

/**
 * CAD Machine -- Autonomous Kernel Topology
 *
 * 4-state display machine: connecting | idle | rendering | error
 *
 * The worker self-schedules rendering internally. The main thread is a
 * display-only consumer of geometry results and worker state changes.
 * Debouncing is handled in the worker (500ms for files, 50ms for params).
 * Render timeout is handled via AbortSignal.timeout() in the worker.
 */
export const cadMachine = setup({
  types: {
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    context: {} as CadContext,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    events: {} as CadEvent,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    input: {} as CadInput,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    emitted: {} as CadEmitted,
  },
  actors: {
    connectKernelActor,
  },
  actions: {
    sendKernelLogs: enqueueActions(({ enqueue, context, event }) => {
      assertEvent(event, 'kernelLog');
      const logMethod = event.level === 'error' ? console.error : event.level === 'warn' ? console.warn : console.debug;
      const origin = typeof event.origin === 'string' ? event.origin : 'worker';
      logMethod(`[Kernel:${origin}]`, event.message, event.data ?? '');
      if (context.logActorRef) {
        enqueue.sendTo(context.logActorRef, {
          type: 'addLog',
          message: event.message,
          options: { level: event.level, origin: event.origin, data: event.data },
        });
      }
    }),
    trackProgress: assign({
      renderPhase({ event }) {
        assertEvent(event, 'kernelProgress');
        return event.phase;
      },
    }),
    storeTelemetry: assign({
      telemetryEntries({ context, event }) {
        assertEvent(event, 'kernelTelemetry');
        return [...context.telemetryEntries, ...event.entries];
      },
    }),
    setFile: assign({
      file({ event }) {
        assertEvent(event, 'setFile');
        return event.file;
      },
      codeIssues: () => [],
      kernelIssues({ context, event }) {
        assertEvent(event, 'setFile');
        const newErrorsMap = new Map(context.kernelIssues);
        newErrorsMap.delete(event.file.filename);
        return newErrorsMap;
      },
    }),
    setParameters: assign({
      parameters({ event }) {
        assertEvent(event, 'setParameters');
        return event.parameters;
      },
    }),
    setGeometries: enqueueActions(({ enqueue, event, context }) => {
      assertEvent(event, 'geometryComputed');
      console.log('[CadMachine] setGeometries', { count: event.geometries.length, file: context.file?.filename });
      const currentFileName = context.file?.filename;
      enqueue.assign({
        geometries: event.geometries,
        kernelIssues({ context }) {
          if (!currentFileName) {
            return context.kernelIssues;
          }
          const newIssues = new Map(context.kernelIssues);
          if (event.issues.length > 0) {
            newIssues.set(currentFileName, event.issues);
          } else {
            newIssues.delete(currentFileName);
          }
          return newIssues;
        },
      });
      enqueue.emit({ type: 'geometryEvaluated', geometries: event.geometries });
    }),
    setKernelIssue: assign({
      kernelIssues({ context, event }) {
        assertEvent(event, 'kernelIssue');
        const currentFilePath = context.file?.filename;
        if (!currentFilePath) {
          return context.kernelIssues;
        }
        const newErrorsMap = new Map(context.kernelIssues);
        newErrorsMap.set(currentFilePath, event.errors);
        return newErrorsMap;
      },
    }),
    setCodeIssues: assign({
      codeIssues({ event }) {
        assertEvent(event, 'setCodeIssues');
        return event.errors;
      },
    }),
    setDefaultParameters: assign({
      defaultParameters({ event }) {
        assertEvent(event, 'parametersParsed');
        return event.defaultParameters;
      },
      jsonSchema({ event }) {
        assertEvent(event, 'parametersParsed');
        return event.jsonSchema;
      },
    }),
    setExportedBlob: enqueueActions(({ enqueue, event, context }) => {
      assertEvent(event, 'geometryExported');
      const currentFileName = context.file?.filename;
      enqueue.assign({
        exportedBlob: event.blob,
        kernelIssues({ context }) {
          if (currentFileName && context.kernelIssues.has(currentFileName)) {
            const newErrors = new Map(context.kernelIssues);
            newErrors.delete(currentFileName);
            return newErrors;
          }
          return context.kernelIssues;
        },
      });
      enqueue.emit({ type: 'geometryExported', blob: event.blob, format: event.format });
    }),
    setExportError: enqueueActions(({ enqueue, event }) => {
      assertEvent(event, 'geometryExportFailed');
      enqueue.assign({ exportedBlob: undefined });
      enqueue.emit({ type: 'exportFailed', errors: event.errors });
    }),
    initializeModel: enqueueActions(({ enqueue, context, event }) => {
      assertEvent(event, 'initializeModel');
      if (context.logActorRef) {
        enqueue.sendTo(context.logActorRef, { type: 'clearLogs' });
      }
      enqueue.assign({
        file: event.file,
        parameters: event.parameters,
        codeIssues: [],
        geometries: [],
        exportedBlob: undefined,
        jsonSchema: undefined,
      });
    }),
    forwardSetFile: ({ context, event }) => {
      assertEvent(event, 'setFile');
      context.kernelClient?.setFile(event.file, context.parameters);
    },
    forwardSetParameters: ({ context, event }) => {
      assertEvent(event, 'setParameters');
      context.kernelClient?.setParameters(event.parameters);
    },
    forwardInitializeModel: ({ context, event }) => {
      assertEvent(event, 'initializeModel');
      console.log('[CadMachine] forwardInitializeModel', {
        file: event.file,
        hasKernelClient: Boolean(context.kernelClient),
      });
      context.kernelClient?.setFile(event.file, event.parameters);
    },
    dispatchExport: ({ context, event, self }) => {
      assertEvent(event, 'exportGeometry');
      if (!context.kernelClient) {
        return;
      }

      const handleExport = async () => {
        try {
          const result: ExportResult = await context.kernelClient!.export(event.format);
          if (result.success) {
            const { data } = result;
            const blob = new Blob([data.bytes], { type: data.mimeType });
            self.send({ type: 'geometryExported', blob, format: event.format });
          } else {
            self.send({ type: 'geometryExportFailed', errors: result.issues });
          }
        } catch (error: unknown) {
          self.send({
            type: 'geometryExportFailed',
            errors: [
              {
                message: error instanceof Error ? error.message : 'Export failed',
                type: 'runtime',
                severity: 'error',
              },
            ],
          });
        }
      };

      void handleExport();
    },
    destroyKernel: assign(({ context }) => {
      for (const cleanup of context.eventCleanups) {
        safeDispose(cleanup);
      }
      safeDispose(() => context.kernelClient?.terminate());
      return {
        eventCleanups: [],
        kernelClient: undefined,
      };
    }),
  },
  guards: {
    hasKernelClient: ({ context }) => Boolean(context.kernelClient),
  },
}).createMachine({
  id: 'cad',
  context: ({ input }) => ({
    file: undefined,
    screenshot: undefined,
    units: { length: 'mm' },
    parameters: {},
    defaultParameters: {},
    geometries: [],
    kernelIssues: new Map(),
    codeIssues: [],
    exportedBlob: undefined,
    shouldInitializeKernelOnStart: input.shouldInitializeKernelOnStart,
    logActorRef: input.logRef,
    fileManagerRef: input.fileManagerRef,
    kernelOptions: input.kernelOptions,
    jsonSchema: undefined,
    renderPhase: undefined,
    telemetryEntries: [],
    kernelClient: undefined,
    eventCleanups: [],
  }),
  exit: ['destroyKernel'],
  initial: 'connecting',
  states: {
    connecting: {
      invoke: {
        id: 'connectKernelActor',
        src: 'connectKernelActor',
        input({ context, self }) {
          return {
            kernelOptions: context.kernelOptions,
            fileManagerRef: context.fileManagerRef,
            machineRef: self,
          };
        },
        onDone: 'idle',
        onError: {
          target: 'error',
          actions: enqueueActions(({ enqueue, event }) => {
            console.error('[CadMachine] connecting → error', event.error);
            const errorMessage =
              event.error instanceof Error || event.error instanceof DOMException
                ? event.error.message
                : 'Failed to connect kernel';
            enqueue.assign({
              kernelIssues({ context }) {
                const newMap = new Map(context.kernelIssues);
                newMap.set('__connection__', [{ message: errorMessage, type: 'runtime', severity: 'error' }]);
                return newMap;
              },
            });
          }),
        },
      },
      on: {
        kernelConnected: {
          actions: enqueueActions(({ enqueue, context, event }) => {
            console.log('[CadMachine] kernelConnected', { hasFile: Boolean(context.file) });
            enqueue.assign({
              kernelClient: event.client,
              eventCleanups: event.cleanups,
            });
            if (context.file) {
              console.log('[CadMachine] forwarding buffered file to kernel', context.file);
              event.client.setFile(context.file, context.parameters);
            }
          }),
        },
        initializeModel: { actions: 'initializeModel' },
        setFile: { actions: 'setFile' },
        setParameters: { actions: 'setParameters' },
        kernelLog: { actions: 'sendKernelLogs' },
        kernelProgress: { actions: 'trackProgress' },
        kernelTelemetry: { actions: 'storeTelemetry' },
      },
    },

    idle: {
      on: {
        initializeModel: {
          actions: ['initializeModel', 'forwardInitializeModel'],
        },
        setFile: {
          actions: ['setFile', 'forwardSetFile'],
        },
        setParameters: {
          actions: ['setParameters', 'forwardSetParameters'],
        },
        setCodeIssues: { actions: 'setCodeIssues' },
        exportGeometry: { actions: 'dispatchExport' },
        geometryExported: { actions: 'setExportedBlob' },
        geometryExportFailed: { actions: 'setExportError' },
        geometryComputed: { actions: ['setGeometries'] },
        parametersParsed: { actions: 'setDefaultParameters' },
        kernelIssue: { actions: 'setKernelIssue' },
        kernelLog: { actions: 'sendKernelLogs' },
        kernelProgress: { actions: 'trackProgress' },
        kernelTelemetry: { actions: 'storeTelemetry' },
        kernelFilesChanged: {},
        stateChanged: [
          { guard: ({ event }) => event.state === 'rendering', target: 'rendering' },
          { guard: ({ event }) => event.state === 'error', target: 'error' },
        ],
      },
    },

    rendering: {
      on: {
        initializeModel: {
          actions: ['initializeModel', 'forwardInitializeModel'],
        },
        setFile: {
          actions: ['setFile', 'forwardSetFile'],
        },
        setParameters: {
          actions: ['setParameters', 'forwardSetParameters'],
        },
        setCodeIssues: { actions: 'setCodeIssues' },
        exportGeometry: { actions: 'dispatchExport' },
        geometryExported: { actions: 'setExportedBlob' },
        geometryExportFailed: { actions: 'setExportError' },
        geometryComputed: {
          target: 'idle',
          actions: ['setGeometries'],
        },
        parametersParsed: { actions: 'setDefaultParameters' },
        kernelIssue: {
          target: 'error',
          actions: 'setKernelIssue',
        },
        kernelLog: { actions: 'sendKernelLogs' },
        kernelProgress: { actions: 'trackProgress' },
        kernelTelemetry: { actions: 'storeTelemetry' },
        kernelFilesChanged: {},
        stateChanged: [
          { guard: ({ event }) => event.state === 'idle', target: 'idle' },
          { guard: ({ event }) => event.state === 'error', target: 'error' },
        ],
      },
    },

    error: {
      on: {
        initializeModel: {
          target: 'connecting',
          actions: ['destroyKernel', 'initializeModel'],
        },
        setFile: {
          target: 'connecting',
          actions: ['destroyKernel', 'setFile'],
        },
        setParameters: {
          target: 'connecting',
          actions: ['destroyKernel', 'setParameters'],
        },
        setCodeIssues: { actions: 'setCodeIssues' },
        exportGeometry: { actions: 'dispatchExport' },
        geometryExported: { actions: 'setExportedBlob' },
        geometryExportFailed: { actions: 'setExportError' },
        geometryComputed: { actions: ['setGeometries'] },
        parametersParsed: { actions: 'setDefaultParameters' },
        kernelLog: { actions: 'sendKernelLogs' },
        kernelProgress: { actions: 'trackProgress' },
        kernelTelemetry: { actions: 'storeTelemetry' },
        kernelFilesChanged: {},
        stateChanged: [
          { guard: ({ event }) => event.state === 'idle', target: 'idle' },
          { guard: ({ event }) => event.state === 'rendering', target: 'rendering' },
        ],
      },
    },
  },
});
