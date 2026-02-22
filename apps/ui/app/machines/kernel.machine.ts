import { assign, assertEvent, setup, sendTo, fromPromise, fromCallback, waitFor } from 'xstate';
import type { Snapshot, ActorRef, OutputFrom, DoneActorEvent, ActorRefFrom } from 'xstate';
import type { Geometry, ExportFormat, GeometryFile, LogLevel, LogOrigin } from '@taucad/types';
import type { JSONSchema7 } from 'json-schema';
import { createKernelClient, isKernelSuccess } from '@taucad/kernels';
import type {
  KernelClient,
  KernelClientOptions,
  KernelIssue,
  GetParametersResult,
  KernelFileSystem,
  PerformanceEntryData,
  RenderPhase,
} from '@taucad/kernels';
import type { FileManagerMachine } from '#machines/file-manager.machine.js';

/**
 * Lazily create and connect the KernelClient for this CU.
 * Uses the v2 createKernelClient factory with plugin factories.
 * No-op if the client already exists and is connected.
 */
async function ensureKernelClient(context: KernelContext): Promise<KernelClient> {
  if (context.kernelClient) {
    return context.kernelClient;
  }

  if (!context.fileManagerRef) {
    throw new Error('File manager not initialized');
  }

  const snapshot = await waitFor(context.fileManagerRef, (state) => state.matches('ready'));
  if (!snapshot.context.wrappedWorker) {
    throw new Error('File manager worker not available');
  }

  const fm = snapshot.context.wrappedWorker;
  const client = createKernelClient(context.kernelOptions);
  context.kernelClient = client;

  // Subscribe to events and forward to parent machine
  if (context.parentRef) {
    const { parentRef } = context;

    context.eventCleanups.push(
      client.on('log', (entry) => {
        parentRef.send({
          type: 'kernelLog',
          level: entry.level as LogLevel,
          message: entry.message,
          origin: entry.origin,
          data: entry.data,
        });
      }),
      client.on('telemetry', (entries) => {
        parentRef.send({ type: 'kernelTelemetry', entries });
      }),
    );
  }

  // Adapt the Comlink Remote<FileManager> to the KernelFileSystem interface.
  // All methods use arrow functions to avoid Comlink Proxy traps intercepting
  // .apply/.bind calls when the bridge dispatches via fn(...args).
  await client.connect({
    fileSystem: {
      readFile: (async (path: string, encoding?: 'utf8') =>
        encoding ? fm.readFile(path, encoding) : fm.readFile(path)) as KernelFileSystem['readFile'],
      writeFile: async (path, data) => fm.writeFile(path, data),
      mkdir: async (path, options) => fm.mkdir(path, options),
      readdir: async (path) => fm.readdir(path),
      unlink: async (path) => fm.unlink(path),
      stat: async (path) => fm.stat(path),
      exists: async (path) => fm.exists(path),
    },
  });

  return client;
}

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
  const { file, parameters } = event;

  void (async () => {
    try {
      const client = await ensureKernelClient(context);

      if (context.changedPaths.length > 0) {
        client.notifyFileChanged(context.changedPaths);
      }

      // Subscribe to per-render events
      const offProgress = client.on('progress', (phase: RenderPhase) => {
        sendBack({ type: 'kernelProgress', phase });
      });

      const offParameters = client.on('parametersResolved', (parametersResult: GetParametersResult) => {
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
      });

      const result = await client.render(file, parameters);

      offProgress();
      offParameters();

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
      const errorMessage = error instanceof Error ? error.message : 'error rendering geometry';
      sendBack({
        type: 'kernelIssue',
        errors: [
          {
            message: errorMessage,
            location: { fileName: file.filename, startLineNumber: 1, startColumn: 1 },
            type: 'runtime' as const,
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
  const { format } = event;

  if (!context.kernelClient) {
    return {
      type: 'geometryExportFailed',
      errors: [
        {
          message: 'Kernel client not initialized',
          type: 'runtime',
          severity: 'error' as const,
        },
      ],
    };
  }

  try {
    const result = await context.kernelClient.export(format);

    if (isKernelSuccess(result)) {
      const { data } = result;
      if (Array.isArray(data) && data.length > 0 && data[0]?.blob) {
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

const kernelActors = {
  renderActor,
  exportGeometryActor,
} as const;
type KernelActorNames = keyof typeof kernelActors;

type KernelEventInternal =
  | { type: 'initializeKernel'; parentRef: CadActor }
  | { type: 'createGeometry'; file: GeometryFile; parameters: Record<string, unknown>; changedPaths?: string[] }
  | { type: 'exportGeometry'; format: ExportFormat };

type KernelEventWorker = {
  type: 'kernelLog';
  level: LogLevel;
  message: string;
  origin?: LogOrigin;
  data?: unknown;
};

type PromiseActorNames = Exclude<KernelActorNames, 'renderActor'>;

export type KernelEventExternal =
  | OutputFrom<(typeof kernelActors)[PromiseActorNames]>
  | RenderEvent
  | KernelEventWorker
  | { type: 'kernelInitialized' };
type KernelEventExternalDone = DoneActorEvent<KernelEventExternal, KernelActorNames>;

type KernelEvent = KernelEventExternalDone | KernelEventInternal | RenderEvent;

type KernelContext = {
  kernelOptions: KernelClientOptions;
  kernelClient?: KernelClient;
  parentRef?: CadActor;
  fileManagerRef?: ActorRefFrom<FileManagerMachine>;
  changedPaths: string[];
  eventCleanups: Array<() => void>;
};

type KernelInput = {
  fileManagerRef?: ActorRefFrom<FileManagerMachine>;
  kernelOptions: KernelClientOptions;
};

/**
 * Kernel Machine
 *
 * This machine manages the KernelClient for CAD operations:
 * - Lazily creates a KernelClient that manages Worker lifecycle internally
 * - Routes files to the correct kernel via the worker's internal selection
 * - Processes results from CAD operations via event subscription
 *
 * The machine is agnostic to which kernels exist -- kernel plugins, middleware,
 * and bundlers are injected via KernelClientOptions at spawn time.
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

    destroyWorkers({ context }) {
      for (const cleanup of context.eventCleanups) {
        cleanup();
      }

      context.eventCleanups = [];

      if (context.kernelClient) {
        context.kernelClient.terminate();
        context.kernelClient = undefined;
      }
    },
  },
}).createMachine({
  id: 'kernel',
  context: ({ input }) => ({
    kernelOptions: input.kernelOptions,
    kernelClient: undefined,
    parentRef: undefined,
    fileManagerRef: input.fileManagerRef,
    changedPaths: [],
    eventCleanups: [],
  }),
  initial: 'initializing',
  exit: ['destroyWorkers'],
  states: {
    initializing: {
      on: {
        initializeKernel: {
          target: 'ready',
          actions: [
            'registerParentRef',
            sendTo(
              ({ event }) => {
                assertEvent(event, 'initializeKernel');
                return event.parentRef;
              },
              { type: 'kernelInitialized' },
            ),
          ],
        },
      },
    },

    ready: {
      on: {
        createGeometry: {
          target: 'rendering',
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
      },
    },

    rendering: {
      on: {
        createGeometry: {
          target: 'rendering',
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
          assertEvent(event, 'createGeometry');
          return {
            context,
            event: {
              file: event.file,
              parameters: event.parameters,
            },
          };
        },
      },
    },

    exporting: {
      on: {
        createGeometry: {
          target: 'rendering',
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
