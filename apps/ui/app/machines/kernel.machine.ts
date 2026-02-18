import { assign, assertEvent, setup, sendTo, fromPromise, waitFor } from 'xstate';
import deepmerge from 'deepmerge';
import type { Snapshot, ActorRef, OutputFrom, DoneActorEvent, ActorRefFrom } from 'xstate';
import { proxy, wrap, transfer, createEndpoint } from 'comlink';
import type { Remote } from 'comlink';
import type {
  Geometry,
  ExportFormat,
  KernelIssue,
  GeometryFile,
  LogLevel,
  LogOrigin,
  OnWorkerLog,
  KernelConfig,
  KernelWorkerInterface,
} from '@taucad/types';
import { isKernelSuccess } from '@taucad/types/guards';
import type { JSONSchema7 } from 'json-schema';
import { assertActorDoneEvent } from '#lib/xstate.js';
import type { FileManagerMachine } from '#machines/file-manager.machine.js';

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

  // Check cache -- but only if the cached worker is still available
  const cached = context.workerSelectionCache.get(cacheKey);
  if (cached && context.wrappedWorkers.has(cached)) {
    return { type: 'workerDetermined', worker: cached, parameters: event.parameters, file: event.file };
  }

  // Query workers in config-defined priority order (array position = priority)
  for (const entry of context.kernelConfig) {
    const worker = context.wrappedWorkers.get(entry.id);
    if (!worker) {
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop -- Need to check workers sequentially
      const canHandle = await worker.canHandleEntry(event.file);
      if (canHandle) {
        context.workerSelectionCache.set(cacheKey, entry.id);
        return { type: 'workerDetermined', worker: entry.id, parameters: event.parameters, file: event.file };
      }
    } catch (error) {
      console.warn(`Worker ${entry.id} canHandle error:`, error);
    }
  }

  // No worker found
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

const createWorkersActor = fromPromise<
  { type: 'kernelInitialized' } | { type: 'kernelIssue'; errors: KernelIssue[] },
  { context: KernelContext }
>(async ({ input }) => {
  const { context } = input;
  const { kernelConfig } = context;

  // Clean up any existing workers (cleanup before terminate, mirroring destroyWorkers)
  for (const [id, rawWorker] of context.workers) {
    // eslint-disable-next-line no-await-in-loop -- Sequential cleanup avoids race conditions
    await context.wrappedWorkers.get(id)?.cleanupEntry();
    rawWorker.terminate();
  }

  context.workers.clear();
  context.wrappedWorkers.clear();

  try {
    // Wait for file manager to be ready and extract the wrapped worker
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

    // Wait for file manager to be ready OR error state (prevents infinite hang)
    const snapshot = await waitFor(context.fileManagerRef, (state) => state.matches('ready') || state.matches('error'));

    // Handle file manager error state
    if (snapshot.matches('error')) {
      const errorMessage = snapshot.context.error?.message ?? 'File manager initialization failed';
      return {
        type: 'kernelIssue',
        errors: [
          {
            message: errorMessage,
            type: 'runtime',
            severity: 'error',
          },
        ],
      };
    }

    const fileManagerContext = snapshot.context;
    const wrappedFileManager = fileManagerContext.wrappedWorker;

    if (!wrappedFileManager) {
      return {
        type: 'kernelIssue',
        errors: [
          {
            message: 'File manager worker not initialized',
            type: 'runtime',
            severity: 'error' as const,
          },
        ],
      };
    }

    const onLog: OnWorkerLog = (log) => {
      if (context.parentRef) {
        context.parentRef.send({
          type: 'kernelLog',
          level: log.level,
          message: log.message,
          origin: log.origin,
          data: log.data,
        });
      }
    };

    // Initialize workers dynamically from the config array
    const initPromises: Array<Promise<void>> = [];

    for (const entry of kernelConfig) {
      const worker = new Worker(entry.url, { type: 'module' });
      context.workers.set(entry.id, worker);

      const wrappedWorker = wrap<KernelWorkerInterface>(worker);
      context.wrappedWorkers.set(entry.id, wrappedWorker);

      // eslint-disable-next-line no-await-in-loop -- Sequential port creation is required
      const port = await wrappedFileManager[createEndpoint]();

      initPromises.push(
        wrappedWorker.initializeEntry(proxy({ onLog }), transfer({ fileManagerPort: port }, [port]), entry.options ?? {}),
      );
    }

    await Promise.all(initPromises);

    // Return success result
    return { type: 'kernelInitialized' };
  } catch (error) {
    // Handle initialization errors
    const errorMessage = error instanceof Error ? error.message : 'Failed to initialize workers';
    return {
      type: 'kernelIssue',
      errors: [
        {
          message: errorMessage,
          type: 'kernel',
          severity: 'error' as const,
        },
      ],
    };
  }
});

const parseParametersActor = fromPromise<
  | {
      type: 'parametersParsed';
      defaultParameters: Record<string, unknown>;
      file: GeometryFile;
      parameters: Record<string, unknown>;
      jsonSchema: JSONSchema7;
    }
  | {
      type: 'kernelIssue';
      errors: KernelIssue[];
    },
  {
    context: KernelContext;
    event: { file: GeometryFile; parameters: Record<string, unknown> };
  }
>(async ({ input }) => {
  const { context, event } = input;
  const { selectedWorker } = context;
  const { file } = event;

  // Get the correct worker based on selected worker
  if (!selectedWorker) {
    return {
      type: 'kernelIssue',
      errors: [
        {
          message: 'No worker selected',
          location: { fileName: file.filename, startLineNumber: 1, startColumn: 1 },
          type: 'compilation',
          severity: 'error' as const,
        },
      ],
    };
  }

  const wrappedWorker = context.wrappedWorkers.get(selectedWorker);

  if (!wrappedWorker) {
    return {
      type: 'kernelIssue',
      errors: [
        {
          message: `${selectedWorker} worker not initialized`,
          location: { fileName: file.filename, startLineNumber: 1, startColumn: 1 },
          type: 'compilation',
          severity: 'error' as const,
        },
      ],
    };
  }

  try {
    const parametersResult = await wrappedWorker.getParametersEntry(file);

    if (isKernelSuccess(parametersResult)) {
      const { defaultParameters, jsonSchema } = parametersResult.data as {
        defaultParameters: Record<string, unknown>;
        jsonSchema: JSONSchema7;
      };

      return {
        type: 'parametersParsed',
        defaultParameters,
        file,
        parameters: event.parameters,
        jsonSchema,
      };
    }

    // If extraction fails, return error from the worker
    return {
      type: 'kernelIssue',
      errors: parametersResult.issues,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Error extracting parameters';
    console.error('Error extracting parameters:', errorMessage);

    // Return the error as a kernel issue so it's displayed in the UI
    return {
      type: 'kernelIssue',
      errors: [
        {
          message: errorMessage,
          location: { fileName: file.filename, startLineNumber: 1, startColumn: 1 },
          type: 'runtime',
          severity: 'error' as const,
        },
      ],
    };
  }
});

const evaluateCodeActor = fromPromise<
  | {
      type: 'geometryComputed';
      geometries: Geometry[];
      issues: KernelIssue[];
    }
  | {
      type: 'kernelIssue';
      errors: KernelIssue[];
    },
  {
    context: KernelContext;
    event: {
      defaultParameters: Record<string, unknown>;
      parameters: Record<string, unknown>;
      file: GeometryFile;
    };
  }
>(async ({ input }) => {
  const { context, event } = input;
  const { selectedWorker } = context;
  const { file, defaultParameters, parameters } = event;

  // Get the correct worker based on selected worker
  if (!selectedWorker) {
    return {
      type: 'kernelIssue',
      errors: [
        {
          message: 'No worker selected',
          location: { fileName: file.filename, startLineNumber: 1, startColumn: 1 },
          type: 'runtime',
          severity: 'error' as const,
        },
      ],
    };
  }

  const wrappedWorker = context.wrappedWorkers.get(selectedWorker);

  if (!wrappedWorker) {
    return {
      type: 'kernelIssue',
      errors: [
        {
          message: `${selectedWorker} worker not initialized`,
          location: { fileName: file.filename, startLineNumber: 1, startColumn: 1 },
          type: 'runtime',
          severity: 'error' as const,
        },
      ],
    };
  }

  // Merge default parameters with provided parameters
  const mergedParameters = deepmerge(defaultParameters, parameters);

  try {
    const result = await wrappedWorker.createGeometryEntry(file, mergedParameters);

    // Handle the result pattern
    if (isKernelSuccess(result)) {
      // Return geometries with any warnings from the success result
      return { type: 'geometryComputed', geometries: result.data, issues: result.issues };
    }

    return {
      type: 'kernelIssue',
      errors: result.issues,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Error evaluating code';

    return {
      type: 'kernelIssue',
      errors: [
        {
          message: errorMessage,
          location: { fileName: file.filename, startLineNumber: 1, startColumn: 1 },
          type: 'runtime',
          severity: 'error' as const,
        },
      ],
    };
  }
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

  const wrappedWorker = context.wrappedWorkers.get(selectedWorker);

  if (!wrappedWorker) {
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
    const supportedFormats = await wrappedWorker.getExportFormats();
    if (!supportedFormats.includes(format)) {
      return {
        type: 'geometryExportFailed',
        errors: [
          {
            message: `Unsupported export format: ${format}`,
            type: 'runtime',
            severity: 'error' as const,
          },
        ],
      };
    }

    // TODO: add a proper type guard for the export format
    const result = await wrappedWorker.exportGeometryEntry(format as never);

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
  parseParametersActor,
  evaluateCodeActor,
  exportGeometryActor,
} as const;
type KernelActorNames = keyof typeof kernelActors;

// Define the types of events the machine can receive
type KernelEventInternal =
  | { type: 'initializeKernel'; parentRef: CadActor }
  | { type: 'createGeometry'; file: GeometryFile; parameters: Record<string, unknown> }
  | { type: 'exportGeometry'; format: ExportFormat };

// Define the events that the workers can send to the kernel machine
type KernelEventWorker = {
  type: 'kernelLog';
  level: LogLevel;
  message: string;
  origin?: LogOrigin;
  data?: unknown;
};

// The kernel machine simply sends the output of the actors to the parent machine.
export type KernelEventExternal = OutputFrom<(typeof kernelActors)[KernelActorNames]> | KernelEventWorker;
type KernelEventExternalDone = DoneActorEvent<KernelEventExternal, KernelActorNames>;

type KernelEvent = KernelEventExternalDone | KernelEventInternal;

// Interface defining the context for the Kernel machine
type KernelContext = {
  kernelConfig: KernelConfig;
  workers: Map<string, Worker>;
  wrappedWorkers: Map<string, Remote<KernelWorkerInterface>>;
  workerSelectionCache: Map<string, string>;
  parentRef?: CadActor;
  selectedWorker?: string;
  fileManagerRef?: ActorRefFrom<FileManagerMachine>;
};

type KernelInput = {
  fileManagerRef?: ActorRefFrom<FileManagerMachine>;
  kernelConfig: KernelConfig;
};

/**
 * Kernel Machine
 *
 * This machine manages the WebWorkers that run the CAD operations:
 * - Dynamically creates workers from injected URLs (KernelConfig)
 * - Handles communication with the correct worker based on kernel type
 * - Processes results from CAD operations
 *
 * The machine is agnostic to which kernels exist -- worker URLs, priority,
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
    async destroyWorkers({ context }) {
      for (const [id, worker] of context.workers) {
        // eslint-disable-next-line no-await-in-loop -- Sequential cleanup avoids race conditions
        await context.wrappedWorkers.get(id)?.cleanupEntry();
        worker.terminate();
      }

      context.workers.clear();
      context.wrappedWorkers.clear();
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
    workers: new Map(),
    wrappedWorkers: new Map(),
    workerSelectionCache: new Map(),
    parentRef: undefined,
    selectedWorker: undefined,
    fileManagerRef: input.fileManagerRef,
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
        },
        exportGeometry: {
          target: 'exporting',
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
            target: 'parsing',
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

    parsing: {
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
        id: 'parseParametersActor',
        src: 'parseParametersActor',
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
            target: 'evaluating',
            actions: sendTo(
              ({ context }) => context.parentRef!,
              ({ event }) => event.output,
            ),
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
                  message: event.error instanceof Error ? event.error.message : 'Failed to parse parameters',
                  type: 'runtime' as const,
                  severity: 'error' as const,
                },
              ],
            }),
          ),
        },
      },
    },

    evaluating: {
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
        id: 'evaluateCodeActor',
        src: 'evaluateCodeActor',
        input({ context, event }) {
          assertEvent(event, 'xstate.done.actor.parseParametersActor');
          assertEvent(event.output, 'parametersParsed');
          return {
            context,
            event: event.output,
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
              type: 'kernelIssue' as const,
              errors: [
                {
                  message: event.error instanceof Error ? event.error.message : 'Failed to evaluate code',
                  type: 'runtime' as const,
                  severity: 'error' as const,
                },
              ],
            }),
          ),
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
