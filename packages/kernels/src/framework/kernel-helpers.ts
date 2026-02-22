import type { KernelSuccessResult, KernelIssue, KernelErrorResult, KernelResult } from '#types/kernel.types.js';

/** Type guard: check if a KernelResult is a success. */
export const isKernelSuccess = <T>(result: KernelResult<T>): result is KernelSuccessResult<T> => {
  return result.success;
};

/** Type guard: check if a KernelResult is an error. */
export const isKernelError = <T>(result: KernelResult<T>): result is KernelErrorResult => {
  return !result.success;
};

export const createKernelSuccess = <T>(data: T, issues: KernelIssue[] = []): KernelSuccessResult<T> => ({
  success: true,
  data,
  issues,
});

// Create multiple kernel issues result
export const createKernelError = (issues: KernelIssue[]): KernelErrorResult => ({
  success: false,
  issues,
});
