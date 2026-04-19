/**
 * Type-level tests for {@link fromSafeAsync}.
 *
 * Verifies that generic parameters `<TReturn, TInput>` match `fromPromise`
 * behavior: specify both generics explicitly, and `input` / return types
 * flow into the callback. Also verifies fire-and-forget (void return),
 * standalone actors, and `on:` handler event type inference.
 *
 * These tests are statically analysed by the TypeScript compiler via
 * vitest --typecheck and are never executed at runtime.
 */

import { describe, expectTypeOf, it } from 'vitest';
import { setup } from 'xstate';
import type { SnapshotFrom } from 'xstate';
import { fromSafeAsync } from '#lib/xstate.lib.js';

// =============================================================================
// Generic parameters — fromSafeAsync<TReturn, TInput>
// =============================================================================

describe('fromSafeAsync<TReturn, TInput> generic parameters', () => {
  it('should type input and return from explicit generics', () => {
    type LoadedEvent = { type: 'loaded'; data: string };
    type LoadInput = { url: string; timeout: number };

    const machine = setup({
      types: {
        // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
        context: {} as { result: string | undefined },
        // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
        events: {} as LoadedEvent,
      },
      actors: {
        loadActor: fromSafeAsync<LoadedEvent, LoadInput>(async ({ input, signal }) => {
          expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
          expectTypeOf(input).toEqualTypeOf<LoadInput>();
          return { type: 'loaded', data: input.url };
        }),
      },
    }).createMachine({
      context: { result: undefined },
      initial: 'loading',
      states: {
        loading: {
          invoke: {
            src: 'loadActor',
            input: () => ({ url: 'https://example.com', timeout: 5000 }),
            onDone: 'done',
          },
          on: {
            loaded: {
              actions: ({ event }) => {
                expectTypeOf(event).toEqualTypeOf<LoadedEvent>();
              },
            },
          },
        },
        done: { type: 'final' },
      },
    });

    expectTypeOf<SnapshotFrom<typeof machine>>().toBeObject();
  });

  it('should type complex input with multiple fields', () => {
    type ComputedEvent = { type: 'computed'; total: number };
    type ComputeInput = { a: number; b: number; label: string };

    const machine = setup({
      types: {
        // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
        context: {} as { count: number },
        // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
        events: {} as ComputedEvent,
      },
      actors: {
        computeActor: fromSafeAsync<ComputedEvent, ComputeInput>(async ({ input }) => {
          expectTypeOf(input).toEqualTypeOf<ComputeInput>();
          return { type: 'computed', total: input.a + input.b };
        }),
      },
    }).createMachine({
      context: { count: 0 },
      initial: 'computing',
      states: {
        computing: {
          invoke: {
            src: 'computeActor',
            input: () => ({ a: 1, b: 2, label: 'sum' }),
            onDone: 'done',
          },
        },
        done: { type: 'final' },
      },
    });

    expectTypeOf<SnapshotFrom<typeof machine>>().toBeObject();
  });
});

// =============================================================================
// Fire-and-forget — fromSafeAsync<void, TInput>
// =============================================================================

describe('fire-and-forget with input', () => {
  it('should accept void return with explicit TInput', () => {
    const machine = setup({
      actors: {
        writeActor: fromSafeAsync<void, { data: string }>(async ({ input }) => {
          expectTypeOf(input.data).toBeString();
        }),
      },
    }).createMachine({
      initial: 'writing',
      states: {
        writing: {
          invoke: {
            src: 'writeActor',
            input: () => ({ data: 'payload' }),
            onDone: 'done',
          },
        },
        done: { type: 'final' },
      },
    });

    expectTypeOf<SnapshotFrom<typeof machine>>().toBeObject();
  });

  it('should compile without generics for void-returning actors', () => {
    const machine = setup({
      actors: {
        sideEffect: fromSafeAsync(async () => {
          // Fire-and-forget, no input, no return
        }),
      },
    }).createMachine({
      initial: 'working',
      states: {
        working: {
          invoke: { src: 'sideEffect', onDone: 'done' },
        },
        done: { type: 'final' },
      },
    });

    expectTypeOf<SnapshotFrom<typeof machine>>().toBeObject();
  });
});

// =============================================================================
// provide() contextual typing — no inline types needed
// =============================================================================

describe('provide() contextual typing', () => {
  it('should infer input and return types from the placeholder actor slot', () => {
    type LoadedEvent = { type: 'loaded'; data: string };
    type LoadInput = { url: string };

    const machine = setup({
      types: {
        // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
        events: {} as LoadedEvent,
      },
      actors: {
        loadActor: fromSafeAsync<LoadedEvent, LoadInput>(async (): Promise<LoadedEvent> => {
          throw new Error('loadActor not provided');
        }),
      },
    }).createMachine({
      initial: 'loading',
      states: {
        loading: {
          invoke: {
            src: 'loadActor',
            input: () => ({ url: '/api/data' }),
            onDone: 'done',
          },
          on: {
            loaded: {
              actions: ({ event }) => {
                expectTypeOf(event).toEqualTypeOf<LoadedEvent>();
              },
            },
          },
        },
        done: { type: 'final' },
      },
    });

    machine.provide({
      actors: {
        loadActor: fromSafeAsync(async ({ input }) => {
          expectTypeOf(input).toEqualTypeOf<LoadInput>();
          return { type: 'loaded', data: input.url };
        }),
      },
    });
  });
});

// =============================================================================
// Standalone actors with explicit input annotation
// =============================================================================

describe('standalone actors with inline annotation', () => {
  it('should infer input type from inline parameter annotation', () => {
    fromSafeAsync(async ({ input }: { input: { id: string }; signal: AbortSignal }) => {
      expectTypeOf(input).toEqualTypeOf<{ id: string }>();
      return { type: 'fetched', id: input.id };
    });
  });
});

// =============================================================================
// on: handler event type inference
// =============================================================================

describe('on: handler event type inference', () => {
  it('should infer event type in on: handlers from TReturn', () => {
    type ResultEvent = { type: 'result'; value: number };

    setup({
      types: {
        // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
        events: {} as ResultEvent,
      },
      actors: {
        computeActor: fromSafeAsync<ResultEvent>(async () => {
          return { type: 'result', value: 42 };
        }),
      },
    }).createMachine({
      initial: 'running',
      states: {
        running: {
          invoke: { src: 'computeActor', onDone: 'done' },
          on: {
            result: {
              actions: ({ event }) => {
                expectTypeOf(event).toEqualTypeOf<ResultEvent>();
              },
            },
          },
        },
        done: { type: 'final' },
      },
    });
  });
});
