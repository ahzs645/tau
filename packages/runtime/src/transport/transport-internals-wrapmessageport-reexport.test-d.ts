/**
 * `@taucad/runtime/transport-internals` re-exports `@taucad/rpc`
 * {@link wrapMessagePort} + {@link Port} for transport authors.
 */
import type { Port } from '@taucad/rpc';
import { wrapMessagePort } from '@taucad/rpc';
import { describe, expectTypeOf, it } from 'vitest';

import type { Port as PortFromInternals } from '#transport-internals.js';
import { wrapMessagePort as wrapFromInternals } from '#transport-internals.js';

describe('transport-internals rpc port exports', () => {
  it('wrapMessagePort matches @taucad/rpc', () => {
    expectTypeOf(wrapFromInternals).toEqualTypeOf(wrapMessagePort);
  });

  it('Port type matches @taucad/rpc', () => {
    expectTypeOf<PortFromInternals<boolean>>().toEqualTypeOf<Port<boolean>>();
  });
});
