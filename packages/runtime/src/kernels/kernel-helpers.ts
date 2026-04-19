import type { KernelSuccessResult, KernelIssue, KernelErrorResult } from '#types/runtime.types.js';

/**
 * Create a successful kernel result wrapping the given data.
 *
 * @param data - The operation output to wrap
 * @param issues - Non-fatal issues (warnings/info) encountered during the operation
 * @returns A {@link KernelSuccessResult} with `success: true`
 * @public
 */
export const createKernelSuccess = <T>(data: T, issues: KernelIssue[] = []): KernelSuccessResult<T> => ({
  success: true,
  data,
  issues,
});

/**
 * Create a failed kernel result from one or more issues.
 *
 * @param issues - The errors/warnings that caused the operation to fail
 * @returns A {@link KernelErrorResult} with `success: false`
 * @public
 */
export const createKernelError = (issues: KernelIssue[]): KernelErrorResult => ({
  success: false,
  issues,
});
