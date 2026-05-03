import { describe, it, expectTypeOf } from 'vitest';
import type { RpcCall, RpcResult } from '#schemas/rpc.schema.js';
import type { RpcDispatcher } from '#rpc/rpc-dispatcher.js';

describe('RpcDispatcher.dispatch generic narrowing (R2)', () => {
  it('should expose dispatch as a generic method bounded by RpcCall', () => {
    expectTypeOf<RpcDispatcher>().toExtend<{
      dispatch<C extends RpcCall>(call: C): Promise<RpcResult<C['rpcName']>>;
    }>();
  });
});
