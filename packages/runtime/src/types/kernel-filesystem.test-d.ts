/**
 * Phase 4 / R14 — `RuntimeFileSystem` name disambiguation.
 *
 * Two distinct types historically shared the `RuntimeFileSystem` name:
 *
 *   1. The kernel-side, fully-typed FS interface used inside kernel
 *      methods, middleware, bundlers (`runtime-kernel.types.ts`).
 *   2. The consumer-facing opaque brand returned by `from*` factories
 *      (`filesystem/runtime-filesystem.ts`).
 *
 * The public `@taucad/runtime` barrel must expose ONLY the consumer
 * brand under the `RuntimeFileSystem` name. The kernel-side type is
 * renamed to `KernelFileSystem` and re-exported from the kernel-author
 * subpath `@taucad/runtime/kernel`.
 *
 * This test asserts the disambiguation by verifying:
 *   - `RuntimeFileSystem` is the opaque brand (no `readFile` etc.).
 *   - `KernelFileSystem` is the kernel-side type (has `readFile`, etc.).
 *   - Both names resolve to the expected modules.
 */

import { describe, it, expectTypeOf } from 'vitest';
import type { RuntimeFileSystem } from '#filesystem/runtime-filesystem.js';
import type { KernelFileSystem } from '#types/runtime-kernel.types.js';

describe('RuntimeFileSystem name disambiguation (R14)', () => {
  it('public RuntimeFileSystem is the opaque brand and exposes no FS primitives', () => {
    expectTypeOf<RuntimeFileSystem>().not.toHaveProperty('readFile');
    expectTypeOf<RuntimeFileSystem>().not.toHaveProperty('writeFile');
    expectTypeOf<RuntimeFileSystem>().not.toHaveProperty('readdir');
    expectTypeOf<RuntimeFileSystem>().not.toHaveProperty('watch');
  });

  it('kernel-side KernelFileSystem exposes the full FS surface', () => {
    expectTypeOf<KernelFileSystem>().toHaveProperty('readFile');
    expectTypeOf<KernelFileSystem>().toHaveProperty('writeFile');
    expectTypeOf<KernelFileSystem>().toHaveProperty('readdir');
    expectTypeOf<KernelFileSystem>().toHaveProperty('readFiles');
    expectTypeOf<KernelFileSystem>().toHaveProperty('readdirContents');
    expectTypeOf<KernelFileSystem>().toHaveProperty('readdirStat');
    expectTypeOf<KernelFileSystem>().toHaveProperty('ensureDir');
  });
});
