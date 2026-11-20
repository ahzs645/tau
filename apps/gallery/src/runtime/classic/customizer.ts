import type { ClassicParameter, ClassicParameterExport, ClassicValue } from '#runtime/classic/parameter-types.js';
import { parseCustomizerValue } from '#runtime/classic/expression.js';

const groupPattern = /^\/\*\s*\[([^\]]+)\]\s*\*\/$/u;
const assignmentPattern = /^([$A-Z_a-z][$\w]*)\s*=\s*(.+?)\s*;\s*(?:(?:\/\/|#)\s*(.*))?$/u;
const optionPattern = /\[([^\]]+)\]/u;

type CustomizerLine =
  | { kind: 'assignment'; name: string; value: string; comment: string | undefined }
  | { kind: 'group' | 'caption'; value: string }
  | { kind: 'block' | 'skip' | 'stop' | 'unsupported' };

const classifyLine = (line: string): CustomizerLine => {
  const group = groupPattern.exec(line)?.[1];
  if (group) {
    return { kind: 'group', value: group.trim() };
  }
  if (line.startsWith('/*')) {
    return { kind: line.includes('*/') ? 'skip' : 'block' };
  }
  const assignment = assignmentPattern.exec(line);
  if (assignment?.[1] && assignment[2]) {
    return { kind: 'assignment', name: assignment[1], value: assignment[2], comment: assignment[3] };
  }
  if (/^[$A-Z_a-z][$\w]*\s*=/u.test(line)) {
    return { kind: 'unsupported' };
  }
  if (line === '' || /^(?:use|include)\s*[<"]/u.test(line)) {
    return { kind: 'skip' };
  }
  const caption = /^(?:\/\/+|#)\s*(.*)$/u.exec(line)?.[1];
  if (caption !== undefined) {
    return caption && !optionPattern.test(caption) ? { kind: 'caption', value: caption } : { kind: 'skip' };
  }
  return { kind: 'stop' };
};

const optionValue = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
};

const optionEntry = (
  entry: string,
  type: ClassicParameter['type'],
): { name: string; value: string | number } | undefined => {
  const separator = entry.indexOf(':');
  const raw = (separator === -1 ? entry : entry.slice(0, separator)).trim();
  if (raw === '') {
    return undefined;
  }
  const value = type === 'number' ? Number(raw) : optionValue(raw);
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return undefined;
  }
  const name = separator === -1 ? optionValue(raw) : entry.slice(separator + 1).trim();
  return { name, value };
};

const parseOptions = (
  specification: string,
  type: ClassicParameter['type'],
): Partial<Pick<ClassicParameter, 'min' | 'max' | 'step' | 'options'>> | undefined => {
  if (type === 'boolean') {
    return specification.split(',').every((value) => ['true', 'false'].includes(value.trim())) ? {} : undefined;
  }
  if (type === 'number' && specification.includes(':') && !specification.includes(',')) {
    const parts = specification.split(':').map((part) => Number(part.trim()));
    if (!parts.every((part) => Number.isFinite(part))) {
      return undefined;
    }
    if (parts.length === 2) {
      return { min: parts[0], max: parts[1], step: 1 };
    }
    return parts.length === 3 ? { min: parts[0], step: parts[1], max: parts[2] } : undefined;
  }
  if (!specification.includes(',')) {
    return undefined;
  }
  const options = specification.split(',').map((entry) => optionEntry(entry, type));
  return options.every((option) => option !== undefined) ? { options } : undefined;
};

const createParameter = (
  line: Extract<CustomizerLine, { kind: 'assignment' }>,
  state: { group: string; caption: string | undefined; environment: Readonly<Record<string, ClassicValue>> },
): ClassicParameter | undefined => {
  const { group, caption, environment } = state;
  const initial = parseCustomizerValue(line.value, environment);
  if (initial === undefined) {
    return undefined;
  }
  const type = typeof initial === 'boolean' ? 'boolean' : typeof initial === 'string' ? 'string' : 'number';
  const specification = optionPattern.exec(line.comment ?? '')?.[1];
  const options = specification === undefined ? {} : parseOptions(specification, type);
  if (!options) {
    return undefined;
  }
  const inlineCaption = line.comment?.replace(optionPattern, '').trim();
  const description = (group !== 'Parameters' || specification ? caption : undefined) ?? inlineCaption;
  return { group, initial, name: line.name, type, ...(description ? { caption: description } : {}), ...options };
};

/** Port of the fork's Customizer fast path. Unsupported syntax uses the native parameter exporter. */
export const parseClassicCustomizer = (source: string, title: string): ClassicParameterExport | undefined => {
  const parameters: ClassicParameter[] = [];
  const environment: Record<string, ClassicValue> = {};
  let group = 'Parameters';
  let caption: string | undefined;
  let block = false;
  for (const raw of source.split(/\r?\n/u)) {
    const line = raw.trim();
    if (block) {
      block = !line.includes('*/');
      continue;
    }
    const classified = classifyLine(line);
    if (classified.kind === 'stop') {
      break;
    }
    if (classified.kind === 'unsupported') {
      return undefined;
    }
    if (classified.kind === 'assignment') {
      const parameter = createParameter(classified, { group, caption, environment });
      if (!parameter) {
        return undefined;
      }
      parameters.push(parameter);
      environment[parameter.name] = parameter.initial;
    } else if (classified.kind === 'group') {
      group = classified.value;
    }
    block = classified.kind === 'block';
    caption = classified.kind === 'caption' ? classified.value : undefined;
  }
  return parameters.length > 0 ? { parameters, title } : undefined;
};
