import type { FetchGeometryRpcInput, FetchGeometryRpcResult } from '#schemas/rpc.schema.js';
import type { RpcFileSystem, RpcGraphicsClient } from '#rpc/rpc-dependencies.js';

const artifactsDirectory = '.tau/artifacts';

/**
 * Slugify a source-file path so it can be embedded into an artifact filename
 * without colliding with directory separators or filesystem-reserved chars.
 * Path separators become `_`; any character outside `[a-zA-Z0-9._-]` becomes `_`.
 */
function slugifyTargetFile(targetFile: string): string {
  return targetFile.replaceAll(/[/\\]/g, '_').replaceAll(/[^\w.-]/g, '_');
}

export async function handleFetchGeometry(
  input: FetchGeometryRpcInput,
  graphics: RpcGraphicsClient | undefined,
  fileSystem: RpcFileSystem,
): Promise<FetchGeometryRpcResult> {
  if (!graphics) {
    return {
      success: false,
      errorCode: 'UNKNOWN',
      message: 'No graphics view is currently mounted',
    };
  }

  const result = await graphics.fetchGeometry({ targetFile: input.targetFile });

  if (!result.success || !input.artifactId) {
    return result;
  }

  const artifactPath = `${artifactsDirectory}/${input.artifactId}__${slugifyTargetFile(input.targetFile)}.glb`;

  try {
    await fileSystem.writeBinaryFile(artifactPath, result.glb);
    return { ...result, artifactPath };
  } catch {
    return { ...result, artifactPath: undefined };
  }
}
