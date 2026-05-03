import { describe, expect, it } from 'vitest';
import { slugifyTargetFile } from '#rpc/handlers/write-artifact.js';

describe('writeArtifact helpers', () => {
  it('should slugify path separators and disallowed chars', () => {
    expect(slugifyTargetFile('lib/sub/PEN.ts')).toBe('lib_sub_PEN.ts');
    expect(slugifyTargetFile('unicode-名前.ts')).toBe('unicode-__.ts');
    expect(slugifyTargetFile('a/../b.ts')).toBe('a_.._b.ts');
  });
});
