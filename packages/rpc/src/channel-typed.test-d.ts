// eslint-disable-next-line import-x/no-extraneous-dependencies -- this is a test file.
import { describe, it, assertType } from 'vitest';
import type { Channel, ChannelServer, EmptyRpcProtocol, RpcProtocol } from '#index.js';

/**
 * Type-level conformance tests for {@link Channel} / {@link ChannelServer} generics (R2).
 *
 * Validates that a typed protocol declared via {@link RpcProtocol} flows through `Channel<P>`
 * and `ChannelServer<P>` so consumers see typed args/result/notify/listen signatures, and that
 * {@link EmptyRpcProtocol} keeps unparameterised (legacy) callers ergonomic.
 */

type SampleProtocol = {
  readonly calls: {
    readonly add: { args: { a: number; b: number }; result: number };
    readonly render: { args: { source: string }; result: Uint8Array<ArrayBuffer> };
  };
  readonly notifies: {
    readonly openFile: { args: { path: string } };
  };
  readonly listens: {
    readonly progress: { args: void; event: number };
  };
};

describe('Channel<P> typed surface (R2)', () => {
  it('infers ready and closed promises', () => {
    /* These are pure type-level assignability checks, not actual promise chains. */
    // oxlint-disable promise/prefer-await-to-then -- type-level Promise.resolve() seeds, no .then() chain
    const ready: Channel<SampleProtocol>['ready'] = Promise.resolve();
    assertType<Promise<void>>(ready);
    const closed: Channel<SampleProtocol>['closed'] = Promise.resolve();
    assertType<Promise<void>>(closed);
    // oxlint-enable promise/prefer-await-to-then
  });

  it('admits the empty protocol so legacy untyped consumers keep compiling', () => {
    type EmptyAssignableToBase = EmptyRpcProtocol extends RpcProtocol ? true : false;
    const value: EmptyAssignableToBase = true;
    assertType<true>(value);
  });
});

describe('ChannelServer<P> typed surface (R2)', () => {
  it('exposes a typed call/listen impl that consumers must implement', () => {
    type Keys = keyof ChannelServer<SampleProtocol>;
    const callKey: Extract<Keys, 'call'> = 'call';
    const listenKey: Extract<Keys, 'listen'> = 'listen';
    assertType<'call'>(callKey);
    assertType<'listen'>(listenKey);
  });
});
