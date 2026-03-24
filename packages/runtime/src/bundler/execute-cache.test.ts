import { describe, it, expect, beforeEach } from 'vitest';
import { executeCode, clearExecuteCache } from '#bundler/esbuild-core.js';

// =============================================================================
// Tests
// =============================================================================

let uniqueCounter = 0;
function uniqueCode(expression: string): string {
  return `export const val = ${expression}; /* ${uniqueCounter++} */`;
}

describe('executeCode cache', () => {
  beforeEach(() => {
    clearExecuteCache();
  });

  it('should return same module reference on cache hit', async () => {
    const code = uniqueCode('42');

    const first = await executeCode(code);
    const second = await executeCode(code);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success && second.success) {
      expect(first.value).toBe(second.value);
    }
  });

  it('should execute different code on cache miss', async () => {
    const codeA = uniqueCode('"a"');
    const codeB = uniqueCode('"b"');

    const resultA = await executeCode(codeA);
    const resultB = await executeCode(codeB);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    if (resultA.success && resultB.success) {
      expect(resultA.value).not.toBe(resultB.value);
    }
  });

  it('should re-execute after clearExecuteCache(code) for specific entry', async () => {
    const codeA = uniqueCode('1');
    const codeB = uniqueCode('2');

    await executeCode(codeA);
    await executeCode(codeB);

    clearExecuteCache(codeA);

    const reA = await executeCode(codeA);
    const cachedB = await executeCode(codeB);

    expect(reA.success).toBe(true);
    expect(cachedB.success).toBe(true);
  });

  it('should re-execute all after clearExecuteCache() with no args', async () => {
    const codeA = uniqueCode('10');
    const codeB = uniqueCode('20');

    await executeCode(codeA);
    await executeCode(codeB);

    clearExecuteCache();

    const reA = await executeCode(codeA);
    const reB = await executeCode(codeB);

    expect(reA.success).toBe(true);
    expect(reB.success).toBe(true);
  });

  it('should not cache failed executions', async () => {
    const badCode = 'syntax error !!!';

    const first = await executeCode(badCode);
    expect(first.success).toBe(false);

    const second = await executeCode(badCode);
    expect(second.success).toBe(false);
  });
});
