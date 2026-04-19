import { fromEventObservable } from 'xstate';
import type { EventObject, NonReducibleUnknown, Subscribable } from 'xstate';

// ---------------------------------------------------------------------------
// fromSafeAsync — React Strict Mode safe alternative to fromPromise
// ---------------------------------------------------------------------------

type SafeSubscriber<T> = {
  next: (value: T) => void;
  error: (error: unknown) => void;
  complete: () => void;
};

/**
 * Wraps an executor function in an Observable-compatible `Subscribable` with a
 * `closed` guard and `AbortController` teardown. On `unsubscribe()`, the guard
 * prevents any further emissions and the AbortController cancels in-flight work.
 *
 * Internal helper — not exported.
 */
function createSafeSubscribable<T>(
  executor: (subscriber: SafeSubscriber<T>, signal: AbortSignal) => void,
): Subscribable<T> {
  return {
    subscribe(observerOrFunction) {
      const observer = typeof observerOrFunction === 'function' ? { next: observerOrFunction } : observerOrFunction;
      let closed = false;
      const controller = new AbortController();

      const subscriber: SafeSubscriber<T> = {
        next: (value) => {
          if (!closed) {
            observer.next?.(value);
          }
        },
        error: (error) => {
          if (!closed) {
            closed = true;
            observer.error?.(error);
          }
        },
        complete: () => {
          if (!closed) {
            closed = true;
            observer.complete?.();
          }
        },
      };

      executor(subscriber, controller.signal);

      return {
        unsubscribe() {
          if (!closed) {
            closed = true;
            controller.abort();
          }
        },
      };
    },
  };
}

/**
 * Drop-in replacement for `fromPromise` that is safe under React Strict Mode's
 * `stopRootWithRehydration` cycle (mount → stop → rehydrate → restart).
 *
 * ## Generic parameters — `fromSafeAsync<TReturn, TInput>`
 *
 * Follows the same `<TOutput, TInput>` convention as `fromPromise`. Specify
 * both generic parameters explicitly to type `input` and the return value:
 *
 * ```typescript
 * type LoadedEvent = { type: 'loaded'; data: string };
 * type LoadInput = { url: string };
 *
 * const loadActor = fromSafeAsync<LoadedEvent, LoadInput>(async ({ input, signal }) => {
 *   const data = await fetchData(input.url, { signal }); // input: LoadInput
 *   return { type: 'loaded', data };                       // return: LoadedEvent
 * });
 * ```
 *
 * **Fire-and-forget** (void return, with input):
 * ```typescript
 * const writeActor = fromSafeAsync<void, { data: string }>(async ({ input }) => {
 *   await saveData(input.data);
 * });
 * ```
 *
 * **No input** (void return, no input):
 * ```typescript
 * const sideEffect = fromSafeAsync(async () => {
 *   await doWork();
 * });
 * ```
 *
 * ## How it works
 *
 * The returned event object is automatically emitted to the parent machine's
 * `on:` handlers. `onDone` fires as a pure lifecycle signal (no data).
 *
 * ## Why this exists
 *
 * `fromPromise` is fundamentally incompatible with `stopRootWithRehydration`
 * because Promise `.then()` handlers are **irrevocable**. When React Strict Mode
 * stops and rehydrates the root actor, the old Promise's `.then()` callback still
 * fires after the actor is restarted. Because rehydration restores the actor's
 * `_processingStatus` to `0` (active), the zombie `.then()` passes XState's
 * internal guard (`self.getSnapshot().status !== 'active'`), leaking stale
 * `xstate.done.invoke.*` or `xstate.error.invoke.*` events into the rehydrated
 * machine — corrupting state.
 *
 * Observable subscriptions can be severed via `unsubscribe()`, which this utility
 * leverages by wrapping `fromEventObservable`.
 *
 * ## Three safety layers
 *
 * 1. **`closed` guard** — silences post-unsubscribe emissions (`next`/`error`/`complete`)
 * 2. **`AbortController` teardown** — aborts the signal on unsubscribe, cancelling in-flight work
 * 3. **Observable unsubscribe contract** — XState calls `unsubscribe()` on the subscription
 *    when the invoking state is exited, preventing zombie event relay entirely
 *
 * ## TypeScript limitations
 *
 * TypeScript does not support partial type argument inference (as of TS 6.0).
 * You must specify both `TReturn` and `TInput` to type the input — same as
 * `fromPromise<TOutput, TInput>`. For actors that don't need input, omit both
 * generics entirely and let inference handle the return type.
 *
 * See `docs/policy/typescript-policy.md` for the full type safety policy.
 *
 * @see https://github.com/statelyai/xstate/issues/1237 — Duplicate machine execution with React.StrictMode
 * @see https://github.com/statelyai/xstate/pull/3278 — First workaround: prevent strict mode restart (closed)
 * @see https://github.com/statelyai/xstate/issues/3509 — Overeager entry/exit actions (103x under strict mode)
 * @see https://github.com/statelyai/xstate/pull/4555 — Fix actor restarting in strict mode (superseded by #4497)
 * @see https://github.com/statelyai/xstate/pull/4497 — Scheduler PR introducing `stopRootWithRehydration`
 * @see https://github.com/statelyai/xstate/issues/4459 — `fromPromise` stuck in state (reenter semantics)
 * @see https://github.com/statelyai/xstate/issues/4852 — Promise actor error handling issues
 * @see https://github.com/statelyai/xstate/pull/4832 — AbortSignal added to `fromPromise` (partial mitigation)
 * @see https://github.com/statelyai/xstate/pull/4191 — Initial AbortSignal POC for `fromPromise`
 * @see https://github.com/statelyai/xstate/issues/3452 — completeListener not triggered on stop
 * @see https://github.com/statelyai/xstate/pull/4609 — complete listeners only on done status
 * @see https://github.com/statelyai/xstate/issues/4019 — Input not passed to `fromEventObservable` (fixed)
 * @see https://github.com/statelyai/xstate/pull/4377 — Stop calling exit actions on stop
 * @see https://github.com/statelyai/xstate/pull/4491 — Actors deep in tree failing to rehydrate
 * @see https://github.com/statelyai/xstate/discussions/4968 — Emitting events from actor logic
 * @see https://github.com/statelyai/xstate/discussions/4684 — Sending events from Promise Actor to parent
 */
// oxlint-disable-next-line typescript/explicit-module-boundary-types -- allowing type inference for the function return type
export function fromSafeAsync<
  // eslint-disable-next-line @typescript-eslint/naming-convention -- following XState convention for generic type parameters
  TReturn extends EventObject | void = void,
  // eslint-disable-next-line @typescript-eslint/naming-convention -- following XState convention for generic type parameters
  TInput extends NonReducibleUnknown = NonReducibleUnknown,
>(work: (args: { input: TInput; signal: AbortSignal }) => Promise<TReturn>) {
  return fromEventObservable<TReturn & EventObject, TInput>(({ input }) =>
    createSafeSubscribable<TReturn & EventObject>((subscriber, signal) => {
      // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then) -- Observable executor cannot be async; .then() is intentional
      void work({ input, signal }).then(
        (result) => {
          if (result !== undefined) {
            // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- safe: void case excluded by undefined check above
            subscriber.next(result as TReturn & EventObject);
          }
          subscriber.complete();
        },
        (error: unknown) => {
          if (!signal.aborted) {
            subscriber.error(error);
          }
        },
      );
    }),
  );
}
