/**
 * Assistant message activity grouping.
 *
 * Groups consecutive message parts into logical "activity chunks" for the chat UI,
 * enabling Cursor-style two-level folding:
 *
 * - **Outer fold**: the entire activity prefix (reasoning + research) collapses when
 *   a downstream text answer exists, keeping focus on the final response.
 * - **Inner fold**: the aggregated `research` group (web + file exploration) shows
 *   a one-line combined summary that expands to the individual tool rows.
 *
 * Streaming bias: while a message is still in-flight, activity stays expanded
 * so progress is visible. Collapse happens once the final answer text arrives.
 *
 * Parts are never reordered — consecutive runs of aggregatable categories merge,
 * while text or reasoning between tools forces a split. Empty/whitespace text
 * parts and `step-start` are transparent (they neither render nor split).
 *
 * File edits and CAD operations always render as singletons so their rich
 * per-call cards (diffs, kernel issues, screenshots) remain visible.
 */

import type { MyMessagePart } from '@taucad/chat';

// ── Categories ───────────────────────────────────────────────────────────────

/**
 * Activity categories for message part classification.
 *
 * - `text` / `reasoning` / `data` / `transfer` → rendered as singletons (no aggregation).
 * - `write` / `cad` → singletons preserving rich per-call cards.
 * - `research` → aggregatable (web search + file exploration combined).
 * - `skip` → invisible parts (`step-start`, `data-usage`, `data-context-usage`,
 *   empty/whitespace text).
 */
export type ActivityCategory = 'text' | 'reasoning' | 'research' | 'write' | 'cad' | 'transfer' | 'data' | 'skip';

const aggregatableCategories = new Set<ActivityCategory>(['research']);

/**
 * Bridging predicate: a bridging part is appended to a pending aggregated run
 * optimistically. At flush time, any *trailing* bridging parts are peeled off
 * and re-emitted as singletons, so only parts that end up sandwiched between
 * two same-category research parts get absorbed.
 *
 * Result: leading reasoning stays a singleton (no pending group exists yet),
 * trailing reasoning stays a singleton (peeled off at flush), and reasoning
 * sandwiched between two research parts is absorbed inline.
 */
const isBridging = (category: ActivityCategory): boolean => category === 'reasoning';

/**
 * Static category map for non-text part types. `text` is handled separately
 * because empty/whitespace strings classify as `skip`, not `text`.
 */
const partTypeCategoryMap = new Map<string, ActivityCategory>([
  ['reasoning', 'reasoning'],
  ['step-start', 'skip'],
  ['data-usage', 'skip'],
  ['data-context-usage', 'skip'],
  ['data-context-compaction', 'data'],
  ['file', 'text'],
  ['source-url', 'text'],
  ['source-document', 'text'],

  // Research: web + file exploration aggregate into one combined group
  ['tool-web_search', 'research'],
  ['tool-web_browser', 'research'],
  ['tool-read_file', 'research'],
  ['tool-list_directory', 'research'],
  ['tool-grep', 'research'],
  ['tool-glob_search', 'research'],

  // Write tools: singletons (preserve rich per-call diff cards)
  ['tool-edit_file', 'write'],
  ['tool-create_file', 'write'],
  ['tool-delete_file', 'write'],
  ['tool-edit_tests', 'write'],

  // CAD tools: singletons (preserve kernel issues, screenshots, model results)
  ['tool-get_kernel_result', 'cad'],
  ['tool-screenshot', 'cad'],
  ['tool-test_model', 'cad'],

  // Transfer tools
  ['tool-transfer_to_cad_expert', 'transfer'],
  ['tool-transfer_to_research_expert', 'transfer'],
  ['tool-transfer_back_to_supervisor', 'transfer'],
]);

/**
 * Maps a message part to its activity category.
 */
export const classifyActivityPart = (part: MyMessagePart): ActivityCategory => {
  if (part.type === 'text') {
    return part.text.trim() === '' ? 'skip' : 'text';
  }
  return partTypeCategoryMap.get(part.type) ?? 'data';
};

// ── Group types ──────────────────────────────────────────────────────────────

export type SingletonGroup = {
  readonly kind: 'singleton';
  readonly part: MyMessagePart;
  readonly partIndex: number;
  readonly category: ActivityCategory;
};

export type AggregatedGroup = {
  readonly kind: 'aggregated';
  readonly category: ActivityCategory;
  readonly parts: readonly MyMessagePart[];
  readonly partIndices: readonly number[];
  /**
   * Combined summary string `${summaryVerb} ${summaryDetail}`. Kept for callers
   * (e.g. `ChatActivitySection` title) that want a single label.
   */
  readonly summary: string;
  /** Verb fragment, e.g. `"Explored"`. Rendered with emphasis in the header. */
  readonly summaryVerb: string;
  /** Detail fragment, e.g. `"2 web searches, 1 file"`. Rendered de-emphasized. */
  readonly summaryDetail: string;
};

export type ActivityGroup = SingletonGroup | AggregatedGroup;

// ── Summary generation ───────────────────────────────────────────────────────

const pluralize = (count: number, singular: string, plural?: string): string =>
  `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;

type SummaryParts = { verb: string; detail: string };

/**
 * Combined summary for the unified `research` category.
 *
 * Mirrors Cursor's mixed-group behavior: web search and code search collapse
 * into a single `searches` count (they are conceptually the same operation
 * from the consumer's perspective). Web URL visits become `fetches`. File
 * reads + directory listings become `files`. Segments are emitted in the
 * stable order `files → searches → fetches`.
 */
const generateResearchSummary = (parts: readonly MyMessagePart[]): SummaryParts => {
  let files = 0;
  let searches = 0;
  let fetches = 0;

  for (const part of parts) {
    switch (part.type) {
      case 'tool-read_file':
      case 'tool-list_directory': {
        files++;
        break;
      }
      case 'tool-web_search':
      case 'tool-grep':
      case 'tool-glob_search': {
        searches++;
        break;
      }
      case 'tool-web_browser': {
        fetches++;
        break;
      }
    }
  }

  const segments: string[] = [];
  if (files > 0) {
    segments.push(pluralize(files, 'file'));
  }
  if (searches > 0) {
    segments.push(pluralize(searches, 'search', 'searches'));
  }
  if (fetches > 0) {
    segments.push(pluralize(fetches, 'fetch', 'fetches'));
  }

  return { verb: 'Explored', detail: segments.join(', ') };
};

const generateSummary = (category: ActivityCategory, parts: readonly MyMessagePart[]): SummaryParts => {
  switch (category) {
    case 'research': {
      return generateResearchSummary(parts);
    }
    default: {
      return { verb: '', detail: `${parts.length} operations` };
    }
  }
};

const composeSummary = ({ verb, detail }: SummaryParts): string => (verb === '' ? detail : `${verb} ${detail}`);

// ── Activity prefix detection ────────────────────────────────────────────────

/**
 * Finds the index in `groups` where the "activity prefix" ends and the
 * substantive answer text begins. Returns `groups.length` if the entire message
 * is activity (no trailing text).
 *
 * The prefix consists of everything up to (but not including) the first
 * `text` singleton. Reasoning, aggregated research, write, cad, data,
 * transfers, and skipped parts are all considered part of the activity prefix.
 */
export const findActivityPrefixEnd = (groups: readonly ActivityGroup[]): number => {
  for (const [i, group] of groups.entries()) {
    if (group.kind === 'singleton' && group.category === 'text') {
      return i;
    }
  }
  return groups.length;
};

/**
 * Returns the index of the last "meaningful" part in `parts` (highest index
 * where `classifyActivityPart` is not `'skip'`). Returns `-1` for empty input
 * or when every part is skipped.
 *
 * Used to drive per-part auto-collapse: a part at index `i` is considered the
 * trailing live part when `i === findLastMeaningfulPartIndex(parts)`. Reasoning
 * uses this so it auto-collapses as soon as any non-skip part follows it
 * (tool call, text, another reasoning, etc.) — not just text.
 */
export const findLastMeaningfulPartIndex = (parts: readonly MyMessagePart[]): number => {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (classifyActivityPart(parts[i]!) !== 'skip') {
      return i;
    }
  }
  return -1;
};

// ── Grouping ─────────────────────────────────────────────────────────────────

/**
 * Groups an assistant message's parts into an ordered list of singletons and
 * aggregated tool groups for two-level folding in the chat UI.
 *
 * Consecutive parts in the aggregatable `research` category merge into one
 * `AggregatedGroup`. Non-aggregatable parts (text, write, cad, data,
 * transfer) pass through as `SingletonGroup`. Skipped parts (`step-start`,
 * `data-usage`, empty text) are transparent — they don't interrupt adjacent
 * groups and are omitted from output.
 *
 * Bridging: while a research run is pending, reasoning parts are appended to
 * it optimistically (see {@link isBridging}). When the run finalizes, any
 * trailing bridging parts are peeled off and re-emitted as singletons, so
 * only sandwiched reasoning ends up inside an aggregated group; leading and
 * trailing reasoning remain separate singletons.
 */
export const groupAssistantParts = (parts: readonly MyMessagePart[]): ActivityGroup[] => {
  const groups: ActivityGroup[] = [];

  let pendingCategory: ActivityCategory | undefined;
  let pendingParts: MyMessagePart[] = [];
  let pendingIndices: number[] = [];

  const flushPending = (): void => {
    if (pendingCategory === undefined || pendingParts.length === 0) {
      pendingCategory = undefined;
      pendingParts = [];
      pendingIndices = [];
      return;
    }

    const tail: Array<{ part: MyMessagePart; index: number }> = [];
    while (pendingParts.length > 0 && isBridging(classifyActivityPart(pendingParts.at(-1)!))) {
      const part = pendingParts.pop()!;
      const index = pendingIndices.pop()!;
      tail.unshift({ part, index });
    }

    if (pendingParts.length > 0) {
      const summaryParts = generateSummary(pendingCategory, pendingParts);
      groups.push({
        kind: 'aggregated',
        category: pendingCategory,
        parts: pendingParts,
        partIndices: pendingIndices,
        summary: composeSummary(summaryParts),
        summaryVerb: summaryParts.verb,
        summaryDetail: summaryParts.detail,
      });
    } else {
      // All pending parts were bridging — re-emit them as singletons in order.
      // (Cannot happen given current callers, but keeps the helper total.)
    }

    for (const { part, index } of tail) {
      groups.push({
        kind: 'singleton',
        part,
        partIndex: index,
        category: classifyActivityPart(part),
      });
    }

    pendingCategory = undefined;
    pendingParts = [];
    pendingIndices = [];
  };

  for (const [i, part] of parts.entries()) {
    const category = classifyActivityPart(part);

    if (category === 'skip') {
      continue;
    }

    if (isBridging(category)) {
      if (pendingCategory === undefined) {
        groups.push({ kind: 'singleton', part, partIndex: i, category });
      } else {
        pendingParts.push(part);
        pendingIndices.push(i);
      }
      continue;
    }

    if (aggregatableCategories.has(category)) {
      if (pendingCategory === category) {
        pendingParts.push(part);
        pendingIndices.push(i);
      } else {
        flushPending();
        pendingCategory = category;
        pendingParts = [part];
        pendingIndices = [i];
      }
    } else {
      flushPending();
      groups.push({
        kind: 'singleton',
        part,
        partIndex: i,
        category,
      });
    }
  }

  flushPending();

  return groups;
};
