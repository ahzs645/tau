/**
 * `FsProtocol` — typed `@taucad/rpc` contract for the Electron filesystem
 * authority seam (Phase 11, R8 seam 2, R9).
 *
 * The protocol is the wire shape that crosses a single
 * `MessageChannelMain` port pair between the renderer-side client and the
 * main-process FS bridge. The main process is the canonical filesystem
 * authority — it owns the disk-backed `RuntimeFileSystemBase` and pushes
 * change events back to the renderer so UI state (file tree, dirty
 * markers, kernel re-render triggers) stays consistent without the
 * renderer ever touching the user's filesystem directly.
 *
 * Why a dedicated protocol instead of reusing `createBridgeServer`'s
 * untyped string-keyed handler form:
 *
 * - The renderer↔main wire is a security boundary; an explicit protocol
 *   pins the full call surface so the host can never accidentally expose
 *   a method by adding a property to a handler bag.
 * - Generic inference in `Channel<P>`/`ChannelServer<P>` is end-to-end —
 *   call args, results, listen events, and notify payloads are all
 *   inferred from this one declaration with zero `unknown`.
 * - The protocol is stable across renderer + main; it lives under
 *   `shared/` so both sides import the same source-of-truth types.
 *
 * Conventions:
 *
 * - `calls.delete` maps to the underlying `RuntimeFileSystemBase.unlink`
 *   call. The protocol uses `delete` as the noun-form verb that aligns
 *   with the Phase 11 plan and matches what an editor UI surfaces to the
 *   user (browsers / VS Code / native shells all label this "Delete").
 * - `listens.watch` is a per-subscription stream backed by
 *   `RuntimeFileSystemBase.watch` — every `listen('watch', request)` from
 *   the client creates a fresh `unsubscribe`-bound subscription on the
 *   host. The `signal` parameter on the host-side iterable is wired to
 *   the client's abort so unsubscribing the iterator tears down the
 *   underlying watch (no leaks across a renderer reload).
 * - `notifies.fileChanged` is a host-broadcast cache-invalidation hint
 *   for clients that hold their own per-path caches (e.g. the kernel's
 *   `FileContentCache`). It fires once per mutating call from the host
 *   and is decoupled from the per-watch `listens.watch` stream so a
 *   client can subscribe to it without setting up a typed watcher.
 */

import type { FileStat } from '@taucad/types';
import type { RuntimeWatchEvent, RuntimeWatchRequest } from '@taucad/runtime';

/**
 * Read-file argument: optional `encoding === 'utf8'` switches the result
 * type from `Uint8Array<ArrayBuffer>` to `string`. Mirrors the
 * `RuntimeFileSystemBase.readFile` overload pair.
 *
 * @public
 */
export type FsReadFileArguments = {
  readonly path: string;
  readonly encoding?: 'utf8';
};

/**
 * Write-file argument: `data` is either binary or UTF-8 text. The host
 * forwards `Uint8Array` payloads as transferables when the underlying
 * port advertises transfer capability.
 *
 * @public
 */
export type FsWriteFileArguments = {
  readonly path: string;
  readonly data: Uint8Array<ArrayBuffer> | string;
};

/**
 * Cache-invalidation hint emitted by the host when an authoritative
 * mutation lands. `kind` mirrors the originating mutation verb so a
 * client can choose a finer-grained invalidation strategy (e.g. evict on
 * `'deleted'`, refetch on `'updated'`).
 *
 * @public
 */
export type FsFileChangedNotify = {
  readonly path: string;
  readonly kind: 'updated' | 'deleted';
};

/**
 * The Electron filesystem authority seam contract.
 *
 * @public
 */
export type FsProtocol = {
  readonly calls: {
    readonly readFile: { args: FsReadFileArguments; result: Uint8Array<ArrayBuffer> | string };
    readonly writeFile: { args: FsWriteFileArguments; result: void };
    readonly readDir: { args: { path: string }; result: readonly string[] };
    readonly stat: { args: { path: string }; result: FileStat };
    readonly exists: { args: { path: string }; result: boolean };
    readonly delete: { args: { path: string }; result: void };
  };
  readonly notifies: {
    readonly fileChanged: { args: FsFileChangedNotify };
  };
  readonly listens: {
    readonly watch: { args: RuntimeWatchRequest; event: RuntimeWatchEvent };
  };
};

/**
 * Session key for the FS authority Channel. Keeping it constant on both
 * ends lets the v5 handshake (`lh`/`lo`) reject a mismatched peer (e.g.
 * a renderer that opens the FS port but speaks the kernel protocol).
 *
 * @public
 */
export const fsProtocolSessionKey = 'taucad:fs-authority';
