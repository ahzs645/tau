import type { GetKernelResultRpcInput, GetKernelResultRpcResult } from '#schemas/rpc.schema.js';
import type { RpcRuntimeClient } from '#rpc/rpc-dependencies.js';

/** @public */
export async function handleGetKernelResult(
  input: GetKernelResultRpcInput,
  kernelClient: RpcRuntimeClient,
): Promise<GetKernelResultRpcResult> {
  return kernelClient.getKernelResult(input.targetFile);
}
