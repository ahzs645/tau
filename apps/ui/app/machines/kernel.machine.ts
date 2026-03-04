import { assign, assertEvent, setup, sendTo, fromPromise, waitFor, enqueueActions } from 'xstate';
import type { Snapshot, ActorRef, OutputFrom, DoneActorEvent, ActorRefFrom, AnyActorRef } from 'xstate';
import type { Geometry, ExportFormat, GeometryFile, LogLevel, LogOrigin } from '@taucad/types';
import type { JSONSchema7 } from 'json-schema';
import { createKernelClient, isRenderSupersededError } from '@taucad/kernels';
import type {
  KernelClient,
  KernelClientOptions,
  KernelIssue,
  GetParametersResult,
  PerformanceEntryData,
  RenderPhase,
} from '@taucad/kernels';
import { createFileSystemBridge } from '@taucad/kernels/filesystem';
import { safeDispose } from '@taucad/utils/dispose';
import type { FileManagerMachine } from '#machines/file-manager.machine.js';

type PendingRender = {
  file: GeometryFile;
  parameters: Record<string, unknown>;
  changedPaths?: string[];
};

type KernelMachineEvent =
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

type InitKernelResult = {
  client: KernelClient;
  cleanups: Array<() => void>;
};

/**
 * Creates and connects a KernelClient, subscribes to all events.
 * Returns the client and cleanup functions for use via assign().
 */
const initKernelActor = fromPromise<InitKernelResult, { context: KernelContext; machineRef: AnyActorRef }>(
  async ({ input, signal }) => {
    const { context, machineRef } = input;
    console.debug('[Kernel] initKernelActor: start', {
      hasFileManager: Boolean(context.fileManagerRef),
      hasParentRef: Boolean(context.parentRef),
    });

    if (!context.fileManagerRef) {
      console.error('[Kernel] initKernelActor: no fileManagerRef');
      throw new Error('File manager not initialized');
    }

    console.debug('[Kernel] initKernelActor: waiting for file manager ready...');
    const snapshot = await waitFor(context.fileManagerRef, (state) => state.matches('ready'));

    console.debug('[Kernel] initKernelActor: file manager ready', {
      hasWorker: Boolean(snapshot.context.worker),
    });

    if (signal.aborted) {
      console.debug('[Kernel] initKernelActor: aborted during init');
      throw new Error('Kernel machine was stopped during initialization');
    }

    if (!snapshot.context.worker) {
      console.error('[Kernel] initKernelActor: file manager has no worker');
      throw new Error('File manager worker not available');
    }

    console.debug('[Kernel] initKernelActor: creating kernel client...');
    const client = createKernelClient(context.kernelOptions);
    const cleanups: Array<() => void> = [];

    cleanups.push(
      client.on('geometry', (result) => {
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
      client.on('progress', (phase: RenderPhase) => {
        machineRef.send({ type: 'kernelProgress', phase });
      }),
      client.on('parametersResolved', (parametersResult: GetParametersResult) => {
        if (parametersResult.success) {
          const data = parametersResult.data as {
            defaultParameters: Record<string, unknown>;
            jsonSchema: JSONSchema7;
          };
          machineRef.send({
            type: 'parametersParsed',
            defaultParameters: data.defaultParameters,
            jsonSchema: data.jsonSchema,
          });
        }
      }),
    );

    if (context.parentRef) {
      const { parentRef } = context;

      cleanups.push(
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

    const { port, dispose } = createFileSystemBridge(snapshot.context.worker);
    cleanups.push(dispose);
    console.debug('[Kernel] initKernelActor: connecting client...');
    await client.connect({ port });

    console.debug('[Kernel] initKernelActor: connected successfully');
    return { client, cleanups };
  },
);

type RenderActorInput = {
  client: KernelClient;
  file: GeometryFile;
  parameters: Record<string, unknown>;
  changedPaths?: string[];
};

const renderActor = fromPromise<void, RenderActorInput>(async ({ input, signal }) => {
  const { client, file, parameters, changedPaths } = input;
  console.debug('[Kernel] renderActor: start', {
    file: file.filename,
    changedPaths,
  });

  try {
    await client.render({
      file,
      parameters,
      changedPaths: changedPaths && changedPaths.length > 0 ? changedPaths : undefined,
    });
  } catch (error) {
    if (isRenderSupersededError(error) || signal.aborted) {
      return;
    }

    throw error;
  }
});

const exportGeometryActor = fromPromise<
  | { type: 'geometryExported'; blob: Blob; format: ExportFormat }
  | { type: 'geometryExportFailed'; errors: KernelIssue[] },
  { context: KernelContext; event: { format: ExportFormat } }
>(async ({ input, signal }) => {
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

  if (signal.aborted) {
    return {
      type: 'geometryExportFailed',
      errors: [
        {
          message: 'Export cancelled',
          type: 'runtime',
          severity: 'error' as const,
        },
      ],
    };
  }

  try {
    const result = await context.kernelClient.export(format);

    // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive check
    if (signal.aborted) {
      return {
        type: 'geometryExportFailed',
        errors: [
          {
            message: 'Export cancelled',
            type: 'runtime',
            severity: 'error' as const,
          },
        ],
      };
    }

    if (result.success) {
      const { data } = result;
      const blob = new Blob([data.bytes], { type: data.mimeType });
      return { type: 'geometryExported', blob, format };
    }

    return {
      type: 'geometryExportFailed',
      errors: result.issues,
    };
  } catch (error) {
    // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive check
    if (signal.aborted) {
      return {
        type: 'geometryExportFailed',
        errors: [
          {
            message: 'Export cancelled',
            type: 'runtime',
            severity: 'error' as const,
          },
        ],
      };
    }

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
  exportGeometryActor,
} as const;
type KernelActorNames = keyof typeof kernelActors;

type KernelEventInternal =
  | { type: 'initializeKernel'; parentRef: CadActor }
  | {
      type: 'createGeometry';
      file: GeometryFile;
      parameters: Record<string, unknown>;
      changedPaths?: string[];
    }
  | { type: 'exportGeometry'; format: ExportFormat };

type KernelEventWorker = {
  type: 'kernelLog';
  level: LogLevel;
  message: string;
  origin?: LogOrigin;
  data?: unknown;
};

export type KernelEventExternal =
  | OutputFrom<(typeof kernelActors)[KernelActorNames]>
  | KernelMachineEvent
  | KernelEventWorker
  | { type: 'kernelInitialized' };
type KernelEventExternalDone = DoneActorEvent<KernelEventExternal, KernelActorNames>;

type KernelEvent = KernelEventExternalDone | KernelEventInternal | KernelMachineEvent;

type KernelContext = {
  kernelOptions: KernelClientOptions;
  kernelClient?: KernelClient;
  parentRef?: CadActor;
  fileManagerRef?: ActorRefFrom<FileManagerMachine>;
  eventCleanups: Array<() => void>;
  destroyed: boolean;
  pendingRender?: PendingRender;
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
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- type assertion required
    context: {} as KernelContext,

    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- type assertion required
    events: {} as KernelEvent,

    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- type assertion required
    input: {} as KernelInput,
  },
  actors: {
    ...kernelActors,
    initKernelActor,
    renderActor,
  },
  guards: {
    hasKernelClient: ({ context }) => Boolean(context.kernelClient),
  },
  actions: {
    registerParentRef: assign({
      parentRef({ event }) {
        assertEvent(event, 'initializeKernel');
        return event.parentRef;
      },
    }),

    storePendingRender: assign({
      pendingRender({ event }) {
        assertEvent(event, 'createGeometry');
        return {
          file: event.file,
          parameters: event.parameters,
          changedPaths: event.changedPaths,
        };
      },
    }),

    destroyWorkers: assign(({ context }) => {
      for (const cleanup of context.eventCleanups) {
        safeDispose(cleanup);
      }

      safeDispose(() => context.kernelClient?.terminate());

      return {
        destroyed: true,
        eventCleanups: [],
        kernelClient: undefined,
      };
    }),
  },
}).createMachine({
  id: 'kernel',
  context: ({ input }) => ({
    kernelOptions: input.kernelOptions,
    kernelClient: undefined,
    parentRef: undefined,
    fileManagerRef: input.fileManagerRef,
    eventCleanups: [],
    destroyed: false,
    pendingRender: undefined,
  }),
  initial: 'initializing',
  exit: ['destroyWorkers'],
  states: {
    initializing: {
      entry() {
        console.debug('[Kernel] state → initializing');
      },
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
      entry({ context }) {
        console.debug('[Kernel] state → ready', {
          hasClient: Boolean(context.kernelClient),
        });
      },
      on: {
        createGeometry: [
          {
            target: 'rendering',
            guard: 'hasKernelClient',
            actions: 'storePendingRender',
          },
          {
            target: 'connectingKernel',
            actions: 'storePendingRender',
          },
        ],
        exportGeometry: {
          target: 'exporting',
        },
      },
    },

    connectingKernel: {
      entry() {
        console.debug('[Kernel] state → connectingKernel');
      },
      invoke: {
        id: 'initKernelActor',
        src: 'initKernelActor',
        input({ context, self }) {
          return { context, machineRef: self };
        },
        onDone: {
          target: 'rendering',
          actions: assign(({ event }) => {
            console.debug('[Kernel] initKernelActor: onDone → assigning client');
            return {
              kernelClient: event.output.client,
              eventCleanups: event.output.cleanups,
            };
          }),
        },
        onError: {
          target: 'ready',
          actions: enqueueActions(({ enqueue, context, event }) => {
            console.error('[Kernel] initKernelActor: onError', event.error);
            if (context.parentRef) {
              enqueue.sendTo(context.parentRef, {
                type: 'kernelIssue' as const,
                errors: [
                  {
                    message: event.error instanceof Error ? event.error.message : 'Failed to initialize kernel',
                    type: 'runtime' as const,
                    severity: 'error' as const,
                  },
                ],
              });
            }
          }),
        },
      },
      on: {
        createGeometry: {
          actions: 'storePendingRender',
        },
      },
    },

    rendering: {
      entry({ context }) {
        console.debug('[Kernel] state → rendering', {
          file: context.pendingRender?.file.filename,
        });
      },
      invoke: {
        id: 'renderActor',
        src: 'renderActor',
        input({ context }) {
          return {
            client: context.kernelClient!,
            file: context.pendingRender!.file,
            parameters: context.pendingRender!.parameters,
            changedPaths: context.pendingRender!.changedPaths,
          };
        },
        onError: {
          target: 'ready',
          actions: enqueueActions(({ enqueue, context, event }) => {
            if (context.parentRef) {
              enqueue.sendTo(context.parentRef, {
                type: 'kernelIssue' as const,
                errors: [
                  {
                    message: event.error instanceof Error ? event.error.message : 'error rendering geometry',
                    type: 'runtime' as const,
                    severity: 'error' as const,
                  },
                ],
              });
            }
          }),
        },
      },
      on: {
        createGeometry: {
          target: 'rendering',
          reenter: true,
          actions: 'storePendingRender',
        },
        exportGeometry: {
          target: 'exporting',
        },
        parametersParsed: {
          actions: enqueueActions(({ enqueue, context, event }) => {
            assertEvent(event, 'parametersParsed');
            if (context.parentRef) {
              enqueue.sendTo(context.parentRef, event);
            }
          }),
        },
        geometryComputed: {
          target: 'ready',
          actions: enqueueActions(({ enqueue, context, event }) => {
            assertEvent(event, 'geometryComputed');
            if (context.parentRef) {
              enqueue.sendTo(context.parentRef, event);
            }
          }),
        },
        kernelIssue: {
          target: 'ready',
          actions: enqueueActions(({ enqueue, context, event }) => {
            assertEvent(event, 'kernelIssue');
            if (context.parentRef) {
              enqueue.sendTo(context.parentRef, event);
            }
          }),
        },
        kernelProgress: {
          actions: enqueueActions(({ enqueue, context, event }) => {
            assertEvent(event, 'kernelProgress');
            if (context.parentRef) {
              enqueue.sendTo(context.parentRef, event);
            }
          }),
        },
        kernelTelemetry: {
          actions: enqueueActions(({ enqueue, context, event }) => {
            assertEvent(event, 'kernelTelemetry');
            if (context.parentRef) {
              enqueue.sendTo(context.parentRef, event);
            }
          }),
        },
      },
    },

    exporting: {
      on: {
        createGeometry: [
          {
            target: 'rendering',
            guard: 'hasKernelClient',
            actions: 'storePendingRender',
          },
          {
            target: 'connectingKernel',
            actions: 'storePendingRender',
          },
        ],
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
          actions: enqueueActions(({ enqueue, context, event }) => {
            if (context.parentRef) {
              enqueue.sendTo(context.parentRef, event.output);
            }
          }),
        },
        onError: {
          target: 'ready',
          actions: enqueueActions(({ enqueue, context, event }) => {
            if (context.parentRef) {
              enqueue.sendTo(context.parentRef, {
                type: 'geometryExportFailed' as const,
                errors: [
                  {
                    message: event.error instanceof Error ? event.error.message : 'Failed to export geometry',
                    type: 'runtime' as const,
                    severity: 'error' as const,
                  },
                ],
              });
            }
          }),
        },
      },
    },
  },
});
