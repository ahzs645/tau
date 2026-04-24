/**
 * App-level alias for the runtime client used across the API.
 *
 * The API does not statically know which kernels and transcoders it consumes
 * at module load (configured via runtime client options at startup), so this
 * alias intentionally points to the wide-default erasure form
 * `RuntimeClient<KernelPlugin[], TranscoderPlugin[]>`, matching how the
 * app accepts any plugin configuration configured at runtime.
 */

import type { KernelPlugin, RuntimeClient, TranscoderPlugin } from '@taucad/runtime';

/**
 * The runtime client type used throughout the API app.
 *
 * Use this alias instead of inlining `RuntimeClient<KernelPlugin[], TranscoderPlugin[]>`
 * so that downstream consumers have a single source of truth and can be
 * narrowed in one place if/when the API standardizes on a fixed plugin set.
 */
// oxlint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- intentional wide-default `RuntimeClient<KernelPlugin[], TranscoderPlugin[]>` form
export type ApiRuntimeClient = RuntimeClient<KernelPlugin[], TranscoderPlugin[]>;
