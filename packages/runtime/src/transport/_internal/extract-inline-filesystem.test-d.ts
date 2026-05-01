/**
 * R2 — public surface: `extractInlineFileSystem` re-export from transport-internals.
 */

import { extractInlineFileSystem as FromInternals } from '@taucad/runtime/transport-internals';
import { describe, expectTypeOf, it } from 'vitest';

import { extractInlineFileSystem as FromHandle } from '#transport/_internal/runtime-filesystem-handle.js';

describe('extractInlineFileSystem export (R2)', () => {
  it('should match runtime-filesystem-handle via transport-internals re-export', () => {
    expectTypeOf(FromInternals).toEqualTypeOf(FromHandle);
  });
});
