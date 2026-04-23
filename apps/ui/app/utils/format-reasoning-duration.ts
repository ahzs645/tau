/** Milliseconds. */
const briefThreshold = 1000;
/** Milliseconds. */
const minute = 60_000;

/**
 * Format a reasoning duration for display in `ChatMessageReasoning`'s
 * collapsible header. Input is milliseconds.
 *
 * Buckets:
 * - `< 1000ms` → `"Thought briefly"` / `"Thinking…"`
 * - `< 60_000ms` → `"{verb} for {Math.round(ms/1000)}s"`
 * - `>= 60_000ms` → `"{verb} for {m}m"` or `"{verb} for {m}m {s}s"` (no trailing `0s`)
 *
 * `verb` controls the live-streaming case (`Thinking`) vs the resolved
 * past-tense case (`Thought`, default). The `Thinking…` fallback during the
 * sub-second window matches the prior-art shimmer pattern from Cline / Zoo
 * Modeling App so the header doesn't visually flicker between briefly and
 * the first full second tick.
 *
 * @param duration - Duration in milliseconds.
 */
export const formatReasoningDuration = (duration: number, options: { verb?: 'Thought' | 'Thinking' } = {}): string => {
  const verb = options.verb ?? 'Thought';
  if (duration < briefThreshold) {
    return verb === 'Thinking' ? 'Thinking…' : 'Thought briefly';
  }
  if (duration < minute) {
    const seconds = Math.round(duration / 1000);
    return `${verb} for ${seconds}s`;
  }
  const totalSeconds = Math.round(duration / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${verb} for ${minutes}m` : `${verb} for ${minutes}m ${seconds}s`;
};
