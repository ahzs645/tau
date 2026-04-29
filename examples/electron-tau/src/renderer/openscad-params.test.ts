// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { extractParams } from './openscad-params.js';

describe('extractParams', () => {
  it('reads number params from a top-level declaration', () => {
    expect(extractParams('len=200;\ncube(len);')).toEqual([{ name: 'len', defaultValue: 200 }]);
  });

  it('renames are observed as the new identifier name', () => {
    /* The rename validation (p1-electron-validate-rename) hinges on this:
     * the params form gets `length` instead of `len` purely from the
     * source change. */
    expect(extractParams('length=200;\ncube(length);')).toEqual([{ name: 'length', defaultValue: 200 }]);
  });

  it('skips non-top-level / function-call lines', () => {
    expect(extractParams('cube(100);')).toEqual([]);
  });

  it('handles multiple params in declaration order, dedupes repeats', () => {
    const src = 'a=1;\nb=2;\nb=3;\nc=4.5;';
    expect(extractParams(src)).toEqual([
      { name: 'a', defaultValue: 1 },
      { name: 'b', defaultValue: 2 },
      { name: 'c', defaultValue: 4.5 },
    ]);
  });

  it('parses string literal defaults', () => {
    expect(extractParams('label="hello";')).toEqual([{ name: 'label', defaultValue: 'hello' }]);
  });
});
