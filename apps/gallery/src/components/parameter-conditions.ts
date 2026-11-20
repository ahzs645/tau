import type { JSONSchema7 } from '@taucad/json-schema';
import { getDiscriminatedUnionInfo } from '@taucad/viewer/parameters/rjsf-utils';
import { resolveGalleryParameters } from '#runtime/parameters.js';
import { mergeParameterChanges } from '#components/parameter-values.js';

type ParameterRecord = Record<string, unknown>;
type ParameterChange = { readonly next: ParameterRecord; readonly base: ParameterRecord };
type ParameterDescription = {
  readonly defaultParameters: ParameterRecord;
  readonly jsonSchema: JSONSchema7 | undefined;
};

const isRecord = (value: unknown): value is ParameterRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const selectBranch = (schema: JSONSchema7, parameters: ParameterRecord): JSONSchema7 | undefined => {
  const union = getDiscriminatedUnionInfo(schema);
  if (!union) {
    return undefined;
  }
  const index = union.values.findIndex((value) => Object.is(value, parameters[union.discriminator]));
  return union.branches[index];
};

/** Keep inactive branch values in the model state, outside the rendered parameter form. */
export const projectConditionalParameters = (
  schema: JSONSchema7,
  parameters: ParameterRecord,
  selected: ParameterRecord,
): ParameterRecord => {
  const union = getDiscriminatedUnionInfo(schema);
  const branch = selectBranch(schema, selected);
  const properties = { ...schema.properties, ...branch?.properties };
  const conditionalKeys = new Set(union?.branches.flatMap((item) => Object.keys(item.properties ?? {})));
  return Object.fromEntries(
    Object.entries(parameters).flatMap(([key, value]) => {
      if (branch && conditionalKeys.has(key) && !Object.hasOwn(properties, key)) {
        return [];
      }
      const property = properties[key];
      const selectedValue = selected[key];
      const projected =
        typeof property === 'object' && isRecord(value) && isRecord(selectedValue)
          ? projectConditionalParameters(property, value, selectedValue)
          : value;
      return [[key, projected]];
    }),
  );
};

const fieldsToRetain = (schema: JSONSchema7, base: ParameterRecord, next: ParameterRecord): ReadonlySet<string> => {
  const union = getDiscriminatedUnionInfo(schema);
  if (!union || Object.is(base[union.discriminator], next[union.discriminator])) {
    return new Set();
  }
  const oldBranch = selectBranch(schema, base);
  const newBranch = selectBranch(schema, next);
  if (!oldBranch || !newBranch) {
    return new Set();
  }
  const keys = union.branches.flatMap((branch) => Object.keys(branch.properties ?? {}));
  return new Set(
    keys.filter(
      (key) =>
        key !== union.discriminator &&
        !Object.hasOwn(schema.properties ?? {}, key) &&
        (!Object.hasOwn(oldBranch.properties ?? {}, key) || !Object.hasOwn(newBranch.properties ?? {}, key)),
    ),
  );
};

const restoreConditionalParameters = (
  schema: JSONSchema7,
  {
    current,
    base,
    next,
    merged,
  }: ParameterChange & { readonly current: ParameterRecord; readonly merged: ParameterRecord },
): ParameterRecord => {
  const result = new Map(Object.entries(merged));
  for (const key of fieldsToRetain(schema, base, next)) {
    if (Object.hasOwn(current, key)) {
      result.set(key, current[key]);
    }
  }
  const properties = { ...schema.properties, ...selectBranch(schema, next)?.properties };
  for (const [key, property] of Object.entries(properties)) {
    const currentValue = current[key];
    const mergedValue = result.get(key);
    if (typeof property !== 'object' || !isRecord(currentValue)) {
      continue;
    }
    const baseValue = base[key];
    const nextValue = next[key];
    const restored = restoreConditionalParameters(property, {
      current: currentValue,
      base: isRecord(baseValue) ? baseValue : {},
      next: isRecord(nextValue) ? nextValue : {},
      merged: isRecord(mergedValue) ? mergedValue : {},
    });
    if (isRecord(mergedValue) || Object.keys(restored).length > 0) {
      result.set(key, restored);
    }
  }
  return Object.fromEntries(result);
};

/** RJSF clears branch-only fields during a switch; remember those values without intercepting an ordinary reset. */
export const mergeGalleryParameterChanges = (
  description: ParameterDescription,
  current: ParameterRecord,
  change: ParameterChange,
): ParameterRecord => {
  const merged = mergeParameterChanges(current, change);
  return description.jsonSchema
    ? restoreConditionalParameters(description.jsonSchema, {
        current,
        base: resolveGalleryParameters(description.defaultParameters, change.base),
        next: resolveGalleryParameters(description.defaultParameters, change.next),
        merged,
      })
    : merged;
};
