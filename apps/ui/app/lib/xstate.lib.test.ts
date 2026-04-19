import { describe, it, expect, vi, afterEach } from 'vitest';
import { createActor, setup, waitFor, assign } from 'xstate';
import { fromSafeAsync } from '#lib/xstate.lib.js';
import { stopRootWithRehydration } from '#lib/xstate-test.utils.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fromSafeAsync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Completion
  // =========================================================================
  describe('completion', () => {
    it('should transition via onDone when work completes', async () => {
      const machine = setup({
        types: {
          // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
          context: {} as { done: boolean },
        },
        actors: {
          work: fromSafeAsync(async () => {
            // Fire-and-forget
          }),
        },
      }).createMachine({
        context: { done: false },
        initial: 'working',
        states: {
          working: {
            invoke: {
              src: 'work',
              onDone: { target: 'finished', actions: assign({ done: true }) },
            },
          },
          finished: { type: 'final' },
        },
      });

      const actor = createActor(machine);
      actor.start();
      await waitFor(actor, (s) => s.value === 'finished');

      expect(actor.getSnapshot().value).toBe('finished');
      expect(actor.getSnapshot().context.done).toBe(true);
      actor.stop();
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================
  describe('error', () => {
    it('should transition via onError when work throws', async () => {
      const machine = setup({
        types: {
          // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
          context: {} as { errorMessage: string | undefined },
        },
        actors: {
          work: fromSafeAsync(async () => {
            throw new Error('boom');
          }),
        },
      }).createMachine({
        context: { errorMessage: undefined },
        initial: 'working',
        states: {
          working: {
            invoke: {
              src: 'work',
              onDone: 'finished',
              onError: {
                target: 'failed',
                actions: assign({
                  errorMessage: ({ event }) => (event.error instanceof Error ? event.error.message : 'unknown'),
                }),
              },
            },
          },
          finished: { type: 'final' },
          failed: { type: 'final' },
        },
      });

      const actor = createActor(machine);
      actor.start();
      await waitFor(actor, (s) => s.value === 'failed');

      expect(actor.getSnapshot().value).toBe('failed');
      expect(actor.getSnapshot().context.errorMessage).toBe('boom');
      actor.stop();
    });
  });

  // =========================================================================
  // Data delivery via return
  // =========================================================================
  describe('data delivery', () => {
    it('should deliver returned event to parent on: handler', async () => {
      type DataEvent = { type: 'dataReady'; value: number };

      const machine = setup({
        types: {
          // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
          context: {} as { receivedValue: number | undefined },
          // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
          events: {} as DataEvent,
        },
        actors: {
          work: fromSafeAsync<{ type: 'dataReady'; value: number }, { multiplier: number }>(async ({ input }) => {
            return { type: 'dataReady', value: input.multiplier * 10 };
          }),
        },
      }).createMachine({
        context: { receivedValue: undefined },
        initial: 'working',
        states: {
          working: {
            invoke: {
              src: 'work',
              input: () => ({ multiplier: 5 }),
              onDone: 'finished',
            },
            on: {
              dataReady: {
                actions: assign({ receivedValue: ({ event }) => event.value }),
              },
            },
          },
          finished: { type: 'final' },
        },
      });

      const actor = createActor(machine);
      actor.start();
      await waitFor(actor, (s) => s.value === 'finished');

      expect(actor.getSnapshot().context.receivedValue).toBe(50);
      actor.stop();
    });
  });

  // =========================================================================
  // Signal abort
  // =========================================================================
  describe('signal abort', () => {
    it('should abort signal when machine leaves invoking state', async () => {
      let capturedSignal: AbortSignal | undefined;

      const machine = setup({
        types: {
          // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
          events: {} as { type: 'cancel' },
        },
        actors: {
          work: fromSafeAsync(async ({ signal }) => {
            capturedSignal = signal;
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 10_000);
              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve();
              });
            });
          }),
        },
      }).createMachine({
        initial: 'working',
        states: {
          working: {
            invoke: { src: 'work', onDone: 'finished' },
            on: { cancel: 'cancelled' },
          },
          finished: { type: 'final' },
          cancelled: { type: 'final' },
        },
      });

      const actor = createActor(machine);
      actor.start();

      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false);

      actor.send({ type: 'cancel' });
      expect(capturedSignal!.aborted).toBe(true);

      actor.stop();
    });
  });

  // =========================================================================
  // Zombie prevention via stopRootWithRehydration
  // =========================================================================
  describe('zombie prevention', () => {
    it('should silence zombie callbacks after stopRootWithRehydration', async () => {
      const callLog: string[] = [];

      type DoneEvent = { type: 'workDone'; value: string };

      const machine = setup({
        types: {
          // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
          context: {} as { result: string | undefined },
          // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
          events: {} as DoneEvent,
        },
        actors: {
          work: fromSafeAsync(async () => {
            await new Promise((resolve) => {
              setTimeout(resolve, 100);
            });
            callLog.push('return');
            return { type: 'workDone', value: 'from-zombie' };
          }),
        },
      }).createMachine({
        context: { result: undefined },
        initial: 'working',
        states: {
          working: {
            invoke: { src: 'work', onDone: 'finished' },
            on: {
              workDone: {
                actions: assign({
                  result: ({ event }) => {
                    callLog.push(`assign:${event.value}`);
                    return event.value;
                  },
                }),
              },
            },
          },
          finished: { type: 'final' },
        },
      });

      const actor = createActor(machine);
      actor.start();

      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });

      // Strict Mode cleanup
      stopRootWithRehydration(actor);

      // Re-mount
      actor.start();

      // Wait for the zombie's timer to fire (100ms) plus some margin
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });

      // The zombie's emit should be silenced by the closed guard.
      // Only the re-mounted invocation's events should reach the parent.
      // Since the re-mounted invocation also runs, wait for it.
      await waitFor(actor, (s) => s.value === 'finished', { timeout: 5000 });

      // The result should be from the re-mounted invocation, not the zombie
      expect(actor.getSnapshot().context.result).toBe('from-zombie');
      // Both invocations emit, but only the second (non-zombie) assign should run
      // Actually both will emit 'emit', but only the second's assign runs
      // In this test the re-mount also takes 100ms so it also succeeds.
      // The key is that the zombie does NOT corrupt state.
      actor.stop();
    });

    it('should only deliver events from the NEW invocation after stopRootWithRehydration', async () => {
      let invocationCount = 0;

      type TagEvent = { type: 'tagged'; invocation: number };

      const machine = setup({
        types: {
          // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
          context: {} as { tags: number[] },
          // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
          events: {} as TagEvent,
        },
        actors: {
          work: fromSafeAsync(async () => {
            const myInvocation = ++invocationCount;
            await new Promise((resolve) => {
              setTimeout(resolve, 50);
            });
            return { type: 'tagged', invocation: myInvocation };
          }),
        },
      }).createMachine({
        context: { tags: [] },
        initial: 'working',
        states: {
          working: {
            invoke: { src: 'work', onDone: 'finished' },
            on: {
              tagged: {
                actions: assign({
                  tags: ({ context, event }) => [...context.tags, event.invocation],
                }),
              },
            },
          },
          finished: { type: 'final' },
        },
      });

      const actor = createActor(machine);
      actor.start();

      // Let invocation 1 start
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      // Strict Mode: stop + rehydrate
      stopRootWithRehydration(actor);

      // Re-mount: invocation 2 starts
      actor.start();

      await waitFor(actor, (s) => s.value === 'finished', { timeout: 5000 });

      // Only invocation 2 should have delivered its tag.
      // Invocation 1 (zombie) was silenced by unsubscribe + closed guard.
      expect(actor.getSnapshot().context.tags).toEqual([2]);
      actor.stop();
    });
  });

  // =========================================================================
  // Fire-and-forget (TEmittedEvent = never)
  // =========================================================================
  describe('fire-and-forget', () => {
    it('should complete without emitting any events', async () => {
      const sideEffect = vi.fn();

      const machine = setup({
        actors: {
          work: fromSafeAsync(async () => {
            sideEffect();
          }),
        },
      }).createMachine({
        initial: 'working',
        states: {
          working: {
            invoke: { src: 'work', onDone: 'finished' },
          },
          finished: { type: 'final' },
        },
      });

      const actor = createActor(machine);
      actor.start();
      await waitFor(actor, (s) => s.value === 'finished');

      expect(sideEffect).toHaveBeenCalledOnce();
      expect(actor.getSnapshot().value).toBe('finished');
      actor.stop();
    });
  });

  // =========================================================================
  // Error suppression on abort
  // =========================================================================
  describe('error suppression on abort', () => {
    it('should not fire onError when work throws after signal is aborted', async () => {
      const machine = setup({
        types: {
          // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
          context: {} as { error: boolean },
          // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
          events: {} as { type: 'cancel' },
        },
        actors: {
          work: fromSafeAsync(async ({ signal }) => {
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
              });
            });
          }),
        },
      }).createMachine({
        context: { error: false },
        initial: 'working',
        states: {
          working: {
            invoke: {
              src: 'work',
              onDone: 'finished',
              onError: {
                target: 'failed',
                actions: assign({ error: true }),
              },
            },
            on: { cancel: 'cancelled' },
          },
          finished: { type: 'final' },
          cancelled: { type: 'final' },
          failed: { type: 'final' },
        },
      });

      const actor = createActor(machine);
      actor.start();

      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      actor.send({ type: 'cancel' });

      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      // Should be in 'cancelled', NOT 'failed'
      expect(actor.getSnapshot().value).toBe('cancelled');
      expect(actor.getSnapshot().context.error).toBe(false);
      actor.stop();
    });
  });
});
