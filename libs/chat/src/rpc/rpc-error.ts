import type { RpcClientErrorCode } from '#schemas/rpc.schema.js';
import type { RpcHandlerError } from '#rpc/rpc-dependencies.js';

/**
 * Canonical mapping from POSIX errno codes to RPC client error codes.
 * Used as the primary classification signal — checked before message matching.
 *
 * ZenFS (kerium Exception), Node.js (ErrnoException), and the kernel filesystem
 * bridge all set `error.code` to these POSIX strings.
 */
const errnoToRpcCode: Record<string, RpcClientErrorCode> = {
  ENOENT: 'FILE_NOT_FOUND',
  EACCES: 'PERMISSION_DENIED',
  EPERM: 'PERMISSION_DENIED',
};

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}

export function getErrorCode(error: unknown): RpcClientErrorCode {
  if (error instanceof Error) {
    const errno = (error as { code?: string }).code;
    if (errno && errno in errnoToRpcCode) {
      return errnoToRpcCode[errno]!;
    }

    const message = error.message.toLowerCase();
    if (message.includes('not found') || message.includes('enoent') || message.includes('no such file')) {
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
