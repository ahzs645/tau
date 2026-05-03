import type { ExportGeometryRpcInput, ExportGeometryRpcResult } from '#schemas/rpc.schema.js';
import { rpcClientErrorCode } from '#schemas/rpc.schema.js';
import type { RpcFileSystem, RpcGraphicsClient } from '#rpc/rpc-dependencies.js';
import { writeArtifact } from '#rpc/handlers/write-artifact.js';

export async function handleExportGeometry(
  input: ExportGeometryRpcInput,
  graphics: RpcGraphicsClient | undefined,
  fileSystem: RpcFileSystem,
): Promise<ExportGeometryRpcResult> {
  if (!graphics) {
    return {
      success: false,
      errorCode: rpcClientErrorCode.unknown,
      message: 'No graphics view is currently mounted',
    };
  }

  const result = await graphics.exportGeometry({ targetFile: input.targetFile, format: input.format });

  if (!result.success) {
    return result;
  }

  const artifactPath = await writeArtifact(
    {
      toolCallId: input.toolCallId,
      targetFile: input.targetFile,
      extension: input.format,
      bytes: result.bytes,
    },
    fileSystem,
  );

  if (!artifactPath) {
    return {
      success: false,
      errorCode: rpcClientErrorCode.ioError,
      message: 'Failed to persist export artifact to the project filesystem',
    };
  }

  return {
    success: true,
    artifactPath,
    format: input.format,
    mimeType: result.mimeType,
    byteLength: result.bytes.byteLength,
  };
}
