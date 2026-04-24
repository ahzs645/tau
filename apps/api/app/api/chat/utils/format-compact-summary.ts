/**
 * Strips `<analysis>` scratchpad and unwraps `<summary>` from compaction output.
 *
 * The compaction prompt asks the summarizing model to first reason inside an
 * `<analysis>` tag and then emit the canonical summary inside `<summary>`. We
 * persist only the summary because the analysis is a private scratchpad that
 * would inflate downstream context without carrying durable signal.
 *
 * 1. Remove `<analysis>...</analysis>` (reasoning scratchpad, not needed downstream)
 * 2. Unwrap `<summary>...</summary>` tags (extract inner content)
 * 3. Normalize runs of 3+ blank lines down to 2
 */
export function formatCompactSummary(content: string): string {
  let result = content;

  result = result.replaceAll(/<analysis>[\S\s]*?<\/analysis>/g, '');

  const summaryMatch = /<summary>([\S\s]*?)<\/summary>/.exec(result);
  if (summaryMatch?.[1]) {
    result = summaryMatch[1];
  }

  result = result.replaceAll(/\n{3,}/g, '\n\n');

  return result.trim();
}

/**
 * Canonical 9-section headings expected from the compaction prompt in
 * `compaction.service.ts`. Order matters: `parseCompactSummary` reports
 * missing sections in this order so the validator output is stable.
 */
export const compactSummarySectionNames = [
  'Primary Request and Intent',
  'Key Technical Concepts',
  'Files and Code Sections',
  'Errors and Fixes',
  'Problem Solving',
  'All User Messages',
  'Pending Tasks',
  'Current Work',
  'Optional Next Step',
] as const;

export type CompactSummarySectionName = (typeof compactSummarySectionNames)[number];

export type ParsedCompactSummary =
  | { ok: true; sections: readonly CompactSummarySectionName[] }
  | { ok: false; missingSections: readonly CompactSummarySectionName[] };

/**
 * Validate a compaction summary against the 9-section contract. Returns
 * `ok: true` only when every numbered heading from `compactSummarySectionNames`
 * is present (case-sensitive prefix match on the leading "<n>. <heading>" form).
 *
 * The compaction middleware uses this to decide whether to ship the Morph
 * output as the new conversation seed or fall back to the truncate-tool-args
 * tier — a malformed summary would silently strip large swathes of context
 * from the agent.
 */
export function parseCompactSummary(content: string): ParsedCompactSummary {
  if (!content.trim()) {
    return { ok: false, missingSections: compactSummarySectionNames };
  }

  const missing: CompactSummarySectionName[] = [];
  for (const [index, name] of compactSummarySectionNames.entries()) {
    const headingPrefix = `${index + 1}. ${name}`;
    if (!content.includes(headingPrefix)) {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    return { ok: false, missingSections: missing };
  }

  return { ok: true, sections: compactSummarySectionNames };
}
