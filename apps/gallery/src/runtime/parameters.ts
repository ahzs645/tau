const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Copy parameter values and canonicalize object order before the runtime computes cache keys. */
const copyValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => copyValue(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key): [string, unknown] => [key, copyValue(value[key])]),
    );
  }
  return value;
};

export const copyParameters = (parameters: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(
    Object.keys(parameters)
      .sort()
      .map((key): [string, unknown] => [key, copyValue(parameters[key])]),
  );

const mergeParameters = (
  defaults: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const merged = new Map(Object.entries(copyParameters(defaults)));
  for (const [key, value] of Object.entries(overrides)) {
    const original = merged.get(key);
    merged.set(key, isRecord(original) && isRecord(value) ? mergeParameters(original, value) : copyValue(value));
  }
  return copyParameters(Object.fromEntries(merged));
};

/**
 * Old gallery links and presets use flat OpenSCAD variable names. The current customizer groups them.
 * Move an unambiguous legacy name into its declared group; preserve unknown keys for runtime validation.
 */
export const resolveGalleryParameters = (
  defaults: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const grouped = new Map(Object.entries(copyParameters(overrides)));
  for (const [key, value] of Object.entries(overrides)) {
    if (Object.hasOwn(defaults, key)) {
      continue;
    }
    const groups = Object.entries(defaults).filter(([, fields]) => isRecord(fields) && Object.hasOwn(fields, key));
    if (groups.length !== 1) {
      continue;
    }
    const group = groups[0]![0];
    const fields = grouped.get(group);
    grouped.set(group, { ...(isRecord(fields) ? fields : {}), [key]: copyValue(value) });
    grouped.delete(key);
  }
  return mergeParameters(defaults, Object.fromEntries(grouped));
};
