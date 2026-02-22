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
  BundlerConfig,
  PerformanceEntryData,
  RenderPhase,
} from '@taucad/types';
import { isKernelSuccess } from '@taucad/types/guards';
import type { JSONSchema7 } from 'json-schema';
import { KernelWorkerClient, createFileManagerPort } from '@taucad/kernels';
import type { OnLogCallback, OnTelemetryCallback } from '@taucad/kernels';
import type { FileManagerMachine } from '#machines/file-manager.machine.js';
import { runtimeWorkerUrl } from '#constants/kernel-worker.constants.js';

/**
 * Forward worker telemetry entries to the CAD machine for UI display.
 */
function createTelemetryAggregator(_workerId: string, context: KernelContext): OnTelemetryCallback {
  return (entries: PerformanceEntryData[]) => {
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

  const snapshot = await waitFor(context.fileManagerRef, (state) => state.matches('ready'));
  if (!snapshot.context.wrappedWorker) {
    throw new Error('File manager worker not available');
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
    builtinModuleNames: entry.builtinModuleNames,
    options: entry.options,
  }));

  const port = createFileManagerPort(wrappedFileManager);
  await client.initialize(
    { kernelModules, bundlerConfig: context.bundlerConfig },
    port,
    context.middlewareConfig,
    context.bundlerConfig,
  );

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
      const client = await ensureRuntimeWorkerClient(context);

      if (context.changedPaths.length > 0) {
        client.notifyFileChanged(context.changedPaths);
      }

      const canHandle = await client.canHandle(file);

      if (!canHandle) {
        sendBack({
          type: 'kernelIssue',
          errors: [
            {
              message: `No kernel can handle file: ${file.filename}`,
              location: { fileName: file.filename, startLineNumber: 1, startColumn: 1 },
              type: 'runtime',
              severity: 'warning' as const,
            },
          ],
        });
        return;
      }

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
  const { format } = event;

  if (!context.runtimeWorkerClient) {
    return {
      type: 'geometryExportFailed',
      errors: [
        {
          message: 'Runtime worker not initialized',
          type: 'runtime',
          severity: 'error' as const,
        },
      ],
    };
  }

  try {
    const result = await context.runtimeWorkerClient.exportGeometry(format);

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
  | KernelEventWorker
  | { type: 'kernelInitialized' };
type KernelEventExternalDone = DoneActorEvent<KernelEventExternal, KernelActorNames>;

type KernelEvent = KernelEventExternalDone | KernelEventInternal | RenderEvent;

// Interface defining the context for the Kernel machine
type KernelContext = {
  kernelConfig: KernelConfig;
  middlewareConfig: MiddlewareConfig;
  bundlerConfig?: BundlerConfig;
  runtimeWorkerClient?: KernelWorkerClient;
  parentRef?: CadActor;
  fileManagerRef?: ActorRefFrom<FileManagerMachine>;
  changedPaths: string[];
};

type KernelInput = {
  fileManagerRef?: ActorRefFrom<FileManagerMachine>;
  kernelConfig: KernelConfig;
  middlewareConfig: MiddlewareConfig;
  bundlerConfig?: BundlerConfig;
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

    destroyWorkers({ context }) {
      if (context.runtimeWorkerClient) {
        context.runtimeWorkerClient.cleanup();
        context.runtimeWorkerClient.terminate();
        context.runtimeWorkerClient = undefined;
      }
    },
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QGswCcB2YA2A6AlhvgC74CG2+AXoVAMSEnmVWQDaADALqKgAOAe1hMBGXiAAeiAEwA2AJy4AzBwCMqgCwrZ0gByzVSgDQgAnogCsujbmnyOG1bvlKlegOy6Avl5OpMOAREpBTUtHToaAJonDxIIILCpKLiUgiyWsrSSupy8hYq7u4m5ghu0riq7vIZ8qoc2dIWFj5+6Fh4aGBkEKZ0AMYCALZ8AK7EYADiYMNgxGimseKJImLxafIaFfYcsrsaGrLuByWILu64W1VFug1uukqtIP4duF09fWASgmjE07PzRbcZZCVapRCqbIWXAFSEaXSqfLVdyyU4IaqyGG6awWVR7QzHeRPF6BL4-UgYegwAELACi32iEwgS3iK2Sa1AaU0Gg4uGRSns0k08jkxjMiHuuBFNQFKg48ncSlkxPapIZv3CkWiLP4oPZ4IQ9QyuH0+gO6luejRTmhRQFegF+SVmxVATwZMZkDoElgxDIE1wZAAZhM0AAKDgASjoJPd6qZOoSevwKXWEKs0Ic5Q4uIs0hRxXFCHyFQFDwK0gO8qVrtefDIaGElLo9bQZCGc3QsAACg3YOxgazk6nORLeSjnSKlMdXEp9GihZjdO4OBwlXj4dda4FW036FqYoPdUkUxzJIhbhc4Qr5ccGhZUUWRSbCc55c5ZJ-vL5nqr3QA3ChRn9cJqQ7QEAGFhjGBMjyTE8R3PMpblwPYlFhDR3DzEVKzRZcLg4Fc8ycHMDAsDRtwAoCQObA9EzZU8DT2aE5AaWQrEaGU0S2RQLEIrCFB0AoOAeSjcDAQDsGAplvV9f0wEDEN0AjaNY3EyTpIHOJjzBNMEF0SspUVSFBUOeVpDwzwYSIppPE8GUxIPAZoPGKYZnAhZ6OHM80gnSpywsGo+OCsVSnhJQYWkOQEQRJoHFkR4fzUpyPV+f4PKBbT4N00dDQaGwinqfjFXI0KJSiyoMTnAyDgKb82jdcS0CiNAGGCZhqDALyEJ8yxAtQix3EhbQUUvBc8RfVcH3caRSPqb8fwwAQIDgcRYxBHqDQAWkRbZMMcQ4US2B40WhacNHkewtAUET9jExgQhYWgNpypCmgqG5mnxOpDmaBd8lsA59ErHQqk-MT3l6F79T0+oAcwlcXAUREGjwxEYXYtQeSiiikr-cT42eodNthuQl3Q-IFT2TZdjRdDVClXZZqqIVLt0QbHPjSBocY2GOJhWVVFxaqql0NFPwuZoHhmxVqluRKGrrPsiZ0mHcp2g4pX2zQjgyB1rSVE0Es8diLv0PZlTxxqJOoikoB5xC0kcXRKkRKp1GOOx2O4vNLmsFQ6lI6xDEcjT5IgB3evSVwjJcL6DDxZc0R2XAHBXawos-HkFd-a3muiSODQRaEJZlPZl3kE6iyUDRoSFnQ1Erci7PcHwfCAA */
  id: 'kernel',
  context: ({ input }) => ({
    kernelConfig: input.kernelConfig,
    middlewareConfig: input.middlewareConfig,
    bundlerConfig: input.bundlerConfig,
    runtimeWorkerClient: undefined,
    parentRef: undefined,
    fileManagerRef: input.fileManagerRef,
    changedPaths: [],
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
              context.runtimeWorkerClient?.configureMiddleware(event.middlewareConfig);
            },
          ],
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
      // Allow cancelling inflight operations
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
