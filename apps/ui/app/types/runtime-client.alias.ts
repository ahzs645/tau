/**
 * App-level alias for the runtime client used across the UI.
 *
 * The UI does not statically know which kernels and transcoders it consumes
 * (the set is configured via runtime client options at startup), so this
 * alias intentionally points to the wide-default erasure form
 * `RuntimeClient<KernelPlugin[], TranscoderPlugin[]>`. This is the form
 * documented in `docs/research/runtime-type-bag-propagation.md` (R6) for
 * consumers that need to accept any plugin configuration.
 */

import type { KernelPlugin, RuntimeClient, TranscoderPlugin } from '@taucad/runtime';

/**
 * The runtime client type used throughout the UI app.
 *
 * Use this alias instead of inlining `RuntimeClient<KernelPlugin[], TranscoderPlugin[]>`
 * so that downstream consumers have a single source of truth and can be
 * narrowed in one place if/when the UI standardizes on a fixed plugin set.
 */
// oxlint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- intentional: documents the wide-default erasure form per R6
export type AppRuntimeClient = RuntimeClient<KernelPlugin[], TranscoderPlugin[]>;
