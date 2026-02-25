import type { RpcClientErrorCode } from '#schemas/rpc.schema.js';
import type { RpcHandlerError } from '#rpc/rpc-dependencies.js';

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}

export function getErrorCode(error: unknown): RpcClientErrorCode {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('not found') || message.includes('enoent')) {
      return 'FILE_NOT_FOUND';
    }

    if (message.includes('permission') || message.includes('eacces')) {
      return 'PERMISSION_DENIED';
    }

    if (message.includes('parse') || message.includes('json')) {
      return 'PARSE_ERROR';
    }

    return 'IO_ERROR';
  }

  return 'UNKNOWN';
}

export function toRpcError(error: unknown): RpcHandlerError {
  return {
    success: false,
    errorCode: getErrorCode(error),
    message: getErrorMessage(error),
  };
}
