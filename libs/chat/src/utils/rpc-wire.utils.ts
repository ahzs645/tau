/**
 * Correlation helpers at the RPC WebSocket boundary.
 *
 * Preserves `rpcName` ↔ `args` / `result` pairing without widening when building `RpcCall` values
 * from discriminated `RpcRequest` payloads.
 */
import type { RpcCall } from '#schemas/rpc.schema.js';
import { rpcName } from '#constants/rpc.constants.js';
import type { RpcRequest } from '#types/websocket.types.js';

/** @public */
export type RpcCallWithToolCallId = RpcCall & { toolCallId: string };

/**
 * Re-hydrates a correlated RPC call + tool id from a discriminated request.
 *
 * TypeScript widens `{ rpcName, args }` if the fields are copied off a `RpcRequest` union; this
 * exhaustive switch restores the `RpcCall` discriminant.
 *
 * @public
 */
export function rpcRequestToCallInput(request: RpcRequest): RpcCallWithToolCallId {
  switch (request.rpcName) {
    case rpcName.readFile: {
      return {
        toolCallId: request.toolCallId,
        rpcName: request.rpcName,
        args: request.args,
      };
    }

    case rpcName.createFile: {
      return {
        toolCallId: request.toolCallId,
        rpcName: request.rpcName,
        args: request.args,
      };
    }

    case rpcName.deleteFile: {
      return {
        toolCallId: request.toolCallId,
        rpcName: request.rpcName,
        args: request.args,
      };
    }

    case rpcName.listDirectory: {
      return {
        toolCallId: request.toolCallId,
        rpcName: request.rpcName,
        args: request.args,
      };
    }

    case rpcName.grep: {
      return {
        toolCallId: request.toolCallId,
        rpcName: request.rpcName,
        args: request.args,
      };
    }

    case rpcName.globSearch: {
      return {
        toolCallId: request.toolCallId,
        rpcName: request.rpcName,
        args: request.args,
      };
    }

    case rpcName.getKernelResult: {
      return {
        toolCallId: request.toolCallId,
        rpcName: request.rpcName,
        args: request.args,
      };
    }

    case rpcName.captureObservations: {
      return {
        toolCallId: request.toolCallId,
        rpcName: request.rpcName,
        args: request.args,
      };
    }

    case rpcName.fetchGeometry: {
      return {
        toolCallId: request.toolCallId,
        rpcName: request.rpcName,
        args: request.args,
      };
    }

    case rpcName.exportGeometry: {
      return {
        toolCallId: request.toolCallId,
        rpcName: request.rpcName,
        args: request.args,
      };
    }

    case rpcName.captureScreenshot: {
      return {
        toolCallId: request.toolCallId,
        rpcName: request.rpcName,
        args: request.args,
      };
    }

    case rpcName.appendFile: {
      return {
        toolCallId: request.toolCallId,
        rpcName: request.rpcName,
        args: request.args,
      };
    }

    case rpcName.editFile: {
      return {
        toolCallId: request.toolCallId,
        rpcName: request.rpcName,
        args: request.args,
      };
    }

    default: {
      const exhaustive: never = request;
      throw new Error(`Unexpected RPC request: ${String((exhaustive as RpcRequest).rpcName)}`);
    }
  }
}
