/**
 * Structured workspace-identity errors raised by {@link ProviderRegistry}
 * and {@link WorkspaceFileService}.
 *
 * These errors replace string-matched `Error` shapes (e.g. legacy
 * `'No directory handle set...'`) so UI-side recovery surfaces can switch
 * on `error.code` instead of parsing messages. Mirrors the UI-side
 * `WorkspaceDirectoryRequiredError` shape (`apps/ui/app/filesystem/workspace-errors.ts`)
 * so worker-thrown errors can be mapped one-to-one at the bridge boundary.
 *
 * @public
 */

/**
 * Thrown when a `webaccess` operation is attempted without a usable
 * `{ directoryHandle, workspaceId }` pair. The discriminated
 * {@link MountConfig} / {@link WorkspaceScope} unions make this a
 * compile-time error in well-typed call sites; the runtime exception
 * defends against unsafe callers (raw RPC clients, tests).
 *
 * @public
 */
export class MissingWorkspaceHandleError extends Error {
  /**
   * Discriminator that lets callers branch without `instanceof`.
   *
   * @returns The literal `'missing-workspace-handle'`.
   */
  public get code(): 'missing-workspace-handle' {
    return 'missing-workspace-handle';
  }
  public readonly workspaceId: string | undefined;

  public constructor(options?: { workspaceId?: string; cause?: unknown }) {
    super('Webaccess operation requires an explicit { directoryHandle, workspaceId } scope.');
    this.name = 'MissingWorkspaceHandleError';
    this.workspaceId = options?.workspaceId;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Type guard for {@link MissingWorkspaceHandleError}.
 *
 * @param error - Value to test.
 * @returns `true` if `error` is an instance of {@link MissingWorkspaceHandleError}.
 * @public
 */
export function isMissingWorkspaceHandleError(error: unknown): error is MissingWorkspaceHandleError {
  return error instanceof MissingWorkspaceHandleError;
}
