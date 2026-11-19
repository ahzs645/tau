const isParameterObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Apply only fields edited against the rendered form, retaining newer independent edits. */
export const mergeParameterChanges = (
  current: Record<string, unknown>,
  change: { readonly next: Record<string, unknown>; readonly base: Record<string, unknown> },
): Record<string, unknown> => {
  const merged = new Map(Object.entries(current));
  for (const key of new Set([...Object.keys(change.next), ...Object.keys(change.base)])) {
    const next = change.next[key];
    const base = change.base[key];
    const latest = current[key];
    if (JSON.stringify(next) === JSON.stringify(base)) {
      continue;
    }
    if (!(key in change.next)) {
      merged.delete(key);
    } else if (isParameterObject(next) && isParameterObject(base) && isParameterObject(latest)) {
      merged.set(key, mergeParameterChanges(latest, { next, base }));
    } else {
      merged.set(key, next);
    }
  }
  return Object.fromEntries(merged);
};
