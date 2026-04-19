import type { CaptureObservationsRpcInput, CaptureObservationsRpcResult } from '#schemas/rpc.schema.js';
import type { RpcGraphicsClient } from '#rpc/rpc-dependencies.js';

/** @public */
export async function handleCaptureObservations(
  _input: CaptureObservationsRpcInput,
  graphics: RpcGraphicsClient | undefined,
): Promise<CaptureObservationsRpcResult> {
  if (!graphics) {
    return {
      success: false,
      errorCode: 'UNKNOWN',
      message: 'No graphics view is currently mounted for screenshots',
    };
  }

  return graphics.captureObservations();
}
