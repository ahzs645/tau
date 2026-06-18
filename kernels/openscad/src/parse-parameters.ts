/**
 * API extracted from OpenSCAD User Manual
 * @see https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/Customizer
 */
import type { JSONSchema7, JSONSchema7Definition } from '@taucad/json-schema';

/**
 * Name/value pair for a dropdown or select option in an OpenSCAD customizer parameter.
 */
export type ParameterOption = {
  name: string;
  value: number | string;
};

/**
 * Base fields shared by all OpenSCAD customizer parameter types (caption, group, name).
 */
export type BaseParameter = {
  caption?: string;
  group: string;
  name: string;
};

/**
 * Number-type customizer parameter with optional min, max, step, and dropdown options.
 */
export type NumberParameter = BaseParameter & {
  type: 'number';
  initial: number;
  min?: number;
  max?: number;
  step?: number;
  options?: ParameterOption[];
};

/**
 * String-type customizer parameter with optional dropdown options.
 */
export type StringParameter = BaseParameter & {
  type: 'string';
  initial: string;
  options?: ParameterOption[];
};

/**
 * Customizer parameter that renders as a checkbox in the OpenSCAD parameter editor.
 */
export type BooleanParameter = BaseParameter & {
  type: 'boolean';
  initial: boolean;
};

/**
 * Parameter type for numeric arrays (e.g. [x, y, z]) in the OpenSCAD customizer.
 */
export type VectorParameter = BaseParameter & {
  type: 'number';
  initial: number[];
  min?: number;
  max?: number;
  step?: number;
};

/**
 * Any OpenSCAD customizer parameter, used to build the JSON schema for the parameter editor.
 */
export type Parameter = NumberParameter | StringParameter | BooleanParameter | VectorParameter;

/**
 * Container for a set of parameters with a title, used for grouping in the customizer UI.
 */
export type ParameterSet = {
  parameters: Parameter[];
  title: string;
};

/**
 * Raw parameter shape from OpenSCAD's JSON customizer export format.
 */
export type OpenScadParameter = {
  group: string;
  initial: string | number | boolean | number[];
  name: string;
  type: 'string' | 'number' | 'boolean';
  caption?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ name: string; value: string | number }>;
};

/**
 * Root object from OpenSCAD's JSON customizer export, containing parameters array and title.
 */
export type OpenScadParameterExport = {
  parameters: OpenScadParameter[];
  title: string;
};

const customizerGroupRegex = /^\s*\/\*\s*\[([^\]]+)\]\s*\*\/\s*$/u;
const simpleAssignmentRegex = /^\s*([$A-Z_a-z][$\w]*)\s*=\s*(.+?)\s*;\s*(?:(?:\/\/|#)\s*(.*))?$/u;
const startsNonCustomizerDefinitionRegex = /^\s*(?:module|function|if|for|intersection|union|difference)\s*[\w(]/u;
const optionSpecRegex = /\[([^\]]+)\]/u;
const numericLiteralRegex = /^-?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?$/iu;

/**
 * Parse OpenSCAD Customizer comments directly from source text.
 *
 * This intentionally handles the common, cheap path: top-level assignments with literal defaults
 * and OpenSCAD's standard `// [...]` option/range annotations. Complex expressions and generated
 * parameter data still fall back to OpenSCAD's `--export-format=param` path.
 *
 * @param source - OpenSCAD source text
 * @param title - title to attach to the exported parameter set
 * @returns parsed parameter export, or `undefined` when no parameters were confidently parsed
 */
// oxlint-disable-next-line complexity -- line scanner keeps customizer confidence rules together
export function parseOpenScadCustomizerParameters(
  source: string,
  title = 'main.scad',
): OpenScadParameterExport | undefined {
  const parameters: OpenScadParameter[] = [];
  const environment: Record<string, SimpleValue> = {};
  let currentGroup = 'Parameters';
  let inBlockComment = false;
  let pendingCaption: string | undefined;

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (inBlockComment) {
      inBlockComment = !line.includes('*/');
      continue;
    }

    if (line === '') {
      pendingCaption = undefined;
      continue;
    }

    const groupMatch = customizerGroupRegex.exec(line);
    if (groupMatch?.[1]) {
      currentGroup = groupMatch[1].trim();
      pendingCaption = undefined;
      continue;
    }

    if (line.startsWith('/*')) {
      inBlockComment = !line.includes('*/');
      pendingCaption = undefined;
      continue;
    }

    if (startsNonCustomizerDefinitionRegex.test(line)) {
      break;
    }

    if (/^\s*(?:use|include)\s*[<"]/u.test(line)) {
      pendingCaption = undefined;
      continue;
    }

    const assignment = simpleAssignmentRegex.exec(rawLine);
    if (assignment?.[1] && assignment[2]) {
      const hasOptionSpec = optionSpecRegex.test(assignment[3] ?? '');
      const canUsePendingCaption = currentGroup !== 'Parameters' || hasOptionSpec;
      const customizerCaption = canUsePendingCaption ? pendingCaption : undefined;
      const parsed = parseCustomizerAssignment({
        name: assignment[1],
        rawValue: assignment[2],
        rawComment: assignment[3],
        group: currentGroup,
        pendingCaption: customizerCaption,
        environment,
      });

      pendingCaption = undefined;
      if (!parsed) {
        return undefined;
      }

      environment[parsed.name] = parsed.initial;
      parameters.push(parsed);
      continue;
    }

    const commentCaption = parseCaptionComment(line);
    if (commentCaption === undefined) {
      if (/^\s*[$A-Z_a-z][$\w]*\s*=/u.test(line)) {
        return undefined;
      }

      if (!line.startsWith('//') && !line.startsWith('#') && !line.startsWith('/*')) {
        break;
      }
    }

    pendingCaption = commentCaption;
  }

  if (parameters.length === 0) {
    return undefined;
  }

  return { parameters, title };
}

/**
 * Converts an OpenSCAD parameter export to a grouped JSON Schema for the customizer UI.
 *
 * @param exportData - The raw parameter export from OpenSCAD's `--export-format=param` output
 * @returns A JSON Schema (draft-07) with parameters organized by group
 *
 * @see https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/Customizer
 */
export function processOpenScadParameters(exportData: OpenScadParameterExport): JSONSchema7 {
  const properties: Record<string, JSONSchema7Definition> = {};
  const groups: Record<string, Record<string, JSONSchema7Definition>> = {};

  // Process each parameter
  for (const parameter of exportData.parameters) {
    // Skip internal OpenSCAD parameters
    if (parameter.name.startsWith('$')) {
      continue;
    }

    const schemaProperty = createSchemaProperty(parameter);

    // Handle grouping - only group if there's an explicit non-default group
    if (
      parameter.group &&
      parameter.group !== 'Global' &&
      parameter.group !== '' &&
      parameter.group !== 'Parameters' &&
      parameter.group.trim() !== ''
    ) {
      // Group parameters under their group name
      groups[parameter.group] ??= {};
      groups[parameter.group]![parameter.name] = schemaProperty;
    } else {
      // Global or ungrouped parameters go to root level
      properties[parameter.name] = schemaProperty;
    }
  }

  // Add grouped properties as nested objects
  for (const [groupName, groupProperties] of Object.entries(groups)) {
    // Skip Hidden group as it shouldn't be exposed in UI
    if (groupName === 'Hidden') {
      continue;
    }

    properties[groupName] = {
      type: 'object',
      properties: groupProperties,
      title: groupName,
      additionalProperties: false,
    };
  }

  const jsonSchema: JSONSchema7 = {
    type: 'object',
    properties,
    additionalProperties: false,
  };

  return jsonSchema;
}

/**
 * Create a JSON schema property from an OpenSCAD parameter
 *
 * @param parameter - the parsed OpenSCAD parameter definition
 * @returns the corresponding JSON Schema property
 */
function createSchemaProperty(parameter: OpenScadParameter): JSONSchema7 {
  const baseProperty: JSONSchema7 = {
    title: parameter.name,
    default: parameter.initial as JSONSchema7['default'],
    ...(parameter.caption && { description: parameter.caption }),
  };

  switch (parameter.type) {
    case 'boolean': {
      return {
        ...baseProperty,
        type: 'boolean',
      };
    }

    case 'string': {
      if (parameter.options && parameter.options.length > 0) {
        // Use oneOf for labeled options to display custom names properly
        return {
          ...baseProperty,
          type: 'string',
          oneOf: parameter.options.map((opt) => ({
            const: opt.value,
            title: opt.name,
          })),
        };
      }

      return {
        ...baseProperty,
        type: 'string',
      };
    }

    case 'number': {
      // Check if this is actually a vector (array initial value)
      if (Array.isArray(parameter.initial)) {
        return {
          ...baseProperty,
          type: 'array',
          items: {
            type: 'number',
            ...(parameter.min !== undefined && { minimum: parameter.min }),
            ...(parameter.max !== undefined && { maximum: parameter.max }),
            ...(parameter.step !== undefined && { multipleOf: parameter.step }),
          },
          minItems: parameter.initial.length,
          maxItems: parameter.initial.length,
          default: parameter.initial,
        };
      }

      if (parameter.options && parameter.options.length > 0) {
        // Use oneOf for labeled options to display custom names properly
        return {
          ...baseProperty,
          type: 'number',
          oneOf: parameter.options.map((opt) => ({
            const: opt.value,
            title: opt.name,
          })),
        };
      }

      return {
        ...baseProperty,
        type: 'number',
        ...(parameter.min !== undefined && { minimum: parameter.min }),
        ...(parameter.max !== undefined && { maximum: parameter.max }),
        ...(parameter.step !== undefined && { multipleOf: parameter.step }),
      };
    }
  }
}

/**
 * Flattens grouped parameter objects back to flat key-value pairs for OpenSCAD `-D` injection.
 *
 * @param parameters - The parameter values, possibly nested under group keys
 * @returns A flat record mapping parameter names to their values
 */
export function flattenParametersForInjection(parameters: Record<string, unknown>): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(parameters)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // This is likely a group object, flatten its properties
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        flattened[subKey] = subValue;
      }
    } else {
      // Regular parameter
      flattened[key] = value;
    }
  }

  return flattened;
}

function parseCustomizerAssignment({
  name,
  rawValue,
  rawComment,
  group,
  pendingCaption,
  environment,
}: {
  name: string;
  rawValue: string;
  rawComment: string | undefined;
  group: string;
  pendingCaption: string | undefined;
  environment: Readonly<Record<string, SimpleValue>>;
}): OpenScadParameter | undefined {
  const initial = parseSimpleExpression(rawValue, environment);
  if (initial === undefined) {
    return undefined;
  }

  const parameter: OpenScadParameter = {
    group,
    initial,
    name,
    type: getParameterType(initial),
  };

  const caption = pendingCaption ?? parseInlineCaption(rawComment);
  if (caption) {
    parameter.caption = caption;
  }

  const optionSpec = rawComment ? parseOptionSpec(rawComment, parameter.type) : undefined;
  if (rawComment && optionSpecRegex.test(rawComment) && !optionSpec) {
    return undefined;
  }

  if (optionSpec) {
    Object.assign(parameter, optionSpec);
  }

  return parameter;
}

type SimpleValue = string | number | boolean | number[];

function getParameterType(value: SimpleValue): OpenScadParameter['type'] {
  if (Array.isArray(value) || typeof value === 'number') {
    return 'number';
  }

  return typeof value === 'boolean' ? 'boolean' : 'string';
}

class SimpleExpressionParser {
  private index = 0;

  /* oxlint-disable @typescript-eslint/parameter-properties -- erasableSyntaxOnly forbids parameter properties */
  private readonly environment: Readonly<Record<string, SimpleValue>>;

  private readonly source: string;
  /* oxlint-enable @typescript-eslint/parameter-properties -- re-enable after constructor fields */

  public constructor(source: string, environment: Readonly<Record<string, SimpleValue>>) {
    this.source = source;
    this.environment = environment;
  }

  public parse(): SimpleValue | undefined {
    const value = this.parseExpression();
    this.skipWhitespace();
    return value !== undefined && this.index === this.source.length ? value : undefined;
  }

  private parseExpression(): SimpleValue | undefined {
    let left = this.parseTerm();
    if (left === undefined) {
      return undefined;
    }

    while (this.index < this.source.length) {
      this.skipWhitespace();
      const operator = this.peek();
      if (operator !== '+' && operator !== '-') {
        return left;
      }

      this.index += 1;
      const right = this.parseTerm();
      if (typeof left !== 'number' || typeof right !== 'number') {
        return undefined;
      }

      left = operator === '+' ? left + right : left - right;
    }

    return left;
  }

  private parseTerm(): SimpleValue | undefined {
    let left = this.parseFactor();
    if (left === undefined) {
      return undefined;
    }

    while (this.index < this.source.length) {
      this.skipWhitespace();
      const operator = this.peek();
      if (operator !== '*' && operator !== '/') {
        return left;
      }

      this.index += 1;
      const right = this.parseFactor();
      if (typeof left !== 'number' || typeof right !== 'number') {
        return undefined;
      }

      left = operator === '*' ? left * right : left / right;
    }

    return left;
  }

  private parseFactor(): SimpleValue | undefined {
    this.skipWhitespace();
    const char = this.peek();

    if (char === '+' || char === '-') {
      this.index += 1;
      const value = this.parseFactor();
      if (typeof value !== 'number') {
        return undefined;
      }

      return char === '-' ? -value : value;
    }

    if (char === '(') {
      this.index += 1;
      const value = this.parseExpression();
      this.skipWhitespace();
      if (this.peek() !== ')') {
        return undefined;
      }

      this.index += 1;
      return value;
    }

    if (char === '[') {
      return this.parseArray();
    }

    if (char === '"') {
      return this.parseString();
    }

    return this.parseAtom();
  }

  private parseArray(): number[] | undefined {
    this.index += 1;
    const values: number[] = [];

    while (this.index < this.source.length) {
      this.skipWhitespace();
      if (this.peek() === ']') {
        this.index += 1;
        return values.length > 0 ? values : undefined;
      }

      const value = this.parseExpression();
      if (typeof value !== 'number') {
        return undefined;
      }

      values.push(value);
      this.skipWhitespace();

      const separator = this.peek();
      if (separator === ',') {
        this.index += 1;
        continue;
      }

      if (separator === ']') {
        this.index += 1;
        return values;
      }

      return undefined;
    }

    return undefined;
  }

  private parseString(): string | undefined {
    this.index += 1;
    let value = '';

    while (this.index < this.source.length) {
      const char = this.source[this.index];
      this.index += 1;

      if (char === '"') {
        return value;
      }

      if (char === '\\') {
        const escaped = this.source[this.index];
        if (escaped === undefined) {
          return undefined;
        }

        this.index += 1;
        value += escaped;
        continue;
      }

      value += char;
    }

    return undefined;
  }

  private parseAtom(): SimpleValue | undefined {
    const match = /[$_a-z][\w$]*|-?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?/iy.exec(this.source.slice(this.index));
    const token = match?.[0];
    if (!token) {
      return undefined;
    }

    this.index += token.length;
    if (token === 'true') {
      return true;
    }

    if (token === 'false') {
      return false;
    }

    if (numericLiteralRegex.test(token)) {
      return Number(token);
    }

    return this.environment[token];
  }

  private peek(): string | undefined {
    return this.source[this.index];
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.source[this.index] ?? '')) {
      this.index += 1;
    }
  }
}

function parseSimpleExpression(
  rawValue: string,
  environment: Readonly<Record<string, SimpleValue>>,
): SimpleValue | undefined {
  return new SimpleExpressionParser(rawValue.trim(), environment).parse();
}

function parseCaptionComment(line: string): string | undefined {
  const commentMatch = /^(?:(?:\/\/+)|#)\s*(.+)$/u.exec(line);
  if (!commentMatch?.[1]) {
    return undefined;
  }

  const caption = commentMatch[1].trim();
  if (optionSpecRegex.test(caption)) {
    return undefined;
  }

  return caption || undefined;
}

function parseInlineCaption(rawComment: string | undefined): string | undefined {
  if (!rawComment) {
    return undefined;
  }

  const withoutSpec = rawComment.replace(optionSpecRegex, '').replace(/^\/+/u, '').trim();
  return withoutSpec || undefined;
}

function parseOptionSpec(
  rawComment: string,
  parameterType: OpenScadParameter['type'],
): Partial<Pick<OpenScadParameter, 'min' | 'max' | 'step' | 'options'>> | undefined {
  const match = optionSpecRegex.exec(rawComment);
  const spec = match?.[1]?.trim();
  if (!spec) {
    return undefined;
  }

  if (parameterType === 'number' && spec.includes(':') && !spec.includes(',')) {
    const parts = spec.split(':').map((part) => Number(part.trim()));
    if (parts.length === 2 && parts.every((part) => Number.isFinite(part))) {
      return { min: parts[0], max: parts[1], step: 1 };
    }

    if (parts.length === 3 && parts.every((part) => Number.isFinite(part))) {
      return { min: parts[0], step: parts[1], max: parts[2] };
    }

    return undefined;
  }

  if (!spec.includes(',')) {
    return undefined;
  }

  if (parameterType === 'boolean') {
    return {};
  }

  const parsedOptions = spec.split(',').map((entry) => parseOptionEntry(entry, parameterType));
  if (parsedOptions.some((entry) => entry === undefined)) {
    return undefined;
  }

  const options = parsedOptions as ParameterOption[];
  return options.length > 0 ? { options } : undefined;
}

function parseOptionEntry(entry: string, parameterType: OpenScadParameter['type']): ParameterOption | undefined {
  const trimmed = entry.trim();
  if (!trimmed) {
    return undefined;
  }

  const [rawValue, rawName] = splitOptionEntry(trimmed);
  const value = parameterType === 'number' ? Number(rawValue) : unquoteOptionValue(rawValue);
  if (parameterType === 'number' && !Number.isFinite(value)) {
    return undefined;
  }

  return {
    name: rawName ?? unquoteOptionValue(rawValue),
    value,
  };
}

function splitOptionEntry(entry: string): [value: string, name?: string] {
  const separatorIndex = entry.indexOf(':');
  if (separatorIndex === -1) {
    return [entry.trim()];
  }

  return [entry.slice(0, separatorIndex).trim(), entry.slice(separatorIndex + 1).trim()];
}

function unquoteOptionValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}
