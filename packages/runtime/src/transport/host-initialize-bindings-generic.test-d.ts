/**
 * Conformance test C13: `HostInitializeBindings<TExtra>` is generic
 * over a `TExtra` map of transport-specific extensions and structurally
 * equals `HostInitializeBindingsCore & TExtra`.
 */

import { describe, it, expectTypeOf } from 'vitest';
import type {
  HostInitializeBindings,
  HostInitializeBindingsCore,
  HostAbortBinding,
  HostGeometryDeliveryBinding,
  HostFileDeliveryBinding,
  EncodedGeometry,
  EncodedFileBytes,
} from '#transport/runtime-transport.types.js';

describe('HostInitializeBindings is generic (C13)', () => {
  it('exposes the core shape on every transport', () => {
    expectTypeOf<HostInitializeBindings>().toMatchTypeOf<HostInitializeBindingsCore>();
    expectTypeOf<HostInitializeBindingsCore>().not.toHaveProperty('fileSystem');
    expectTypeOf<HostInitializeBindingsCore>().toHaveProperty('abort');
    expectTypeOf<HostInitializeBindingsCore>().toHaveProperty('geometryDelivery');
    expectTypeOf<HostInitializeBindingsCore>().toHaveProperty('fileDelivery');
  });

  it('HostInitializeBindings<{}> is structurally HostInitializeBindingsCore', () => {
    type Empty = HostInitializeBindings<Record<string, never>>;
    expectTypeOf<Empty>().toMatchTypeOf<HostInitializeBindingsCore>();
  });

  it('extends with TExtra fields without losing the core shape', () => {
    type WebWorkerExtra = {
      readonly geometryPool: { readonly bytes: number };
      readonly signalSlot: { readonly buffer: SharedArrayBuffer };
    };
    type WebWorkerBindings = HostInitializeBindings<WebWorkerExtra>;

    expectTypeOf<WebWorkerBindings>().toMatchTypeOf<HostInitializeBindingsCore>();
    expectTypeOf<WebWorkerBindings>().toHaveProperty('geometryPool');
    expectTypeOf<WebWorkerBindings>().toHaveProperty('signalSlot');
    expectTypeOf<WebWorkerBindings>().toHaveProperty('abort');
  });

  it('HostAbortBinding exposes signal + strategy', () => {
    expectTypeOf<HostAbortBinding>().toHaveProperty('signal');
    expectTypeOf<HostAbortBinding>().toHaveProperty('strategy');
    expectTypeOf<HostAbortBinding['signal']>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<HostAbortBinding['strategy']>().toEqualTypeOf<'sab-atomics' | 'wire-notify'>();
  });

  it('HostGeometryDeliveryBinding.publish returns EncodedGeometry', () => {
    expectTypeOf<HostGeometryDeliveryBinding['publish']>().returns.toMatchTypeOf<EncodedGeometry>();
    expectTypeOf<HostGeometryDeliveryBinding['tier']>().toEqualTypeOf<'pool' | 'transfer' | 'copy'>();
  });

  it('HostFileDeliveryBinding.publish returns EncodedFileBytes', () => {
    expectTypeOf<HostFileDeliveryBinding['publish']>().returns.toMatchTypeOf<EncodedFileBytes>();
    expectTypeOf<HostFileDeliveryBinding['tier']>().toEqualTypeOf<'pool' | 'transfer' | 'copy'>();
  });
});
