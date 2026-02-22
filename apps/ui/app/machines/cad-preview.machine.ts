import { assign, setup, fromPromise, enqueueActions } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type { GeometryFile } from '@taucad/types';
import type { cadMachine } from '#machines/cad.machine.js';

/**
 * Input for the prepareFiles actor. Passed via invoke input.
 */
export type PrepareFilesInput = {
  readonly files?: Record<string, { content: Uint8Array<ArrayBuffer> }>;
  readonly buildId: string;
};

type CadPreviewContext = {
  cadRef: ActorRefFrom<typeof cadMachine>;
  buildId: string;
  mainFile: string;
  files?: Record<string, { content: Uint8Array<ArrayBuffer> }>;
  parameters: Record<string, unknown>;
  initError?: Error;
};

type CadPreviewInput = {
  cadRef: ActorRefFrom<typeof cadMachine>;
  buildId: string;
  mainFile: string;
  files?: Record<string, { content: Uint8Array<ArrayBuffer> }>;
  parameters?: Record<string, unknown>;
};

type CadPreviewEvent =
  | { type: 'start' }
  | { type: 'setParameters'; parameters: Record<string, unknown> }
  | { type: 'retry' };

/**
 * Default prepareFiles actor -- throws to enforce injection via `.provide()`.
 * Follows the same pattern as buildMachine's `loadBuildActor`.
 */
const prepareFilesActor = fromPromise<void, PrepareFilesInput>(async () => {
  throw new Error('Not implemented. Supply via cadPreviewMachine.provide({ actors: { prepareFiles } }).');
});

/**
 * Lightweight state machine that orchestrates the CAD preview lifecycle:
 *
 *   idle  -->  preparingFiles  -->  active
 *                    |
 *                    v
 *                  error  -->  (retry) --> preparingFiles
 *
 * File preparation is injected via `.provide()` (same pattern as buildMachine's loadBuildActor).
 * On successful preparation, sends `initializeKernel` + `initializeModel` to the cadRef actor.
 */
export const cadPreviewMachine = setup({
  types: {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    context: {} as CadPreviewContext,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    input: {} as CadPreviewInput,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    events: {} as CadPreviewEvent,
  },
  actors: {
    prepareFiles: prepareFilesActor,
  },
  actions: {
    initializeCadModel: enqueueActions(({ enqueue, context }) => {
      const file: GeometryFile = {
        path: `/builds/${context.buildId}`,
        filename: context.mainFile,
      };

      enqueue.sendTo(context.cadRef, {
        type: 'initializeModel',
        file,
        parameters: context.parameters,
      });
    }),
    forwardSetParameters: enqueueActions(({ enqueue, context, event }) => {
      if (event.type === 'setParameters') {
        enqueue.sendTo(context.cadRef, {
          type: 'setParameters',
          parameters: event.parameters,
        });
      }
    }),
  },
}).createMachine({
  id: 'cadPreview',
  context: ({ input }) => ({
    cadRef: input.cadRef,
    buildId: input.buildId,
    mainFile: input.mainFile,
    files: input.files,
    parameters: input.parameters ?? {},
    initError: undefined,
  }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        start: 'preparingFiles',
      },
    },
    preparingFiles: {
      invoke: {
        src: 'prepareFiles',
        input: ({ context }): PrepareFilesInput => ({
          files: context.files,
          buildId: context.buildId,
        }),
        onDone: {
          target: 'active',
          actions: 'initializeCadModel',
        },
        onError: {
          target: 'error',
          actions: assign({
            initError: ({ event }) => (event.error instanceof Error ? event.error : new Error(String(event.error))),
          }),
        },
      },
    },
    active: {
      on: {
        setParameters: {
          actions: 'forwardSetParameters',
        },
      },
    },
    error: {
      on: {
        retry: 'preparingFiles',
      },
    },
  },
});
