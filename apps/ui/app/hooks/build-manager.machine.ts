import { assign, assertEvent, setup, fromPromise } from 'xstate';
import type { OutputFrom, DoneActorEvent } from 'xstate';
import { wrap } from 'comlink';
import type { Remote } from 'comlink';
import { safeDispose } from '@taucad/utils/dispose';
// oxlint-disable-next-line eslint-plugin-import/no-named-as-default -- web worker default import
import ObjectStoreWorker from '#hooks/object-store.worker.js?worker';
import type { ObjectStoreWorker as ObjectStoreWorkerType } from '#hooks/object-store.worker.js';
import { assertActorDoneEvent } from '#lib/xstate.js';

type BuildManagerContext = {
  worker: Worker | undefined;
  wrappedWorker: Remote<ObjectStoreWorkerType> | undefined;
  error: Error | undefined;
};

const initializeWorkerActor = fromPromise<
  | {
      type: 'workerInitialized';
      worker: Worker;
      wrappedWorker: Remote<ObjectStoreWorkerType>;
    }
  | { type: 'workerInitializationFailed'; error: Error },
  { context: BuildManagerContext }
>(async ({ input, signal }) => {
  const { context } = input;
  console.debug('[BuildManager] initializeWorkerActor: start');

  // Clean up any existing worker (error-isolated so failures don't prevent new worker creation)
  if (context.worker) {
    safeDispose(() => context.worker?.terminate());
  }

  if (signal.aborted) {
    console.debug('[BuildManager] initializeWorkerActor: aborted');
    return { type: 'workerInitializationFailed', error: new Error('Aborted') };
  }

  try {
    const worker = new ObjectStoreWorker();
    const wrappedWorker = wrap<ObjectStoreWorkerType>(worker);

    console.debug('[BuildManager] initializeWorkerActor: success');
    return { type: 'workerInitialized', worker, wrappedWorker };
  } catch (error) {
    console.error('[BuildManager] initializeWorkerActor: FAILED', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to initialize worker';
    return {
      type: 'workerInitializationFailed',
      error: new Error(errorMessage),
    };
  }
});

const buildManagerActors = {
  initializeWorkerActor,
} as const;
type BuildManagerActorNames = keyof typeof buildManagerActors;

type BuildManagerEventInternal = { type: 'initialize' };

type BuildManagerEventExternal = OutputFrom<(typeof buildManagerActors)[BuildManagerActorNames]>;
type BuildManagerEventExternalDone = DoneActorEvent<BuildManagerEventExternal, BuildManagerActorNames>;

type BuildManagerEvent = BuildManagerEventExternalDone | BuildManagerEventInternal;

/**
 * Build Manager Machine
 *
 * This machine manages the object-store WebWorker for build operations:
 * - Initializes the worker that wraps IndexedDB operations
 * - Provides access to the wrapped worker for performing CRUD operations
 */
export const buildManagerMachine = setup({
  types: {
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    context: {} as BuildManagerContext,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    events: {} as BuildManagerEvent,
  },
  actors: buildManagerActors,
  actions: {
    setError: assign({
      error({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'workerInitializationFailed');
        return event.output.error;
      },
    }),

    clearError: assign({
      error: undefined,
    }),

    destroyWorker: assign(({ context }) => {
      safeDispose(() => context.worker?.terminate());
      return {
        worker: undefined,
        wrappedWorker: undefined,
      };
    }),

    assignWorkerResources: assign({
      worker({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'workerInitialized');
        return event.output.worker;
      },
      wrappedWorker({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'workerInitialized');
        return event.output.wrappedWorker;
      },
    }),
  },
  guards: {
    isWorkerInitializationFailed({ event }) {
      assertActorDoneEvent(event);
      return event.output.type === 'workerInitializationFailed';
    },
  },
}).createMachine({
  id: 'buildManager',
  context: {
    worker: undefined,
    wrappedWorker: undefined,
    error: undefined,
  },
  initial: 'initializing',
  exit: ['destroyWorker'],
  states: {
    initializing: {
      entry() {
        console.debug('[BuildManager] state → initializing');
      },
      on: {
        initialize: {
          target: 'creatingWorker',
        },
      },
    },

    creatingWorker: {
      entry: [
        'clearError',
        () => {
          console.debug('[BuildManager] state → creatingWorker');
        },
      ],
      invoke: {
        id: 'initializeWorkerActor',
        src: 'initializeWorkerActor',
        input({ context }) {
          return { context };
        },
        onDone: [
          {
            target: 'error',
            guard: 'isWorkerInitializationFailed',
            actions: ['setError'],
          },
          {
            target: 'ready',
            actions: ['assignWorkerResources'],
          },
        ],
      },
    },

    ready: {
      entry() {
        console.debug('[BuildManager] state → ready');
      },
    },

    error: {
      entry({ context }) {
        console.error('[BuildManager] state → error', context.error);
      },
      on: {
        initialize: {
          target: 'creatingWorker',
        },
      },
    },
  },
});

export type BuildManagerMachine = typeof buildManagerMachine;
