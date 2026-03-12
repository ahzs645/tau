/**
 * Normalizes a path by removing redundant slashes and ensuring a single leading slash.
 *
 * @param path - The path to normalize.
 * @returns A normalized path with single leading slash and no redundant slashes.
 * @public
 */
export function normalizePath(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return '/' + segments.join('/');
}

/**
 * Joins multiple path segments into a single normalized absolute path.
 *
 * Behavior:
 * - If any segment is absolute (starts with '/'), it resets the path from that point
 * - Empty segments are ignored
 * - The result is always normalized (no redundant slashes, single leading slash)
 *
 * @param paths - Path segments to join.
 * @returns A normalized absolute path.
 *
 * @public
 *
 * @example <caption>Joining path segments</caption>
 * ```typescript
 * joinPath('/root', 'dir', 'file.txt') // '/root/dir/file.txt'
 * joinPath('/root', '/absolute', 'file.txt') // '/absolute/file.txt'
 * joinPath('/', '/builds/id/main.scad') // '/builds/id/main.scad'
 * joinPath('/root', '', 'file.txt') // '/root/file.txt'
 * ```
 */
export function joinPath(...paths: string[]): string {
  let result = '';

  for (const path of paths) {
    if (path === '') {
      continue;
    }

    // If path is absolute, reset result to this path
    if (path.startsWith('/')) {
      result = path;
    } else if (result === '' || result === '/') {
      // If result is empty or just root, set to path with leading slash
      result = '/' + path;
    } else {
      // Append path to result
      result = result + '/' + path;
    }
  }

  // Handle empty result
  if (result === '') {
    return '/';
  }

  return normalizePath(result);
}

/**
 * Get the parent directory of a path.
 *
 * @param path - absolute path
 * @returns parent directory path, or '/' for root-level paths
 * @public
 */
export function parentDirectory(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash <= 0) {
    return '/';
  }
  return path.slice(0, lastSlash);
}

/**
 * Canonical path normalization for watch matching.
 * Normalizes separators, removes duplicate slashes, ensures leading slash,
 * and strips trailing slash (except for root '/').
 *
 * @param path - path to canonicalize
 * @returns canonical absolute path
 * @public
 */
export function canonicalizePath(path: string): string {
  let normalized = path.replaceAll(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  return normalized;
}
