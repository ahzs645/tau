// oxlint-disable-next-line eslint-plugin-import/no-named-as-default -- standard zod default import
import z from 'zod';
import type { ReasoningUIPart } from 'ai';

/**
 * Tau-attached, provider-agnostic reasoning metadata.
 *
 * Lives under the `common` namespace of `providerMetadata` on every
 * `reasoning-start` / `reasoning-end` chunk. The two endpoints are stamped
 * server-side; the final duration is **derived** client-side as
 * `reasoningEndedAtMs - reasoningStartedAtMs` so the wire format stays minimal
 * and the source of truth is a function of the two timestamps.
 *
 * See `docs/research/reasoning-duration-display.md` § Finding 7 (minimal-state
 * server design) and § Finding 8 (AI SDK `providerMetadata` replace-on-write)
 * for why both endpoints land on the `reasoning-end` chunk via a per-stream
 * lookup, and why duration is derived rather than transmitted.
 *
 * @public
 */
export const commonReasoningMetadataSchema = z.object({
  reasoningStartedAtMs: z.number().int().nonnegative().optional(),
  reasoningEndedAtMs: z.number().int().nonnegative().optional(),
});

/** @public */
export type CommonReasoningMetadata = z.infer<typeof commonReasoningMetadataSchema>;

/**
 * Funnel the loose `Record<string, JSONValue>` `providerMetadata.common` shape
 * through the typed schema so callers consume `CommonReasoningMetadata`
 * without `as` casts. `safeParse` accepts `unknown` directly — malformed
 * values silently degrade to `undefined`, which the UI handles via its
 * "Thought process" fallback label.
 */
const readCommonReasoningMetadata = (part: ReasoningUIPart): CommonReasoningMetadata | undefined => {
  const result = commonReasoningMetadataSchema.safeParse(part.providerMetadata?.['common']);
  return result.success ? result.data : undefined;
};

/** @public */
export const getReasoningStartedAtMs = (part: ReasoningUIPart): number | undefined =>
  readCommonReasoningMetadata(part)?.reasoningStartedAtMs;

/** @public */
export const getReasoningEndedAtMs = (part: ReasoningUIPart): number | undefined =>
  readCommonReasoningMetadata(part)?.reasoningEndedAtMs;

/**
 * Derived final reasoning duration in milliseconds.
 *
 * Returns `reasoningEndedAtMs - reasoningStartedAtMs` clamped to `>= 0` when
 * both endpoints are present (i.e. the reasoning block has fully closed).
 * Returns `undefined` for in-progress blocks or pre-instrumentation parts.
 *
 * The clamp protects against a server-side NTP backwards jump landing between
 * the two `Date.now()` reads (operationally rare, visible in OS logs).
 *
 * @public
 */
export const getReasoningDurationMs = (part: ReasoningUIPart): number | undefined => {
  const meta = readCommonReasoningMetadata(part);
  if (meta?.reasoningStartedAtMs === undefined || meta.reasoningEndedAtMs === undefined) {
    return undefined;
  }
  return Math.max(0, meta.reasoningEndedAtMs - meta.reasoningStartedAtMs);
};
