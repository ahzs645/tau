/**
 * Finding 1 / R1: `HostInitializeBindingsCore` must not expose a dead
 * `fileSystem` field — dispatcher binds FS via `inlineFileSystem` /
 * `memoryHandle.fileSystemPort` only.
 */

import { describe, it, expectTypeOf } from 'vitest';
import type {
  HostAbortBinding,
  HostFileDeliveryBinding,
  HostGeometryDeliveryBinding,
  HostInitializeBindingsCore,
  HostInitializeBindings,
} from '#transport/runtime-transport.types.js';

describe('HostInitializeBindingsCore excludes fileSystem slot (Finding 1, R1)', () => {
  it('does not expose a fileSystem field on HostInitializeBindingsCore', () => {
    expectTypeOf<HostInitializeBindingsCore>().not.toHaveProperty('fileSystem');
  });

  it('retains abort, geometryDelivery, fileDelivery bindings', () => {
    expectTypeOf<HostInitializeBindingsCore>().toHaveProperty('abort');
    expectTypeOf<HostInitializeBindingsCore>().toHaveProperty('geometryDelivery');
    expectTypeOf<HostInitializeBindingsCore>().toHaveProperty('fileDelivery');
    expectTypeOf<HostInitializeBindingsCore['abort']>().toMatchTypeOf<HostAbortBinding>();
    expectTypeOf<HostInitializeBindingsCore['geometryDelivery']>().toMatchTypeOf<HostGeometryDeliveryBinding>();
    expectTypeOf<HostInitializeBindingsCore['fileDelivery']>().toMatchTypeOf<HostFileDeliveryBinding>();
  });

  it('HostInitializeBindings default still extends HostInitializeBindingsCore without fileSystem', () => {
    expectTypeOf<HostInitializeBindings>().toMatchTypeOf<HostInitializeBindingsCore>();
  });
});
