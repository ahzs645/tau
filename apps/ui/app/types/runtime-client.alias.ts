/**
 * App-level aliases for the runtime client used across the UI.
 *
 * The UI does not statically know which kernels and transcoders it consumes
 * (the set is configured via runtime client options at startup), so these
 * aliases intentionally point to the wide-default erasure forms, matching
 * how the app accepts any plugin configuration configured at runtime.
 */

import type { KernelPlugin, RuntimeClient, RuntimeClientOptions, TranscoderPlugin } from '@taucad/runtime';
import type { RuntimeFileSystem } from '@taucad/runtime/filesystem';

/**
 * The runtime client type used throughout the UI app.
 *
 * Use this alias instead of inlining `RuntimeClient<KernelPlugin[], TranscoderPlugin[]>`
 * so that downstream consumers have a single source of truth and can be
 * narrowed in one place if/when the UI standardizes on a fixed plugin set.
 */
// oxlint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- intentional wide-default `RuntimeClient<KernelPlugin[], TranscoderPlugin[]>` form
export type AppRuntimeClient = RuntimeClient<KernelPlugin[], TranscoderPlugin[]>;

/**
 * Deferred-construction shape for {@link RuntimeClientOptions}.
 *
 * The web-worker transport requires the file-system bridge handle and
 * the file-content `SharedArrayBuffer` to be supplied at construction
 * time, but both are owned by the file-manager machine and only
 * become available after it reaches `ready`. UI surfaces accept this
 * factory and invoke it inside the cad-machine's `connectKernelActor`
 * once the snapshot is in scope, keeping the runtime invariant that
 * `client.connect()` takes no arguments.
 */
export type KernelOptionsFactory = (deps: {
  readonly fileSystem: RuntimeFileSystem;
  readonly filePoolBuffer?: SharedArrayBuffer;
}) => RuntimeClientOptions;

/**
 * Async loader for {@link KernelOptionsFactory}.
 *
 * Invoked from `connectKernelActor` after the file-manager worker is ready so
 * `@taucad/runtime` and `kernel-worker.constants` stay off the SSR eager graph.
 */
export type LazyKernelOptionsFactory = () => Promise<KernelOptionsFactory>;
