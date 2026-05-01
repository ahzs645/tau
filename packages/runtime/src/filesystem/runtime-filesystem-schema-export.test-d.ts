/**
 * `runtimeFileSystemSchema` is part of the public filesystem barrel for
 * transport option validation (e.g. electron utility host).
 */

import { runtimeFileSystemSchema as FromSchemasModule } from '#filesystem/runtime-filesystem.schemas.js';
import { describe, expectTypeOf, it } from 'vitest';

import { runtimeFileSystemSchema as FromBarrel } from '@taucad/runtime/filesystem';

describe('filesystem barrel exports runtimeFileSystemSchema', () => {
  it('should match the schema module export', () => {
    expectTypeOf(FromBarrel).toEqualTypeOf(FromSchemasModule);
  });
});
