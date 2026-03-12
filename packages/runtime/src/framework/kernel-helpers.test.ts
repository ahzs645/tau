import { describe, it, expect } from 'vitest';
import { createKernelSuccess, createKernelError } from '#framework/kernel-helpers.js';
import type { KernelIssue } from '#types/kernel.types.js';

describe('createKernelSuccess', () => {
  it('should return success with data and empty issues by default', () => {
    const result = createKernelSuccess({ vertices: [1, 2, 3] });

    expect(result).toEqual({
      success: true,
      data: { vertices: [1, 2, 3] },
      issues: [],
    });
  });

  it('should preserve provided issues', () => {
    const issues: KernelIssue[] = [{ message: 'Degenerate face skipped', type: 'kernel', severity: 'warning' }];
    const result = createKernelSuccess('geometry-data', issues);

    expect(result.success).toBe(true);
    expect(result.issues).toBe(issues);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toBe('Degenerate face skipped');
  });

  it('should preserve generic data types', () => {
    const numberResult = createKernelSuccess(42);
    expect(numberResult.data).toBe(42);

    const arrayResult = createKernelSuccess([1, 2, 3]);
    expect(arrayResult.data).toEqual([1, 2, 3]);

    const objectResult = createKernelSuccess({ nested: { value: true } });
    expect(objectResult.data).toEqual({ nested: { value: true } });
  });
});

describe('createKernelError', () => {
  it('should return failure with provided issues', () => {
    const issues: KernelIssue[] = [{ message: 'Compilation failed', type: 'compilation', severity: 'error' }];
    const result = createKernelError(issues);

    expect(result).toEqual({
      success: false,
      issues,
    });
  });

  it('should handle multiple issues', () => {
    const issues: KernelIssue[] = [
      { message: 'Syntax error on line 5', type: 'compilation', severity: 'error' },
      { message: 'Unused variable', type: 'compilation', severity: 'warning' },
    ];
    const result = createKernelError(issues);

    expect(result.success).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues).toBe(issues);
  });

  it('should handle empty issues array', () => {
    const result = createKernelError([]);

    expect(result.success).toBe(false);
    expect(result.issues).toEqual([]);
  });
});
