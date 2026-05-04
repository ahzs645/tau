import { describe, expect, it } from 'vitest';

import { RefreshGenerationGuard } from '@taucad/fs-client/refresh-generation-guard';

/**
 * Ensures `@taucad/fs-client` resolves in this workspace member (parity with web FM).
 */
describe('@taucad/fs-client workspace link', () => {
  it('should construct RefreshGenerationGuard', () => {
    expect(new RefreshGenerationGuard()).toBeInstanceOf(RefreshGenerationGuard);
  });
});
