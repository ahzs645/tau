import type { RpcFileSystem } from '#rpc/rpc-dependencies.js';

const artifactsDirectory = '.tau/artifacts';

/**
 * Slugify a source-file path so it can be embedded into an artifact filename
 * without colliding with directory separators or filesystem-reserved chars.
 * Path separators become `_`; any character outside `[a-zA-Z0-9._-]` becomes `_`.
 */
export function slugifyTargetFile(targetFile: string): string {
  return targetFile.replaceAll(/[/\\]/g, '_').replaceAll(/[^\w.-]/g, '_');
}

export async function writeArtifact(
  options: {
    readonly toolCallId: string;
    readonly targetFile: string;
    /** Extension without leading dot (e.g. glb, step). */
    readonly extension: string;
    readonly bytes: Uint8Array<ArrayBuffer>;
  },
  fileSystem: RpcFileSystem,
): Promise<string | undefined> {
  const artifactExtension = options.extension.startsWith('.') ? options.extension.slice(1) : options.extension;
  const artifactPath = `${artifactsDirectory}/${options.toolCallId}__${slugifyTargetFile(options.targetFile)}.${artifactExtension}`;

  try {
    await fileSystem.writeBinaryFile(artifactPath, options.bytes);
    return artifactPath;
  } catch {
    return undefined;
  }
}
