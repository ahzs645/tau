/**
 * URI/path helpers for KCL document and import resolution in the Monaco stack.
 */

/**
 * Convert URI to file path.
 * The file manager expects paths without leading slashes (e.g., "public/...")
 * but Monaco URIs use "file:///public/..." format.
 */
export function kclUriToWorkspacePath(uri: string): string {
  let path = uri;

  if (path.startsWith('file://')) {
    path = path.slice(7);
  }

  if (path.startsWith('/')) {
    path = path.slice(1);
  }

  return path;
}

/**
 * Resolve an import path relative to the current file's directory.
 *
 * @param currentFileUri URI of the current file (e.g., "file:///public/kcl-samples/bench/main.kcl")
 * @param importPath Relative import path (e.g., "bench-parts.kcl")
 * @returns Absolute file:// URI of the imported file
 */
export function resolveKclImportToUri(currentFileUri: string, importPath: string): string {
  const lastSlashIndex = currentFileUri.lastIndexOf('/');
  const directory = currentFileUri.slice(0, lastSlashIndex + 1);

  return `${directory}${importPath}`;
}

/**
 * Parent directory of a workspace-relative file path (no `file://` prefix).
 * Used so WASM bridge requests that omit directory context can be joined with the current document's folder.
 *
 * @example `public/kcl-samples/axial-fan/main.kcl` → `public/kcl-samples/axial-fan`
 * @example `main.kcl` → `''` (file at virtual workspace root)
 */
export function parentDirectoryOfWorkspacePath(workspacePath: string): string {
  const normalized = workspacePath.replace(/\/$/, '');
  const lastSlashIndex = normalized.lastIndexOf('/');
  if (lastSlashIndex <= 0) {
    return '';
  }
  return normalized.slice(0, lastSlashIndex);
}
