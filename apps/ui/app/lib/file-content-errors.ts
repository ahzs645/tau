/**
 * Thrown by `FileContentService.resolveBytes` when the resolved content
 * sniffs as binary. Carries the path and observed file size so callers can
 * surface a meaningful error without re-resolving.
 */
export class BinaryFileError extends Error {
  public readonly path: string;
  public readonly size: number;

  public constructor(message: string, init: { path: string; size: number }) {
    super(message);
    this.name = 'BinaryFileError';
    this.path = init.path;
    this.size = init.size;
  }
}

/**
 * Thrown by `FileContentService.resolveBytes` when the file size exceeds the
 * configured open-time limit. Distinct from `BoundedFileCache` rejection,
 * which is a cache-budget concern only.
 */
export class FileTooLargeError extends Error {
  public readonly path: string;
  public readonly size: number;
  public readonly limit: number;

  public constructor(message: string, init: { path: string; size: number; limit: number }) {
    super(message);
    this.name = 'FileTooLargeError';
    this.path = init.path;
    this.size = init.size;
    this.limit = init.limit;
  }
}

/**
 * Thrown by `FileContentService.resolveBytes` when the worker reports the
 * underlying file does not exist (ENOENT).
 */
export class FileNotFoundError extends Error {
  public readonly path: string;

  public constructor(message: string, init: { path: string }) {
    super(message);
    this.name = 'FileNotFoundError';
    this.path = init.path;
  }
}
