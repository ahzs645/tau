/**
 * Typed directory listing surface for {@link FileTreeService.listDirectory}.
 *
 * @public
 */
export type ListedDirectoryEntry = {
  name: string;
  path: string;
  isFolder: boolean;
  /** File size in bytes, or `0` for directories. */
  size: number;
  /** Last-modified timestamp in milliseconds since the Unix epoch. */
  mtimeMs: number;
};

/**
 * Discriminated snapshot for reactive directory listing consumers (see {@link useDirectoryListing}).
 *
 * @public
 */
export type DirectoryListing =
  | { kind: 'unready' }
  | { kind: 'loading'; path: string }
  | { kind: 'ready'; path: string; entries: readonly ListedDirectoryEntry[] }
  | { kind: 'error'; path: string; cause: DirectoryListingError };

/**
 * Operation-level error for directory listing (mirrors a coarse VSCode-style ladder).
 *
 * @public
 */
export type DirectoryListingError = {
  code: DirectoryListingErrorCode;
  message: string;
  path: string;
  original?: unknown;
};

/**
 * @public
 */
export const DirectoryListingErrorCode = {
  NotFound: 'NotFound',
  NotADirectory: 'NotADirectory',
  PermissionDenied: 'PermissionDenied',
  Aborted: 'Aborted',
  Unavailable: 'Unavailable',
  Unknown: 'Unknown',
} as const;

/**
 * @public
 */
export type DirectoryListingErrorCode = (typeof DirectoryListingErrorCode)[keyof typeof DirectoryListingErrorCode];

/**
 * @public
 */
export class DirectoryListingFailedError extends Error {
  public readonly listing: DirectoryListingError;

  public constructor(listing: DirectoryListingError) {
    super(listing.message);
    this.name = 'DirectoryListingFailedError';
    this.listing = listing;
  }
}

/**
 * Classify a thrown value from `readDirectory` / transport into a
 * {@link DirectoryListingError}.
 *
 * @public
 */
export function classifyDirectoryListingError(cause: unknown, path: string): DirectoryListingError {
  if (typeof cause === 'object' && cause !== null && 'listing' in cause) {
    const failed = cause as DirectoryListingFailedError;
    if (failed instanceof DirectoryListingFailedError) {
      return failed.listing;
    }
  }
  if (cause instanceof Error && cause.name === 'WorkspacePathEscapeError') {
    return {
      code: DirectoryListingErrorCode.Unknown,
      message: cause.message,
      path,
      original: cause,
    };
  }
  if (cause instanceof DOMException && cause.name === 'AbortError') {
    return { code: DirectoryListingErrorCode.Aborted, message: cause.message, path, original: cause };
  }
  if (cause instanceof Error && cause.name === 'AbortError') {
    return { code: DirectoryListingErrorCode.Aborted, message: cause.message, path, original: cause };
  }
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { code?: string }).code;
    if (code === 'ENOENT') {
      return { code: DirectoryListingErrorCode.NotFound, message: 'Path not found', path, original: cause };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        code: DirectoryListingErrorCode.PermissionDenied,
        message: 'Permission denied',
        path,
        original: cause,
      };
    }
    if (code === 'ENOTDIR') {
      return {
        code: DirectoryListingErrorCode.NotADirectory,
        message: 'Not a directory',
        path,
        original: cause,
      };
    }
  }
  if (cause instanceof Error) {
    return { code: DirectoryListingErrorCode.Unknown, message: cause.message, path, original: cause };
  }
  return { code: DirectoryListingErrorCode.Unknown, message: String(cause), path, original: cause };
}
