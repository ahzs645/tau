import type { JSONSchema7 } from '@taucad/json-schema';
import { resolveGalleryParameters } from '#runtime/parameters.js';
import { projectConditionalParameters } from '#components/parameter-conditions.js';

type ParameterPath = readonly [string] | readonly [string, string];
type ParameterRecord = Record<string, unknown>;
type ParameterDescription = {
  readonly defaultParameters: ParameterRecord;
  readonly jsonSchema: JSONSchema7 | undefined;
};

export type ParameterPresentation = {
  readonly parameters: ParameterRecord;
  readonly defaultParameters: ParameterRecord;
  readonly jsonSchema: JSONSchema7 | undefined;
  readonly componentValue?: unknown;
};

const isRecord = (value: unknown): value is ParameterRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const omitKey = <Value>(record: Readonly<Record<string, Value>>, key: string): Record<string, Value> =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

const parameterPath = (parameters: ParameterRecord, name: string): ParameterPath | undefined => {
  if (Object.hasOwn(parameters, name)) {
    return [name];
  }
  const groups = Object.entries(parameters).filter(([, fields]) => isRecord(fields) && Object.hasOwn(fields, name));
  const group = groups.length === 1 ? groups[0] : undefined;
  return group ? [group[0], name] : undefined;
};

const withoutParameter = (parameters: ParameterRecord, path: ParameterPath): ParameterRecord => {
  if (path.length === 1) {
    return omitKey(parameters, path[0]);
  }
  const fields = parameters[path[0]];
  if (!isRecord(fields)) {
    return parameters;
  }
  const remaining = omitKey(fields, path[1]);
  return Object.keys(remaining).length === 0 ? omitKey(parameters, path[0]) : { ...parameters, [path[0]]: remaining };
};

const withoutSchemaProperty = (schema: JSONSchema7, name: string): JSONSchema7 => ({
  ...schema,
  properties: omitKey(schema.properties ?? {}, name),
  required: schema.required?.filter((key) => key !== name),
});

const withoutParameterSchema = (schema: JSONSchema7, path: ParameterPath): JSONSchema7 => {
  if (path.length === 1) {
    return withoutSchemaProperty(schema, path[0]);
  }
  const group = schema.properties?.[path[0]];
  if (typeof group !== 'object') {
    return schema;
  }
  const remaining = withoutSchemaProperty(group, path[1]);
  return Object.keys(remaining.properties ?? {}).length === 0
    ? withoutSchemaProperty(schema, path[0])
    : { ...schema, properties: { ...schema.properties, [path[0]]: remaining } };
};

/** Normalize legacy flat links for the public form, leaving a dedicated component control outside its schema. */
export const projectGalleryParameters = (
  description: ParameterDescription,
  overrides: ParameterRecord,
  componentParameter?: string,
): ParameterPresentation => {
  const effective = resolveGalleryParameters(description.defaultParameters, overrides);
  const parameters = description.jsonSchema
    ? projectConditionalParameters(description.jsonSchema, effective, effective)
    : effective;
  const defaultParameters = description.jsonSchema
    ? projectConditionalParameters(description.jsonSchema, description.defaultParameters, effective)
    : description.defaultParameters;
  const path = componentParameter ? parameterPath(description.defaultParameters, componentParameter) : undefined;
  if (!path) {
    return { ...description, defaultParameters, parameters };
  }
  const parent = parameters[path[0]];
  const componentValue = path.length === 1 ? parent : isRecord(parent) ? parent[path[1]] : undefined;
  return {
    parameters: withoutParameter(parameters, path),
    defaultParameters: withoutParameter(defaultParameters, path),
    jsonSchema: description.jsonSchema ? withoutParameterSchema(description.jsonSchema, path) : undefined,
    componentValue,
  };
};
