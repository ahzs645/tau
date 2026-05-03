import { describe, it, expectTypeOf } from 'vitest';
import type { RpcCall, RpcResult, RpcSchemasRegistry, ReadFileRpcInput } from '#schemas/rpc.schema.js';
import type { RpcDispatcher } from '#rpc/rpc-dispatcher.js';

describe('RpcDispatcher.dispatch generic narrowing (R2)', () => {
  it('should expose dispatch taking RpcCall<K> keyed by the registry', () => {
    expectTypeOf<RpcDispatcher>().toExtend<{
      dispatch<K extends keyof RpcSchemasRegistry>(call: RpcCall<K>): Promise<RpcResult<K>>;
    }>();
  });

  it('should correlate RpcCall<read_file> args with ReadFileRpcInput', () => {
    expectTypeOf<RpcCall<'read_file'>>().toEqualTypeOf<{
      rpcName: 'read_file';
      args: ReadFileRpcInput;
    }>();
  });
});
