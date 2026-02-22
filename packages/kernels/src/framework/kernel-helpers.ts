import type { KernelSuccessResult, KernelIssue, KernelErrorResult } from '@taucad/types';

// Helper functions for creating results
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
