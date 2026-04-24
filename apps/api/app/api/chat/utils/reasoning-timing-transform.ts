import type { UIMessageChunk } from 'ai';
import type { CommonReasoningMetadata } from '@taucad/chat';

type ReasoningStartChunk = Extract<UIMessageChunk, { type: 'reasoning-start' }>;
type ProviderMetadata = NonNullable<ReasoningStartChunk['providerMetadata']>;

/**
 * `providerMetadata` namespace under which Tau attaches non-provider-specific
 * reasoning metadata (start/end timestamps). The `common` namespace is used
 * (rather than a `taucad`-specific one) because the timing data is
 * cross-cutting agent UI metadata that is not tied to a specific provider —
 * any future Tau-agnostic consumer can read it without coupling to our brand.
 */
const commonMetadataNamespace = 'common';

/**
 * Merge a typed `Partial<CommonReasoningMetadata>` into a chunk's existing
 * `providerMetadata` without clobbering sibling provider namespaces (e.g.
 * Anthropic's `thinkingSignature`) or pre-existing `common` keys.
 *
 * The AI SDK types `providerMetadata[string]` as `JSONObject` — a recursive
 * `{ [k: string]: JSONValue | undefined }` — which `typescript-eslint`'s
 * type-aware `no-unsafe-assignment` rule treats as `any`-equivalent under
 * spread. The disables below are scoped to the spread sites only; the
 * function signature itself remains fully typed against the AI SDK's
 * `ProviderMetadata` and our own `CommonReasoningMetadata`.
 */
const stampCommonMetadata = (
  existing: ProviderMetadata | undefined,
  patch: Partial<CommonReasoningMetadata>,
): ProviderMetadata => {
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- AI SDK JSONObject recursion confuses type-aware lint; runtime shape is verified by `commonReasoningMetadataSchema`
  const existingCommon = (existing?.[commonMetadataNamespace] ?? {}) as CommonReasoningMetadata;
  const mergedCommon: CommonReasoningMetadata = { ...existingCommon, ...patch };
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- AI SDK JSONObject recursion confuses type-aware lint; runtime shape is verified by `commonReasoningMetadataSchema`
  return { ...existing, [commonMetadataNamespace]: mergedCommon };
};

/**
 * Minimal-state `TransformStream` that stamps server-side timestamps on
 * `reasoning-start` and `reasoning-end` chunks under the `common`
 * `providerMetadata` namespace, so the assembled `ReasoningUIPart` carries
 * both endpoints and the client can derive a duration.
 *
 * Properties (validated by `reasoning-timing-transform.test.ts`):
 * - **Minimal-state** — a single per-`TransformStream`-instance
 *   `Map<reasoningId, startedAtMs>` carries the start timestamp from
 *   `reasoning-start` to its matching `reasoning-end`. Required to work
 *   around the AI SDK's `processUIMessageStream` reducer behaviour:
 *   `ReasoningUIPart.providerMetadata` is **replaced** (not merged) on
 *   every chunk that supplies one, so emitting only `reasoningEndedAtMs`
 *   on `reasoning-end` would discard the start timestamp from
 *   `reasoning-start`. By re-stamping `reasoningStartedAtMs` on
 *   `reasoning-end` (looked up from the map), both endpoints survive the
 *   reducer's last-writer-wins replacement. Map entries are deleted on
 *   `reasoning-end`, bounding memory by the number of concurrent reasoning
 *   blocks within one HTTP stream (typically 1–2). The map dies with the
 *   stream — no cross-request leakage.
 * - **Non-blocking** — the `transform` callback is synchronous and the
 *   `reasoning-delta` hot path is a single `controller.enqueue(chunk)` line
 *   with zero metadata mutation. Throughput is identical to a no-op pipe.
 * - **Provider-namespace preserving** — sibling namespaces (e.g.
 *   `anthropic.thinkingSignature`) are spread through unchanged when
 *   stamping `common`.
 * - **Unmatched-end safe** — when a `reasoning-end` arrives with no
 *   matching `reasoning-start` (upstream bug), `reasoningStartedAtMs` is
 *   **omitted** (not fabricated). The client's `getReasoningDurationMs`
 *   cleanly returns `undefined` and the UI falls back to "Thought process".
 *
 * The final reasoning duration is **derived client-side** as
 * `reasoningEndedAtMs - reasoningStartedAtMs` rather than computed here —
 * the wire format stays minimal and the source of truth is a function of
 * the two timestamps. Keeping derivation client-side also means a clock-skew
 * compensation policy can evolve in the UI without a server change.
 */
export function createReasoningTimingTransform(): TransformStream<UIMessageChunk, UIMessageChunk> {
  // Per-stream ledger of reasoning-start timestamps, keyed by chunk id.
  // Drained on reasoning-end so the high-water mark is bounded by the
  // number of concurrent reasoning blocks within one HTTP stream
  // (typically 1-2). Closure-captured by the TransformStream instance,
  // so it dies with the stream — no cross-request leakage.
  const startedAtMsById = new Map<string, number>();

  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (chunk.type === 'reasoning-start') {
        const startedAtMs = Date.now();
        startedAtMsById.set(chunk.id, startedAtMs);
        controller.enqueue({
          ...chunk,
          // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- AI SDK JSONObject recursion confuses type-aware lint; helper return type is concretely typed
          providerMetadata: stampCommonMetadata(chunk.providerMetadata, {
            reasoningStartedAtMs: startedAtMs,
          }),
        });
        return;
      }

      if (chunk.type === 'reasoning-end') {
        const startedAtMs = startedAtMsById.get(chunk.id);
        startedAtMsById.delete(chunk.id);
        // Carry the matching start forward so the AI SDK reducer's
        // replace-on-write replacement doesn't drop it. Omitted (not
        // fabricated) for unmatched ends so getReasoningDurationMs cleanly
        // returns undefined and the UI falls back to "Thought process".
        const patch: Partial<CommonReasoningMetadata> =
          startedAtMs === undefined
            ? { reasoningEndedAtMs: Date.now() }
            : { reasoningStartedAtMs: startedAtMs, reasoningEndedAtMs: Date.now() };
        controller.enqueue({
          ...chunk,
          // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- AI SDK JSONObject recursion confuses type-aware lint; helper return type is concretely typed
          providerMetadata: stampCommonMetadata(chunk.providerMetadata, patch),
        });
        return;
      }

      controller.enqueue(chunk);
    },
  });
}
