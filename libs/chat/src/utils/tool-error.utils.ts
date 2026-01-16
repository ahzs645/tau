import type { ToolExecutionError } from '#types/websocket.types.js';

/**
 * All possible tool execution error codes.
 */
export const toolErrorCodes = [
  'TOOL_EXECUTION_TIMEOUT',
  'CLIENT_DISCONNECTED',
  'NO_CLIENT_CONNECTION',
  'TOOL_INPUT_VALIDATION_FAILED',
  'TOOL_OUTPUT_VALIDATION_FAILED',
] as const;

export type ToolErrorCode = (typeof toolErrorCodes)[number];

/**
 * Type guard to check if a value is a ToolExecutionError.
 * Use in tool component output-available case before accessing typed properties.
 */
export function isToolExecutionError(value: unknown): value is ToolExecutionError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'errorCode' in value &&
    typeof (value as { errorCode: unknown }).errorCode === 'string' &&
    toolErrorCodes.includes((value as { errorCode: string }).errorCode as ToolErrorCode)
  );
}

/**
 * Get a user-friendly error title for each error code.
 */
export function getToolErrorTitle(errorCode: ToolErrorCode): string {
  switch (errorCode) {
    case 'TOOL_EXECUTION_TIMEOUT': {
      return 'Tool Timed Out';
    }

    case 'CLIENT_DISCONNECTED': {
      return 'Connection Lost';
    }

    case 'NO_CLIENT_CONNECTION': {
      return 'No Connection';
    }

    case 'TOOL_INPUT_VALIDATION_FAILED': {
      return 'Invalid Input';
    }

    case 'TOOL_OUTPUT_VALIDATION_FAILED': {
      return 'Validation Failed';
    }
  }
}

/**
 * Get a user-friendly description for each error code.
 */
export function getToolErrorDescription(errorCode: ToolErrorCode): string {
  switch (errorCode) {
    case 'TOOL_EXECUTION_TIMEOUT': {
      return 'The tool took too long to execute and was terminated.';
    }

    case 'CLIENT_DISCONNECTED': {
      return 'The connection was lost while the tool was running.';
    }

    case 'NO_CLIENT_CONNECTION': {
      return 'No browser tab is connected. Please refresh the page.';
    }

    case 'TOOL_INPUT_VALIDATION_FAILED': {
      return 'The tool received invalid input arguments.';
    }

    case 'TOOL_OUTPUT_VALIDATION_FAILED': {
      return 'The tool returned data in an unexpected format.';
    }
  }
}
