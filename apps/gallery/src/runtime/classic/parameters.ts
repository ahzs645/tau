import type { JSONSchema7, JSONSchema7Definition } from '@taucad/json-schema';
import type { ClassicParameter, ClassicParameterExport } from '#runtime/classic/parameter-types.js';

const numericConstraints = (parameter: ClassicParameter): JSONSchema7 => ({
  ...(parameter.min === undefined ? {} : { minimum: parameter.min }),
  ...(parameter.max === undefined ? {} : { maximum: parameter.max }),
  ...(parameter.step === undefined ? {} : { multipleOf: parameter.step }),
});

const propertySchema = (parameter: ClassicParameter): JSONSchema7 => {
  const base: JSONSchema7 = {
    title: parameter.name,
    default: parameter.initial,
    ...(parameter.caption ? { description: parameter.caption } : {}),
  };
  if (Array.isArray(parameter.initial)) {
    return {
      ...base,
      type: 'array',
      items: { type: 'number', ...numericConstraints(parameter) },
      minItems: parameter.initial.length,
      maxItems: parameter.initial.length,
    };
  }
  if (parameter.type === 'boolean') {
    return { ...base, type: 'boolean' };
  }
  if (parameter.options?.length) {
    return {
      ...base,
      type: parameter.type,
      oneOf: parameter.options.map(({ name, value }) => ({ type: parameter.type, const: value, title: name })),
    };
  }
  return { ...base, type: parameter.type, ...(parameter.type === 'number' ? numericConstraints(parameter) : {}) };
};

/** Keep literal group names intact; no JSON-pointer encoding belongs in parameter object keys. */
export const classicParameterDeclaration = (
  exported: ClassicParameterExport,
): { defaultParameters: Record<string, unknown>; jsonSchema: JSONSchema7 } => {
  const properties: Record<string, JSONSchema7Definition> = {};
  const defaultParameters: Record<string, unknown> = {};
  const groups = new Map<
    string,
    { properties: Record<string, JSONSchema7Definition>; defaults: Record<string, unknown> }
  >();
  for (const parameter of exported.parameters) {
    if (parameter.name.startsWith('$') || parameter.group === 'Hidden') {
      continue;
    }
    const property = propertySchema(parameter);
    if (['', 'Global', 'Parameters'].includes(parameter.group.trim())) {
      properties[parameter.name] = property;
      defaultParameters[parameter.name] = parameter.initial;
    } else {
      let group = groups.get(parameter.group);
      if (!group) {
        group = { properties: {}, defaults: {} };
        groups.set(parameter.group, group);
      }
      group.properties[parameter.name] = property;
      group.defaults[parameter.name] = parameter.initial;
    }
  }
  for (const [name, group] of groups) {
    properties[name] = { type: 'object', title: name, properties: group.properties, additionalProperties: false };
    defaultParameters[name] = group.defaults;
  }
  return { defaultParameters, jsonSchema: { type: 'object', properties, additionalProperties: false } };
};

const scadLiteral = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry: unknown) => scadLiteral(entry)).join(',')}]`;
  }
  throw new TypeError('An OpenSCAD parameter must be a finite number, string, boolean, or vector.');
};

/** Arguments are passed directly to callMain; quoted strings are OpenSCAD literals, never shell fragments. */
export const classicParameterArguments = (parameters: Readonly<Record<string, unknown>>): string[] => {
  const flattened = new Map<string, unknown>();
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, child] of Object.entries(value)) {
        flattened.set(name, child);
      }
    } else {
      flattened.set(key, value);
    }
  }
  return [...flattened].map(([key, value]) => {
    if (!/^[$A-Z_a-z][$\w]*$/u.test(key)) {
      throw new TypeError(`Invalid OpenSCAD parameter name: ${key}`);
    }
    return `-D${key}=${scadLiteral(value)}`;
  });
};
