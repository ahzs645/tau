import { joinPath, normalizePath } from '@taucad/utils/path';

/**
 * Thrown when an agent-supplied path would resolve outside the workspace root
 * after canonicalization (e.g. `/projects/other/...` when root is `/projects/abc`,
 * or relative segments with `..` that climb above the root).
 *
 * @public
 */
export class WorkspacePathEscapeError extends Error {
  public readonly input: string;
  public readonly root: string;

  /**
   * Captures escape metadata for debugging agent-supplied paths.
   * @param message - Human-readable explanation referencing the offending input.
   * @param init - Canonical input string and normalized workspace root for diagnostics.
   */
  public constructor(message: string, init: { input: string; root: string }) {
    super(message);
    this.name = 'WorkspacePathEscapeError';
    this.input = init.input;
    this.root = init.root;
  }
}

function resolvePathSegmentsUnderRoot(rootNorm: string, relativeSegments: string[], originalInput: string): string {
  const rootSegments = rootNorm.split('/').filter((segment) => segment.length > 0);
  const stack = [...rootSegments];

  for (const segment of relativeSegments) {
    if (segment === '' || segment === '.') {
      continue;
    }

    if (segment === '..') {
      if (stack.length <= rootSegments.length) {
        throw new WorkspacePathEscapeError(
          `Path escapes workspace: segment ".." in "${originalInput}" resolves above root "${rootNorm}"`,
          { input: originalInput, root: rootNorm },
        );
      }

      stack.pop();
    } else {
      stack.push(segment);
    }
  }

  return `/${stack.join('/')}`;
}

/**
 * Projects absolute filesystem paths from the worker into workspace-relative
 * paths for UI facades.
 *
 * @public
 * @example <caption>Resolve an absolute path to a project-relative path</caption>
 * ```typescript
 * import { WorkspacePathResolver } from '@taucad/fs-client/workspace-path-resolver';
 * export function exampleRelativePath(): string | undefined {
 *   const paths = new WorkspacePathResolver('/project');
 *   return paths.toRelativePath('/project/src/a.ts');
 * }
 * ```
 */
export class WorkspacePathResolver {
  public constructor(private rootDirectory: string) {}

  /**
   * Absolute filesystem root configured for this resolver.
   * @returns Normalized workspace mount path.
   */
  public get root(): string {
    return this.rootDirectory;
  }

  /**
   * Normalized prefix for `startsWith` checks (`root` plus exactly one `/`).
   * @returns Absolute root prefix ending with exactly one `/`, or the root when it already ends with `/`.
   */
  public get rootPrefix(): string {
    return this.rootDirectory.endsWith('/') ? this.rootDirectory : `${this.rootDirectory}/`;
  }

  /**
   * Convert an absolute on-disk path to a project-relative path, or `undefined`
   * when the path is outside this workspace.
   * @param absolutePath - Host absolute path emitted by the worker.
   * @returns Project-relative path segments, `''` at workspace root, or `undefined` if outside the root.
   */
  public toRelativePath(absolutePath: string): string | undefined {
    const rootNorm = normalizePath(this.rootDirectory);
    const absNorm = normalizePath(absolutePath);
    if (absNorm === rootNorm) {
      return '';
    }
    const prefix = `${rootNorm}/`;
    if (!absNorm.startsWith(prefix)) {
      return undefined;
    }
    return absNorm.slice(prefix.length);
  }

  /**
   * Join a workspace-relative segment onto the configured root without additional escaping checks.
   * @param relativePath - Path relative to {@link WorkspacePathResolver.root}.
   * @returns Joined absolute path under the configured workspace root.
   */
  public toAbsolutePath(relativePath: string): string {
    return joinPath(this.rootDirectory, relativePath);
  }

  /**
   * Canonical absolute path under this workspace for tool/agent inputs.
   * Treats `''`, `'.'`, `'./'`, `'/'` and the workspace root path as the root.
   * A single leading-slash segment (e.g. `'/src'`) is workspace-root-relative
   * (not host `joinPath` absolute reset). Multi-segment absolute paths outside
   * the workspace throw {@link WorkspacePathEscapeError}.
   *
   * @param input - Raw path from an agent or UI (often not normalized).
   * @returns Normalized absolute path under the workspace.
   * @throws {WorkspacePathEscapeError} When the path escapes the workspace.
   * @public
   */
  public toAbsoluteWorkspacePath(input: string): string {
    const rootNorm = normalizePath(this.rootDirectory);
    const trimmed = input.trim();

    if (trimmed === '' || trimmed === '.' || trimmed === '/' || trimmed === './') {
      return rootNorm;
    }

    // Paths without a leading `/` are workspace-relative. Do not run them through
    // `normalizePath` first: it prepends `/`, which would send `.tau/cache` and
    // `src/a.ts` through the "absolute path" branch and incorrectly throw.
    if (!trimmed.startsWith('/')) {
      let trimmedRelative = trimmed;
      while (trimmedRelative.startsWith('./')) {
        trimmedRelative = trimmedRelative.slice(2);
      }

      if (trimmedRelative === '' || trimmedRelative === '.') {
        return rootNorm;
      }

      const segments = trimmedRelative.split('/').filter((s) => s.length > 0 && s !== '.');
      return resolvePathSegmentsUnderRoot(rootNorm, segments, input);
    }

    const absNormalized = normalizePath(trimmed);
    if (absNormalized === rootNorm || absNormalized.startsWith(`${rootNorm}/`)) {
      return absNormalized;
    }

    if (absNormalized.startsWith('/')) {
      const withoutLeadingSlash = absNormalized.slice(1);
      const topLevelSegments = withoutLeadingSlash.split('/').filter((s) => s.length > 0 && s !== '.');

      if (topLevelSegments.length > 1) {
        throw new WorkspacePathEscapeError(
          `Path escapes workspace: "${input}" is not under workspace root "${rootNorm}"`,
          { input, root: rootNorm },
        );
      }

      if (topLevelSegments.length === 0) {
        return rootNorm;
      }

      return resolvePathSegmentsUnderRoot(rootNorm, topLevelSegments, input);
    }

    let trimmedRelative = trimmed;
    while (trimmedRelative.startsWith('./')) {
      trimmedRelative = trimmedRelative.slice(2);
    }

    if (trimmedRelative === '' || trimmedRelative === '.') {
      return rootNorm;
    }

    const segments = trimmedRelative.split('/').filter((s) => s.length > 0 && s !== '.');
    return resolvePathSegmentsUnderRoot(rootNorm, segments, input);
  }

  /**
   * Parent directory of a workspace-relative path (`''` for root-level files).
   * @param relativePath - Path using `/` separators relative to the workspace root.
   * @returns Parent directory key without a trailing slash, or `''` when already at the root segment.
   */
  public parentOf(relativePath: string): string {
    const slashIndex = relativePath.lastIndexOf('/');
    if (slashIndex === -1) {
      return '';
    }
    return relativePath.slice(0, slashIndex);
  }

  /**
   * Replace the logical workspace root (e.g. after switching projects).
   * @param rootDirectory - New absolute root path for subsequent resolution.
   */
  public reset(rootDirectory: string): void {
    this.rootDirectory = rootDirectory;
  }
}
