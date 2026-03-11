import { assign, assertEvent, setup } from 'xstate';
import { wrap } from 'comlink';
import type { Remote } from 'comlink';
import { safeDispose } from '@taucad/utils/dispose';
// oxlint-disable-next-line eslint-plugin-import/no-named-as-default -- web worker default import
import ObjectStoreWorker from '#hooks/object-store.worker.js?worker';
import type { ObjectStoreWorker as ObjectStoreWorkerType } from '#hooks/object-store.worker.js';
import { fromSafeAsync } from '#lib/xstate.lib.js';

type BuildManagerContext = {
  worker: Worker | undefined;
  wrappedWorker: Remote<ObjectStoreWorkerType> | undefined;
  error: Error | undefined;
};

type WorkerInitializedEvent = {
  type: 'workerInitialized';
  worker: Worker;
  wrappedWorker: Remote<ObjectStoreWorkerType>;
};

const initializeWorkerActor = fromSafeAsync<WorkerInitializedEvent, { context: BuildManagerContext }>(
  async ({ input, signal }) => {
    const { context } = input;
    console.debug('[BuildManager] initializeWorkerActor: start');

    if (context.worker) {
      safeDispose(() => context.worker?.terminate());
    }

    signal.throwIfAborted();

    const worker = new ObjectStoreWorker();
    const wrappedWorker = wrap<ObjectStoreWorkerType>(worker);

    console.debug('[BuildManager] initializeWorkerActor: success');
    return { type: 'workerInitialized', worker, wrappedWorker };
  },
);

const buildManagerActors = {
  initializeWorkerActor,
} as const;

type BuildManagerEvent = { type: 'initialize' } | WorkerInitializedEvent;

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
        if ('error' in event && event.error instanceof Error) {
          return event.error;
        }
        return undefined;
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
        assertEvent(event, 'workerInitialized');
        return event.worker;
      },
      wrappedWorker({ event }) {
        assertEvent(event, 'workerInitialized');
        return event.wrappedWorker;
      },
    }),
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
      on: {
        workerInitialized: {
          actions: ['assignWorkerResources'],
        },
      },
      invoke: {
        id: 'initializeWorkerActor',
        src: 'initializeWorkerActor',
        input({ context }) {
          return { context };
        },
        onDone: 'ready',
        onError: {
          target: 'error',
          actions: ['setError'],
        },
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
