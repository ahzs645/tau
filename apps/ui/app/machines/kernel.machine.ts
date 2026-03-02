import { assign, assertEvent, setup, sendTo, fromPromise, waitFor } from 'xstate';
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
import type { FileManagerMachine } from '#machines/file-manager.machine.js';

/**
 * Lazily create and connect the KernelClient for this CU.
 * Uses the v2 createKernelClient factory with plugin factories.
 * No-op if the client already exists and is connected.
 *
 * Subscribes to all client events once on creation:
 * - `geometry` / `progress` / `parametersResolved` -> forwarded to kernel machine (which forwards to parent)
 * - `log` / `telemetry` -> forwarded directly to parent
 */
async function ensureKernelClient(context: KernelContext, machineRef: AnyActorRef): Promise<KernelClient> {
  if (context.kernelClient) {
    return context.kernelClient;
  }

  if (!context.fileManagerRef) {
    throw new Error('File manager not initialized');
  }

  const snapshot = await waitFor(context.fileManagerRef, (state) => state.matches('ready'));

  if (context.destroyed) {
    throw new Error('Kernel machine was stopped during initialization');
  }

  if (!snapshot.context.worker) {
    throw new Error('File manager worker not available');
  }

  const client = createKernelClient(context.kernelOptions);
  context.kernelClient = client;

  // Subscribe to events that the kernel machine handles (state transitions + parent forwarding)
  context.eventCleanups.push(
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

  // Subscribe to events forwarded directly to parent
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

  const { port, dispose } = createFileSystemBridge(snapshot.context.worker);
  context.eventCleanups.push(dispose);
  await client.connect({ port });

  return client;
}

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
  | { type: 'createGeometry'; file: GeometryFile; parameters: Record<string, unknown>; changedPaths?: string[] }
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

    fireRender({ context, event, self }) {
      assertEvent(event, 'createGeometry');
      const { file, parameters, changedPaths } = event;

      void (async () => {
        try {
          const client = await ensureKernelClient(context, self);
          await client.render({
            file,
            parameters,
            changedPaths: changedPaths && changedPaths.length > 0 ? changedPaths : undefined,
          });
        } catch (error) {
          if (isRenderSupersededError(error)) {
            return;
          }

          console.error('[KernelMachine] fireRender error:', error);
          const errorMessage = error instanceof Error ? error.message : 'error rendering geometry';
          self.send({
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
    },

    destroyWorkers({ context }) {
      context.destroyed = true;

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
    eventCleanups: [],
    destroyed: false,
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
        },
        exportGeometry: {
          target: 'exporting',
        },
      },
    },

    rendering: {
      entry: 'fireRender',
      on: {
        createGeometry: {
          target: 'rendering',
          reenter: true,
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
