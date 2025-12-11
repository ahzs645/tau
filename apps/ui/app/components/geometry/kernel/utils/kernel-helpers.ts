import type { KernelSuccessResult, KernelError, KernelErrorResult } from '@taucad/types';

// Helper functions for creating results
export const createKernelSuccess = <T>(data: T): KernelSuccessResult<T> => ({
  success: true,
  data,
});

// Create a single kernel error result
export const createKernelError = (error: KernelError): KernelErrorResult => ({
  success: false,
  errors: [error],
});

// Create multiple kernel errors result
export const createKernelErrors = (errors: KernelError[]): KernelErrorResult => ({
  success: false,
  errors,
});
