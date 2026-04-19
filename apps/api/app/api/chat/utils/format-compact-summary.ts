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
