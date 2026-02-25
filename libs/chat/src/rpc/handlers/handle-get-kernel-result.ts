import type { GetKernelResultRpcInput, GetKernelResultRpcResult } from '#schemas/rpc.schema.js';
import type { RpcKernelClient } from '#rpc/rpc-dependencies.js';

export async function handleGetKernelResult(
  input: GetKernelResultRpcInput,
  kernelClient: RpcKernelClient,
): Promise<GetKernelResultRpcResult> {
  return kernelClient.getKernelResult(input.targetFile);
}
