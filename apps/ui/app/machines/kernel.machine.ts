import { assign, assertEvent, setup, sendTo, fromPromise, fromCallback, waitFor } from 'xstate';
import type { Snapshot, ActorRef, OutputFrom, DoneActorEvent, ActorRefFrom } from 'xstate';
import type {
  Geometry,
  ExportFormat,
  KernelIssue,
  GeometryFile,
  GetParametersResult,
  LogLevel,
  LogOrigin,
  KernelConfig,
  MiddlewareConfig,
  MountConfig,
  PerformanceEntryData,
  RenderPhase,
} from '@taucad/types';
import { isKernelSuccess } from '@taucad/types/guards';
import type { JSONSchema7 } from 'json-schema';
import { assertActorDoneEvent } from '#lib/xstate.js';
import type { FileManagerMachine } from '#machines/file-manager.machine.js';
import { KernelWorkerClient } from '#components/geometry/kernel/utils/kernel-worker-client.js';
import type { OnLogCallback, OnTelemetryCallback } from '#components/geometry/kernel/utils/kernel-worker-client.js';
import { createFileManagerPort } from '#components/geometry/kernel/utils/kernel-worker-filemanager-bridge.js';
import runtimeWorkerUrl from '#components/geometry/kernel/kernel-runtime-worker.js?url';

const determineWorkerActor = fromPromise<
  | {
      type: 'workerDetermined';
      worker: string;
      parameters: Record<string, unknown>;
      file: GeometryFile;
    }
  | { type: 'kernelIssue'; errors: KernelIssue[] },
  { context: KernelContext; event: { file: GeometryFile; parameters: Record<string, unknown> } }
>(async ({ input }) => {
  const { context, event } = input;
  const cacheKey = event.file.filename;

  // Fast path: check worker selection cache
  const cached = context.workerSelectionCache.get(cacheKey);
  if (cached && context.workerClients.has(cached)) {
    return { type: 'workerDetermined', worker: cached, parameters: event.parameters, file: event.file };
  }

  const client = await ensureRuntimeWorkerClient(context);
  const canHandle = await client.canHandle(event.file);
  if (canHandle) {
    context.workerSelectionCache.set(cacheKey, '__runtime__');
    context.workerClients.set('__runtime__', client);
    return { type: 'workerDetermined', worker: '__runtime__', parameters: event.parameters, file: event.file };
  }

  return {
    type: 'kernelIssue',
    errors: [
      {
        message: `No kernel can handle file: ${event.file.filename}`,
        location: { fileName: event.file.filename, startLineNumber: 1, startColumn: 1 },
        type: 'runtime',
        severity: 'warning' as const,
      },
    ],
  };
});

/**
 * Correlate worker performance entries with the main-thread timeline.
 * Converts worker-relative timestamps to main-thread-relative timestamps
 * and re-creates them as performance.measure() entries visible in DevTools.
 */
function createTelemetryAggregator(workerId: string, context: KernelContext): OnTelemetryCallback {
  return (entries: PerformanceEntryData[]) => {
    const mainTimeOrigin = performance.timeOrigin;
    for (const entry of entries) {
      const offsetMs = entry.workerTimeOrigin - mainTimeOrigin;
      const adjustedStart = entry.startTime + offsetMs;
      try {
        performance.measure(`[${workerId}] ${entry.name}`, {
          start: Math.max(0, adjustedStart),
          duration: entry.duration,
          detail: entry.detail,
        });
      } catch {
        // Silently skip entries that can't be measured (e.g. negative start)
      }
    }

    context.parentRef?.send({ type: 'kernelTelemetry', entries });
  };
}

/**
 * Lazily create and initialize the single runtime worker for the CU.
 * The runtime worker dynamically loads kernel modules and handles selection internally.
 * No-op if the runtime worker already exists.
 */
async function ensureRuntimeWorkerClient(context: KernelContext): Promise<KernelWorkerClient> {
  if (context.runtimeWorkerClient) {
    return context.runtimeWorkerClient;
  }

  if (!context.fileManagerRef) {
    throw new Error('File manager not initialized');
  }

  const snapshot = context.fileManagerRef.getSnapshot();
  if (!snapshot.matches('ready') || !snapshot.context.wrappedWorker) {
    throw new Error('File manager not ready');
  }

  const wrappedFileManager = snapshot.context.wrappedWorker;

  const onLog: OnLogCallback = (log) => {
    if (context.parentRef) {
      context.parentRef.send({
        type: 'kernelLog',
        level: log.level as LogLevel,
        message: log.message,
        origin: log.origin,
        data: log.data,
      });
    }
  };

  const rawWorker = new Worker(runtimeWorkerUrl, { type: 'module' });
  const onTelemetry = createTelemetryAggregator('runtime', context);
  const client = new KernelWorkerClient(rawWorker, onLog, onTelemetry);
  context.runtimeWorkerClient = client;

  const kernelModules = context.kernelConfig.map((entry) => ({
    id: entry.id,
    moduleUrl: entry.kernelModuleUrl,
    extensions: entry.extensions,
    detectImport: entry.detectImport?.source,
    options: entry.options,
  }));

  const port = createFileManagerPort(wrappedFileManager);
  await client.initialize({ kernelModules }, port, context.middlewareConfig);

  return client;
}

const createWorkersActor = fromPromise<
  { type: 'kernelInitialized' } | { type: 'kernelIssue'; errors: KernelIssue[] },
  { context: KernelContext }
>(async ({ input }) => {
  const { context } = input;

  // Clean up any existing worker clients
  for (const client of context.workerClients.values()) {
    client.cleanup();
    client.terminate();
  }

  context.workerClients.clear();

  try {
    if (!context.fileManagerRef) {
      return {
        type: 'kernelIssue',
        errors: [
          {
            message: 'File manager actor not initialized',
            type: 'runtime',
            severity: 'error' as const,
          },
        ],
      };
    }

    // Wait for file manager to be ready -- workers are created lazily on first use
    const snapshot = await waitFor(context.fileManagerRef, (state) => state.matches('ready') || state.matches('error'));

    if (snapshot.matches('error')) {
      const errorMessage = snapshot.context.error?.message ?? 'File manager initialization failed';
      return {
        type: 'kernelIssue',
        errors: [{ message: errorMessage, type: 'runtime', severity: 'error' as const }],
      };
    }

    if (!snapshot.context.wrappedWorker) {
      return {
        type: 'kernelIssue',
        errors: [{ message: 'File manager worker not initialized', type: 'runtime', severity: 'error' as const }],
      };
    }

    return { type: 'kernelInitialized' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to initialize workers';
    return {
      type: 'kernelIssue',
      errors: [{ message: errorMessage, type: 'kernel', severity: 'error' as const }],
    };
  }
});

type RenderEvent =
  | {
      type: 'parametersParsed';
      defaultParameters: Record<string, unknown>;
      jsonSchema: JSONSchema7;
    }
  | {
      type: 'geometryComputed';
      geometries: Geometry[];
      issues: KernelIssue[];
    }
  | {
      type: 'kernelIssue';
      errors: KernelIssue[];
    }
  | {
      type: 'kernelProgress';
      phase: RenderPhase;
    }
  | {
      type: 'kernelTelemetry';
      entries: PerformanceEntryData[];
    };

type RenderInput = {
  context: KernelContext;
  event: {
    file: GeometryFile;
    parameters: Record<string, unknown>;
  };
};

const renderActor = fromCallback<RenderEvent, RenderInput>(({ input, sendBack }) => {
  const { context, event } = input;
  const { selectedWorker } = context;
  const { file, parameters } = event;

  if (!selectedWorker) {
    sendBack({
      type: 'kernelIssue',
      errors: [
        {
          message: 'No worker selected',
          location: { fileName: file.filename, startLineNumber: 1, startColumn: 1 },
          type: 'runtime',
          severity: 'error' as const,
        },
      ],
    });
    return;
  }

  const client = context.workerClients.get(selectedWorker);

  if (!client) {
    sendBack({
      type: 'kernelIssue',
      errors: [
        {
          message: `${selectedWorker} worker not initialized`,
          location: { fileName: file.filename, startLineNumber: 1, startColumn: 1 },
          type: 'runtime',
          severity: 'error' as const,
        },
      ],
    });
    return;
  }

  if (context.changedPaths.length > 0) {
    client.notifyFileChanged(context.changedPaths);
  }

  void (async () => {
    try {
      const result = await client.render(
        file,
        parameters,
        (parametersResult: GetParametersResult) => {
          if (isKernelSuccess(parametersResult)) {
            const data = parametersResult.data as {
              defaultParameters: Record<string, unknown>;
              jsonSchema: JSONSchema7;
            };
            sendBack({
              type: 'parametersParsed',
              defaultParameters: data.defaultParameters,
              jsonSchema: data.jsonSchema,
            });
          }
        },
        (phase: RenderPhase) => {
          sendBack({ type: 'kernelProgress', phase });
        },
      );

      if (isKernelSuccess(result)) {
        sendBack({
          type: 'geometryComputed',
          geometries: result.data,
          issues: result.issues,
        });
      } else {
        sendBack({ type: 'kernelIssue', errors: result.issues });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error rendering geometry';
      sendBack({
        type: 'kernelIssue',
        errors: [
          {
            message: errorMessage,
            location: { fileName: file.filename, startLineNumber: 1, startColumn: 1 },
            type: 'runtime',
            severity: 'error' as const,
          },
        ],
      });
    }
  })();
});

const exportGeometryActor = fromPromise<
  | { type: 'geometryExported'; blob: Blob; format: ExportFormat }
  | { type: 'geometryExportFailed'; errors: KernelIssue[] },
  { context: KernelContext; event: { format: ExportFormat } }
>(async ({ input }) => {
  const { context, event } = input;
  const { selectedWorker } = context;
  const { format } = event;

  // Get the correct worker based on selected worker
  if (!selectedWorker) {
    return {
      type: 'geometryExportFailed',
      errors: [
        {
          message: 'No worker selected',
          type: 'runtime',
          severity: 'error' as const,
        },
      ],
    };
  }

  const client = context.workerClients.get(selectedWorker);

  if (!client) {
    return {
      type: 'geometryExportFailed',
      errors: [
        {
          message: `${selectedWorker} worker not initialized`,
          type: 'runtime',
          severity: 'error' as const,
        },
      ],
    };
  }

  try {
    const result = await client.exportGeometry(format);

    if (isKernelSuccess(result)) {
      const { data } = result;
      if (Array.isArray(data) && data.length > 0 && data[0]?.blob) {
        // TODO: Handle multiple blobs during export
        return { type: 'geometryExported', blob: data[0].blob, format };
      }

      return {
        type: 'geometryExportFailed',
        errors: [
          {
            message: 'No geometry data to export',
            type: 'runtime',
            severity: 'error' as const,
          },
        ],
      };
    }

    return {
      type: 'geometryExportFailed',
      errors: result.issues,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to export geometry';
    return {
      type: 'geometryExportFailed',
      errors: [
        {
          message: errorMessage,
          type: 'runtime',
          severity: 'error' as const,
        },
      ],
    };
  }
});

export type CadActor = ActorRef<Snapshot<unknown>, KernelEventExternal>;

// Define the actors that the machine can invoke
const kernelActors = {
  createWorkersActor,
  determineWorkerActor,
  renderActor,
  exportGeometryActor,
} as const;
type KernelActorNames = keyof typeof kernelActors;

// Define the types of events the machine can receive
type KernelEventInternal =
  | { type: 'initializeKernel'; parentRef: CadActor }
  | { type: 'createGeometry'; file: GeometryFile; parameters: Record<string, unknown>; changedPaths?: string[] }
  | { type: 'exportGeometry'; format: ExportFormat }
  | { type: 'configureMiddleware'; middlewareConfig: MiddlewareConfig };

// Define the events that the workers can send to the kernel machine
type KernelEventWorker = {
  type: 'kernelLog';
  level: LogLevel;
  message: string;
  origin?: LogOrigin;
  data?: unknown;
};

// Actors that produce OutputFrom (fromPromise actors)
type PromiseActorNames = Exclude<KernelActorNames, 'renderActor'>;

// The kernel machine sends the output of promise actors and render streaming events to the parent.
export type KernelEventExternal =
  | OutputFrom<(typeof kernelActors)[PromiseActorNames]>
  | RenderEvent
  | KernelEventWorker;
type KernelEventExternalDone = DoneActorEvent<KernelEventExternal, KernelActorNames>;

type KernelEvent = KernelEventExternalDone | KernelEventInternal | RenderEvent;

// Interface defining the context for the Kernel machine
type KernelContext = {
  kernelConfig: KernelConfig;
  middlewareConfig: MiddlewareConfig;
  workerClients: Map<string, KernelWorkerClient>;
  workerSelectionCache: Map<string, string>;
  /** Single runtime worker client (used in single-worker-per-CU mode) */
  runtimeWorkerClient?: KernelWorkerClient;
  parentRef?: CadActor;
  selectedWorker?: string;
  fileManagerRef?: ActorRefFrom<FileManagerMachine>;
  changedPaths: string[];
};

type KernelInput = {
  fileManagerRef?: ActorRefFrom<FileManagerMachine>;
  kernelConfig: KernelConfig;
  middlewareConfig: MiddlewareConfig;
  mountConfig?: MountConfig;
};

/**
 * Kernel Machine
 *
 * This machine manages the single runtime WebWorker that runs CAD operations:
 * - Lazily creates a runtime worker that dynamically loads kernel modules
 * - Routes files to the correct kernel via the runtime worker's canHandle check
 * - Processes results from CAD operations
 *
 * The machine is agnostic to which kernels exist -- kernel module URLs, priority,
 * and options are injected via KernelConfig at spawn time.
 * The parent machine is responsible for the state of the CAD operations.
 */
export const kernelMachine = setup({
  types: {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    context: {} as KernelContext,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    events: {} as KernelEvent,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    input: {} as KernelInput,
  },
  actors: kernelActors,
  actions: {
    registerParentRef: assign({
      parentRef({ event }) {
        assertEvent(event, 'initializeKernel');
        return event.parentRef;
      },
    }),

    setSelectedWorker: assign({
      selectedWorker({ event }) {
        assertActorDoneEvent(event);
        // Guard already filtered out errors, so we know this is workerDetermined
        if (event.output.type === 'workerDetermined') {
          return event.output.worker;
        }

        return undefined;
      },
    }),
    destroyWorkers({ context }) {
      for (const client of context.workerClients.values()) {
        client.cleanup();
        client.terminate();
      }

      context.workerClients.clear();

      if (context.runtimeWorkerClient) {
        context.runtimeWorkerClient.cleanup();
        context.runtimeWorkerClient.terminate();
        context.runtimeWorkerClient = undefined;
      }
    },
  },
  guards: {
    isKernelIssue({ event }) {
      assertActorDoneEvent(event);
      return event.output.type === 'kernelIssue';
    },
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QGswCcB2YA2A6AlhvgC74CG2+AXoVAMSEnmVWQDaADALqKgAOAe1hMBGXiAAeiAEwA2AJy4AzBwCMqgCwrZ0gByzVSgDQgAnogCsujbmnyOG1bvlKlegOy6Avl5OpMOAREpBTUtHToaAJonDxIIILCpKLiUgiyWsrSSupy8hYq7u4m5ghu0riq7vIZ8qoc2dIWFj5+6Fh4aGBkEKZ0AMYCALZ8AK7EYADiYMNgxGimseKJImLxafIaFfYcsrsaGrLuByWILu64W1VFug1uukqtIP4duF09fWASgmjE07PzRbcZZCVapRCqbIWXAFSEaXSqfLVdyyU4IaqyGG6awWVR7QzHeRPF6BL4-UgYegwAELACi32iEwgS3iK2Sa1AaU0Gg4uGRSns0k08jkxjMiHuuBFNQFKg48ncSlkxPapIZv3CkWiLP4oPZ4IQ9QyuH0+gO6luejRTmhRQFegF+SVmxVATwZMZkDoElgxDIE1wZAAZhM0AAKDgASjoJPd6qZOoSevwKXWEKs0Ic5Q4uIs0hRxXFCHyFQFDwK0gO8qVrtefDIaGElLo9bQZCGc3QsAACg3YOxgazk6nORLeSjnSKlMdXEp9GihZjdO4OBwlXj4dda4FW036FqYoPdUkUxzJIhbhc4Qr5ccGhZUUWRSbCc55c5ZJ-vL5nqr3QA3ChRn9cJqQ7QEAGFhjGBMjyTE8R3PMpblwPYlFhDR3DzEVKzRZcLg4Fc8ycHMDAsDRtwAoCQObA9EzZU8DT2aE5AaWQrEaGU0S2RQLEIrCFB0AoOAeSjcDAQDsGAplvV9f0wEDEN0AjaNY3EyTpIHOJjzBNMEF0SspUVSFBUOeVpDwzwYSIppPE8GUxIPAZoPGKYZnAhZ6OHM80gnSpywsGo+OCsVSnhJQYWkOQEQRJoHFkR4fzUpyPV+f4PKBbT4N00dDQaGwinqfjFXI0KJSiyoMTnAyDgKb82jdcS0CiNAGGCZhqDALyEJ8yxAtQix3EhbQUUvBc8RfVcH3caRSPqb8fwwAQIDgcRYxBHqDQAWkRbZMMcQ4US2B40WhacNHkewtAUET9jExgQhYWgNpypCmgqG5mnxOpDmaBd8lsA59ErHQqk-MT3l6F79T0+oAcwlcXAUREGjwxEYXYtQeSiiikr-cT42eodNthuQl3Q-IFT2TZdjRdDVClXZZqqIVLt0QbHPjSBocY2GOJhWVVFxaqql0NFPwuZoHhmxVqluRKGrrPsiZ0mHcp2g4pX2zQjgyB1rSVE0Es8diLv0PZlTxxqJOoikoB5xC0kcXRKkRKp1GOOx2O4vNLmsFQ6lI6xDEcjT5IgB3evSVwjJcL6DDxZc0R2XAHBXawos-HkFd-a3muiSODQRaEJZlPZl3kE6iyUDRoSFnQ1Erci7PcHwfCAA */
  id: 'kernel',
  context: ({ input }) => ({
    kernelConfig: input.kernelConfig,
    middlewareConfig: input.middlewareConfig,
    workerClients: new Map(),
    workerSelectionCache: new Map(),
    runtimeWorkerClient: undefined,
    parentRef: undefined,
    selectedWorker: undefined,
    fileManagerRef: input.fileManagerRef,
    changedPaths: [],
  }),
  initial: 'initializing',
  exit: ['destroyWorkers'],
  states: {
    initializing: {
      on: {
        initializeKernel: {
          target: 'creatingWorkers',
          actions: 'registerParentRef',
        },
      },
    },

    creatingWorkers: {
      invoke: {
        id: 'createWorkersActor',
        src: 'createWorkersActor',
        input({ context }) {
          return { context };
        },
        onDone: {
          target: 'ready',
          actions: sendTo(
            ({ context }) => context.parentRef!,
            ({ event }) => event.output,
          ),
        },
        onError: {
          target: 'ready',
          actions: sendTo(
            ({ context }) => context.parentRef!,
            ({ event }) => ({
              type: 'kernelIssue' as const,
              errors: [
                {
                  message: event.error instanceof Error ? event.error.message : 'Failed to create workers',
                  type: 'kernel' as const,
                  severity: 'error' as const,
                },
              ],
            }),
          ),
        },
      },
    },

    ready: {
      on: {
        createGeometry: {
          target: 'determiningWorker',
          actions: assign({
            changedPaths({ event }) {
              assertEvent(event, 'createGeometry');
              return event.changedPaths ?? [];
            },
          }),
        },
        exportGeometry: {
          target: 'exporting',
        },
        configureMiddleware: {
          actions: [
            assign({
              middlewareConfig({ event }) {
                assertEvent(event, 'configureMiddleware');
                return event.middlewareConfig;
              },
            }),
            ({ context, event }) => {
              assertEvent(event, 'configureMiddleware');
              for (const client of context.workerClients.values()) {
                client.configureMiddleware(event.middlewareConfig);
              }
            },
          ],
        },
      },
    },

    determiningWorker: {
      // Allow cancelling inflight operations
      on: {
        createGeometry: {
          target: 'determiningWorker',
        },
        exportGeometry: {
          target: 'exporting',
        },
      },
      invoke: {
        id: 'determineWorkerActor',
        src: 'determineWorkerActor',
        input({ context, event }) {
          assertEvent(event, 'createGeometry');
          return {
            context,
            event: { file: event.file, parameters: event.parameters },
          };
        },
        onDone: [
          {
            target: 'ready',
            guard: 'isKernelIssue',
            actions: sendTo(
              ({ context }) => context.parentRef!,
              ({ event }) => event.output,
            ),
          },
          {
            target: 'rendering',
            actions: 'setSelectedWorker',
          },
        ],
        onError: {
          target: 'ready',
          actions: sendTo(
            ({ context }) => context.parentRef!,
            ({ event }) => ({
              type: 'kernelIssue' as const,
              errors: [
                {
                  message: event.error instanceof Error ? event.error.message : 'Failed to determine worker',
                  type: 'runtime' as const,
                  severity: 'error' as const,
                },
              ],
            }),
          ),
        },
      },
    },

    rendering: {
      on: {
        createGeometry: {
          target: 'determiningWorker',
          actions: assign({
            changedPaths({ event }) {
              assertEvent(event, 'createGeometry');
              return event.changedPaths ?? [];
            },
          }),
        },
        exportGeometry: {
          target: 'exporting',
        },
        parametersParsed: {
          actions: sendTo(
            ({ context }) => context.parentRef!,
            ({ event }) => {
              assertEvent(event, 'parametersParsed');
              return event;
            },
          ),
        },
        geometryComputed: {
          target: 'ready',
          actions: sendTo(
            ({ context }) => context.parentRef!,
            ({ event }) => {
              assertEvent(event, 'geometryComputed');
              return event;
            },
          ),
        },
        kernelIssue: {
          target: 'ready',
          actions: sendTo(
            ({ context }) => context.parentRef!,
            ({ event }) => {
              assertEvent(event, 'kernelIssue');
              return event;
            },
          ),
        },
        kernelProgress: {
          actions: sendTo(
            ({ context }) => context.parentRef!,
            ({ event }) => {
              assertEvent(event, 'kernelProgress');
              return event;
            },
          ),
        },
        kernelTelemetry: {
          actions: sendTo(
            ({ context }) => context.parentRef!,
            ({ event }) => {
              assertEvent(event, 'kernelTelemetry');
              return event;
            },
          ),
        },
      },
      invoke: {
        id: 'renderActor',
        src: 'renderActor',
        input({ context, event }) {
          assertEvent(event, 'xstate.done.actor.determineWorkerActor');
          assertEvent(event.output, 'workerDetermined');
          return {
            context,
            event: {
              file: event.output.file,
              parameters: event.output.parameters,
            },
          };
        },
      },
    },

    exporting: {
      // Allow cancelling inflight operations
      on: {
        createGeometry: {
          target: 'determiningWorker',
        },
        exportGeometry: {
          target: 'exporting',
        },
      },
      invoke: {
        id: 'exportGeometryActor',
        src: 'exportGeometryActor',
        input({ context, event }) {
          assertEvent(event, 'exportGeometry');
          return {
            context,
            event,
          };
        },
        onDone: {
          target: 'ready',
          actions: sendTo(
            ({ context }) => context.parentRef!,
            ({ event }) => event.output,
          ),
        },
        onError: {
          target: 'ready',
          actions: sendTo(
            ({ context }) => context.parentRef!,
            ({ event }) => ({
              type: 'geometryExportFailed' as const,
              errors: [
                {
                  message: event.error instanceof Error ? event.error.message : 'Failed to export geometry',
                  type: 'runtime' as const,
                  severity: 'error' as const,
                },
              ],
            }),
          ),
        },
      },
    },
  },
});
