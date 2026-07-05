import type { ComponentProps } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, ChevronDown } from 'lucide-react';
import { Parameters } from '@taucad/react/parameters';
import type { Geometry } from '@taucad/types';
import { ModelViewer } from '#components/model-viewer.js';
import type { PlaygroundExample, PlaygroundPreset } from '#routes/playground/playground-examples.js';
import type { PlaygroundMobilePane } from '#routes/playground/playground-preview.js';
import { Button } from '#components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.js';
import { ClientOnly } from '#components/ui/utils/client-only.js';
import { cn } from '#utils/ui.utils.js';

export const playgroundPreviewCapabilities = {
  parameters: true,
} as const;

type PlaygroundPreviewPaneProps = {
  readonly activeExample: PlaygroundExample;
  readonly files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
  readonly pendingParameters: Record<string, unknown> | undefined;
  readonly previewProjectId: string;
  readonly previewRenderKey: string;
  readonly staticPreviewUrl: string | undefined;
  readonly mobilePane: PlaygroundMobilePane;
  readonly exportControlsElement: HTMLDivElement | undefined;
  readonly onParametersChange: (parameters: Record<string, unknown>) => void;
};

type ParameterSchema = NonNullable<ComponentProps<typeof Parameters>['jsonSchema']>;
type ParameterUnits = ComponentProps<typeof Parameters>['units'];
type ParseState = {
  readonly source: string;
  index: number;
};
type ParseResult = { readonly success: true; readonly value: unknown } | { readonly success: false };
type StaticParameterGroup = {
  readonly key: string;
  readonly title: string;
  readonly parameterKeys: readonly string[];
};
type StaticParameterView = {
  readonly defaultParameters: Record<string, unknown>;
  readonly jsonSchema: ParameterSchema;
  readonly presets: readonly PlaygroundPreset[];
  readonly toUiParameters: (parameters: Record<string, unknown>) => Record<string, unknown>;
  readonly toModelParameters: (parameters: Record<string, unknown>) => Record<string, unknown>;
};

const parameterUnits = {
  length: {
    symbol: 'mm',
    factor: 1,
  },
} as const satisfies ParameterUnits;

const descriptorTerms = new Set([
  'add',
  'angle',
  'angular',
  'axial',
  'bottom',
  'clearance',
  'count',
  'd',
  'deg',
  'depth',
  'diameter',
  'dimension',
  'direction',
  'enable',
  'external',
  'from',
  'height',
  'horizontal',
  'internal',
  'large',
  'len',
  'length',
  'major',
  'minor',
  'model',
  'num',
  'od',
  'offset',
  'pitch',
  'radius',
  'show',
  'side',
  'slop',
  'small',
  'start',
  'thick',
  'thickness',
  'tilt',
  'tip',
  'top',
  'total',
  'w',
  'width',
  'x',
  'y',
  'z',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const cloneParameterValue = (value: unknown): unknown => {
  if (isUnknownArray(value)) {
    return value.map((item) => cloneParameterValue(item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneParameterValue(item)]));
  }

  return value;
};

const assignParameterValues = (target: Record<string, unknown>, source: Record<string, unknown>): void => {
  for (const [key, value] of Object.entries(source)) {
    const currentValue = target[key];
    if (isRecord(currentValue) && isRecord(value)) {
      assignParameterValues(currentValue, value);
      continue;
    }

    target[key] = cloneParameterValue(value);
  }
};

const fillMissingDefaults = (target: Record<string, unknown>, source: Record<string, unknown>): void => {
  for (const [key, value] of Object.entries(source)) {
    const currentValue = target[key];
    if (currentValue === undefined) {
      target[key] = cloneParameterValue(value);
      continue;
    }

    if (isRecord(currentValue) && isRecord(value)) {
      fillMissingDefaults(currentValue, value);
    }
  }
};

const parseFailure = (): ParseResult => ({ success: false });

const parseSuccess = (value: unknown): ParseResult => ({ success: true, value });

const isIdentifierStart = (character: string): boolean => /[$A-Z_a-z]/u.test(character);

const isIdentifierPart = (character: string): boolean => /[$\w]/u.test(character);

const skipIgnored = (state: ParseState): void => {
  while (state.index < state.source.length) {
    const character = state.source[state.index];
    const nextCharacter = state.source[state.index + 1];
    if (character === undefined) {
      return;
    }

    if (/\s/u.test(character)) {
      state.index += 1;
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      const lineEnd = state.source.indexOf('\n', state.index + 2);
      state.index = lineEnd === -1 ? state.source.length : lineEnd + 1;
      continue;
    }

    if (character === '/' && nextCharacter === '*') {
      const commentEnd = state.source.indexOf('*/', state.index + 2);
      state.index = commentEnd === -1 ? state.source.length : commentEnd + 2;
      continue;
    }

    return;
  }
};

const readIdentifier = (state: ParseState): string | undefined => {
  const startCharacter = state.source[state.index];
  if (!startCharacter || !isIdentifierStart(startCharacter)) {
    return undefined;
  }

  const startIndex = state.index;
  state.index += 1;
  while (state.index < state.source.length) {
    const character = state.source[state.index];
    if (!character || !isIdentifierPart(character)) {
      break;
    }

    state.index += 1;
  }

  return state.source.slice(startIndex, state.index);
};

const readString = (state: ParseState): ParseResult => {
  const quote = state.source[state.index];
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    return parseFailure();
  }

  state.index += 1;
  let value = '';
  while (state.index < state.source.length) {
    const character = state.source[state.index];
    if (character === undefined) {
      return parseFailure();
    }

    if (character === quote) {
      state.index += 1;
      return parseSuccess(value);
    }

    if (character === '\\') {
      const escaped = state.source[state.index + 1];
      if (escaped === undefined) {
        return parseFailure();
      }

      value += escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped;
      state.index += 2;
      continue;
    }

    value += character;
    state.index += 1;
  }

  return parseFailure();
};

const readNumber = (state: ParseState): ParseResult => {
  const match = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/iu.exec(state.source.slice(state.index));
  if (!match?.[0]) {
    return parseFailure();
  }

  state.index += match[0].length;
  return parseSuccess(Number(match[0]));
};

const parseArrayLiteral = (state: ParseState): ParseResult => {
  if (state.source[state.index] !== '[') {
    return parseFailure();
  }

  state.index += 1;
  const value: unknown[] = [];
  while (state.index < state.source.length) {
    skipIgnored(state);
    if (state.source[state.index] === ']') {
      state.index += 1;
      return parseSuccess(value);
    }

    const item = parseValue(state);
    if (!item.success) {
      return parseFailure();
    }

    value.push(item.value);
    skipIgnored(state);
    if (state.source[state.index] === ',') {
      state.index += 1;
      continue;
    }

    if (state.source[state.index] === ']') {
      continue;
    }

    return parseFailure();
  }

  return parseFailure();
};

const parseObjectLiteral = (state: ParseState): ParseResult => {
  if (state.source[state.index] !== '{') {
    return parseFailure();
  }

  state.index += 1;
  const value: Record<string, unknown> = {};
  while (state.index < state.source.length) {
    skipIgnored(state);
    if (state.source[state.index] === '}') {
      state.index += 1;
      return parseSuccess(value);
    }

    const keyResult =
      state.source[state.index] === '"' || state.source[state.index] === "'"
        ? readString(state)
        : parseSuccess(readIdentifier(state));
    if (!keyResult.success || typeof keyResult.value !== 'string') {
      return parseFailure();
    }

    skipIgnored(state);
    if (state.source[state.index] !== ':') {
      return parseFailure();
    }

    state.index += 1;
    const item = parseValue(state);
    if (!item.success) {
      return parseFailure();
    }

    value[keyResult.value] = item.value;
    skipIgnored(state);
    if (state.source[state.index] === ',') {
      state.index += 1;
      continue;
    }

    if (state.source[state.index] === '}') {
      continue;
    }

    return parseFailure();
  }

  return parseFailure();
};

const parseValue = (state: ParseState): ParseResult => {
  skipIgnored(state);
  const character = state.source[state.index];
  if (character === '{') {
    return parseObjectLiteral(state);
  }

  if (character === '[') {
    return parseArrayLiteral(state);
  }

  if (character === '"' || character === "'" || character === '`') {
    return readString(state);
  }

  if (character === '-' || character === '.' || (character !== undefined && /\d/u.test(character))) {
    return readNumber(state);
  }

  const identifier = readIdentifier(state);
  switch (identifier) {
    case 'true': {
      return parseSuccess(true);
    }
    case 'false': {
      return parseSuccess(false);
    }
    case 'null': {
      return parseSuccess(null);
    }
    default: {
      return parseFailure();
    }
  }
};

const findDefaultParamsInitializer = (source: string): number | undefined => {
  const declarationPattern = /(?:^|[^\w$])(?:export\s+)?const\s+defaultParams\b/gu;
  for (const match of source.matchAll(declarationPattern)) {
    const startIndex = match.index + match[0].length;
    const equalsIndex = source.indexOf('=', startIndex);
    if (equalsIndex === -1) {
      continue;
    }

    const openIndex = source.indexOf('{', equalsIndex + 1);
    if (openIndex !== -1) {
      return openIndex;
    }
  }

  return undefined;
};

const extractDefaultParametersFromSource = (source: string): Record<string, unknown> | undefined => {
  const initializerIndex = findDefaultParamsInitializer(source);
  if (initializerIndex !== undefined) {
    const result = parseObjectLiteral({ source, index: initializerIndex });
    if (result.success && isRecord(result.value)) {
      return result.value;
    }
  }

  return extractOpenScadParametersFromSource(source);
};

const deriveDefaultParameters = (example: PlaygroundExample): Record<string, unknown> => {
  const sourceDefaults = extractDefaultParametersFromSource(example.code);
  const defaults = cloneParameterValue(sourceDefaults ?? {}) as Record<string, unknown>;
  assignParameterValues(defaults, example.initialParameters ?? {});
  for (const preset of example.presets ?? []) {
    fillMissingDefaults(defaults, preset.parameters);
  }

  return defaults;
};

const stripOpenScadLineComment = (line: string): string => {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];
    if (character === undefined) {
      break;
    }

    if (quote) {
      if (character === '\\') {
        index += 1;
        continue;
      }

      if (character === quote) {
        quote = undefined;
      }

      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      return line.slice(0, index);
    }
  }

  return line;
};

const readOpenScadDeclarationPrefix = (source: string): string => {
  const hiddenSectionIndex = source.search(/\/\*\s*\[Hidden\]\s*\*\//u);
  const moduleIndex = source.search(/^\s*(?:function|module)\s+[$\w]+\s*\(/mu);
  const endCandidates = [hiddenSectionIndex, moduleIndex].filter((index) => index >= 0);
  const endIndex = endCandidates.length > 0 ? Math.min(...endCandidates) : source.length;
  return source.slice(0, endIndex);
};

const parseStandaloneLiteral = (expression: string): unknown | undefined => {
  const state: ParseState = { source: expression.trim(), index: 0 };
  const result = parseValue(state);
  if (!result.success) {
    return undefined;
  }

  skipIgnored(state);
  return state.index === state.source.length ? result.value : undefined;
};

const extractOpenScadParametersFromSource = (source: string): Record<string, unknown> | undefined => {
  const parameters: Record<string, unknown> = {};
  for (const rawLine of readOpenScadDeclarationPrefix(source).split('\n')) {
    const line = stripOpenScadLineComment(rawLine).trim();
    const match = /^([A-Z_a-z]\w*)\s*=\s*(.+);$/u.exec(line);
    if (!match?.[1] || !match[2]) {
      continue;
    }

    const value = parseStandaloneLiteral(match[2]);
    if (value !== undefined) {
      parameters[match[1]] = value;
    }
  }

  return Object.keys(parameters).length > 0 ? parameters : undefined;
};

const readableTitle = (key: string): string =>
  key
    .replaceAll('_', ' ')
    .replaceAll(/([a-z])([A-Z])/gu, '$1 $2')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .replace(/^./u, (match) => match.toUpperCase());

const firstDefined = (values: readonly unknown[]): unknown => values.find((value) => value !== undefined);

const uniqueStrings = (values: readonly unknown[]): string[] => [
  ...new Set(values.filter((value): value is string => typeof value === 'string')),
];

const parameterTerms = (key: string): string[] =>
  key
    .replaceAll(/([\da-z])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/u)
    .filter((term) => term.length > 1);

const primaryParameterTerm = (key: string): string | undefined => {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey.includes('prechamber') || normalizedKey.includes('pre_chamber')) {
    return 'preChamber';
  }

  const terms = parameterTerms(key);
  for (const preferredTerm of ['thread', 'side', 'hole', 'nose', 'collar', 'hex'] as const) {
    if (terms.includes(preferredTerm)) {
      return preferredTerm;
    }
  }

  return terms.find((term) => !descriptorTerms.has(term)) ?? terms[0];
};

const groupFlatParameters = (parameters: Record<string, unknown>): readonly StaticParameterGroup[] | undefined => {
  if (Object.values(parameters).some((value) => isRecord(value))) {
    return undefined;
  }

  const entriesByGroup = new Map<string, string[]>();
  for (const key of Object.keys(parameters)) {
    const groupKey = primaryParameterTerm(key) ?? 'general';
    entriesByGroup.set(groupKey, [...(entriesByGroup.get(groupKey) ?? []), key]);
  }

  const groupedKeys = new Set(
    [...entriesByGroup.entries()].filter(([, keys]) => keys.length > 1).map(([groupKey]) => groupKey),
  );
  if (groupedKeys.size === 0) {
    return undefined;
  }

  const groups: StaticParameterGroup[] = [];
  const generalKeys: string[] = [];
  for (const [groupKey, keys] of entriesByGroup) {
    if (!groupedKeys.has(groupKey)) {
      generalKeys.push(...keys);
      continue;
    }

    groups.push({
      key: groupKey,
      title: readableTitle(groupKey),
      parameterKeys: keys,
    });
  }

  if (generalKeys.length > 0) {
    groups.unshift({
      key: 'general',
      title: 'General',
      parameterKeys: generalKeys,
    });
  }

  return groups;
};

const groupParameterRecord = (
  parameters: Record<string, unknown>,
  groups: readonly StaticParameterGroup[],
): Record<string, unknown> => {
  const grouped: Record<string, unknown> = {};
  for (const group of groups) {
    const values: Record<string, unknown> = {};
    for (const key of group.parameterKeys) {
      if (parameters[key] !== undefined) {
        values[key] = cloneParameterValue(parameters[key]);
      }
    }

    if (Object.keys(values).length > 0) {
      grouped[group.key] = values;
    }
  }

  return grouped;
};

const ungroupParameterRecord = (
  parameters: Record<string, unknown>,
  groups: readonly StaticParameterGroup[],
): Record<string, unknown> => {
  const flat: Record<string, unknown> = {};
  const groupKeys = new Set(groups.map((group) => group.key));
  for (const [key, value] of Object.entries(parameters)) {
    if (!groupKeys.has(key)) {
      flat[key] = cloneParameterValue(value);
    }
  }

  for (const group of groups) {
    const groupValue = parameters[group.key];
    if (!isRecord(groupValue)) {
      continue;
    }

    for (const key of group.parameterKeys) {
      if (groupValue[key] !== undefined) {
        flat[key] = cloneParameterValue(groupValue[key]);
      }
    }
  }

  return flat;
};

const inferArrayItemSchema = (values: readonly unknown[]): ParameterSchema => {
  const firstArray = values.find((value): value is readonly unknown[] => isUnknownArray(value));
  const itemValues = values.flatMap((value): unknown[] => (isUnknownArray(value) ? [...value] : []));
  const firstItem = firstDefined(itemValues);
  const itemSchema = inferSchemaForValue(firstItem, itemValues, 'Item');

  return {
    type: 'array',
    ...(firstArray ? { minItems: firstArray.length, maxItems: firstArray.length } : {}),
    items: itemSchema,
  } satisfies ParameterSchema;
};

const inferObjectSchema = (value: unknown, samples: readonly unknown[], title: string): ParameterSchema => {
  const objectSamples = [value, ...samples].filter((sample): sample is Record<string, unknown> => isRecord(sample));
  const keys = [...new Set(objectSamples.flatMap((sample) => Object.keys(sample)))].sort((left, right) =>
    left.localeCompare(right),
  );

  return {
    type: 'object',
    title,
    properties: Object.fromEntries(
      keys.map((key) => {
        const values = objectSamples.map((sample) => sample[key]);
        return [key, inferSchemaForValue(firstDefined(values), values, readableTitle(key))];
      }),
    ),
  } satisfies ParameterSchema;
};

const inferSchemaForValue = (value: unknown, samples: readonly unknown[], title: string): ParameterSchema => {
  if (Array.isArray(value)) {
    return inferArrayItemSchema([value, ...samples]);
  }

  if (isRecord(value)) {
    return inferObjectSchema(value, samples, title);
  }

  const sampleStrings = uniqueStrings([value, ...samples]);
  switch (typeof value) {
    case 'boolean': {
      return { type: 'boolean', title, default: value } satisfies ParameterSchema;
    }

    case 'number': {
      return { type: 'number', title, default: value } satisfies ParameterSchema;
    }

    case 'string': {
      return {
        type: 'string',
        title,
        default: value,
        ...(sampleStrings.length > 1 ? { enum: sampleStrings } : {}),
      } satisfies ParameterSchema;
    }

    default: {
      return { type: 'string', title } satisfies ParameterSchema;
    }
  }
};

const buildParameterSchema = (
  example: PlaygroundExample,
  defaultParameters: Record<string, unknown>,
  presets: readonly PlaygroundPreset[],
): ParameterSchema => {
  const keys = [
    ...new Set([
      ...Object.keys(defaultParameters),
      ...presets.flatMap((preset) => Object.keys(preset.parameters)),
    ]),
  ].sort((left, right) => left.localeCompare(right));

  return {
    type: 'object',
    title: `${example.name} Parameters`,
    properties: Object.fromEntries(
      keys.map((key) => {
        const values = [defaultParameters[key], ...presets.map((preset) => preset.parameters[key])];
        return [key, inferSchemaForValue(firstDefined(values), values, readableTitle(key))];
      }),
    ),
  } satisfies ParameterSchema;
};

const deriveStaticParameterView = (example: PlaygroundExample): StaticParameterView => {
  const modelDefaultParameters = deriveDefaultParameters(example);
  const groups = groupFlatParameters(modelDefaultParameters);
  if (!groups) {
    const presets = example.presets ?? [];
    return {
      defaultParameters: modelDefaultParameters,
      jsonSchema: buildParameterSchema(example, modelDefaultParameters, presets),
      presets,
      toUiParameters: (parameters) => cloneParameterValue(parameters) as Record<string, unknown>,
      toModelParameters: (parameters) => cloneParameterValue(parameters) as Record<string, unknown>,
    };
  }

  const defaultParameters = groupParameterRecord(modelDefaultParameters, groups);
  const presets = (example.presets ?? []).map((preset) => ({
    ...preset,
    parameters: groupParameterRecord(preset.parameters, groups),
  }));

  return {
    defaultParameters,
    jsonSchema: buildParameterSchema(example, defaultParameters, presets),
    presets,
    toUiParameters(parameters) {
      return groupParameterRecord(ungroupParameterRecord(parameters, groups), groups);
    },
    toModelParameters(parameters) {
      return ungroupParameterRecord(parameters, groups);
    },
  };
};

async function loadStaticPreviewGeometry(url: string, signal?: AbortSignal): Promise<Geometry> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load static preview GLB: ${response.status}`);
  }

  return {
    format: 'gltf',
    content: new Uint8Array(await response.arrayBuffer()),
    hash: `static-playground:${url}`,
  };
}

function StaticPlaygroundViewer({
  image,
  staticPreviewUrl,
}: {
  readonly image: string | undefined;
  readonly staticPreviewUrl: string | undefined;
}): React.JSX.Element {
  const [geometry, setGeometry] = useState<Geometry | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    if (!staticPreviewUrl) {
      setGeometry(undefined);
      setError(undefined);
      return;
    }

    const controller = new AbortController();
    setGeometry(undefined);
    setError(undefined);

    // oxlint-disable-next-line tau-lint/no-async-iife -- static preview fetch is the render source.
    void (async () => {
      try {
        setGeometry(await loadStaticPreviewGeometry(staticPreviewUrl, controller.signal));
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        setError(error instanceof Error ? error : new Error('Failed to load static preview'));
      }
    })();

    return () => {
      controller.abort();
    };
  }, [staticPreviewUrl]);

  if (staticPreviewUrl) {
    return (
      <ModelViewer
        className='size-full'
        enablePan
        enableZoom
        geometries={geometry ? [geometry] : []}
        error={error}
        stageOptions={{ zoomLevel: 1.25 }}
        graphicsOptions={{
          enableLines: true,
          viewerClassName: 'bg-muted/30',
        }}
      />
    );
  }

  if (image) {
    return <img src={image} alt='' loading='eager' decoding='async' className='size-full object-contain' />;
  }

  return (
    <div className='flex size-full items-center justify-center'>
      <Box className='size-12 text-muted-foreground/40' strokeWidth={1.25} aria-hidden />
    </div>
  );
}

export function PlaygroundPreviewPane({
  activeExample,
  staticPreviewUrl,
  pendingParameters,
  mobilePane,
  onParametersChange,
}: PlaygroundPreviewPaneProps): React.JSX.Element {
  return (
    <>
      <section
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col',
          activeExample.mode !== 'static' && mobilePane !== '3d' ? 'max-xl:hidden' : undefined,
        )}
      >
        <div className='relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/30'>
          <ClientOnly fallback={<StaticPlaygroundViewer image={activeExample.image} staticPreviewUrl={undefined} />}>
            <StaticPlaygroundViewer image={activeExample.image} staticPreviewUrl={staticPreviewUrl} />
          </ClientOnly>
        </div>
      </section>

      {activeExample.mode === 'static' ? null : (
        <section
          className={cn(
            'flex min-w-0 flex-col bg-background xl:min-h-0',
            mobilePane === 'params' ? 'max-xl:min-h-0 max-xl:flex-1 max-xl:overflow-y-auto' : 'max-xl:hidden',
          )}
        >
          <StaticPlaygroundParameters
            activeExample={activeExample}
            pendingParameters={pendingParameters}
            onParametersChange={onParametersChange}
          />
        </section>
      )}
    </>
  );
}

function StaticPlaygroundParameters({
  activeExample,
  pendingParameters,
  onParametersChange,
}: {
  readonly activeExample: PlaygroundExample;
  readonly pendingParameters: Record<string, unknown> | undefined;
  readonly onParametersChange: (parameters: Record<string, unknown>) => void;
}): React.JSX.Element {
  const parameterView = useMemo(() => deriveStaticParameterView(activeExample), [activeExample]);
  const [parameters, setParameters] = useState<Record<string, unknown>>({});

  useEffect(() => {
    const nextModelParameters = parameterView.toModelParameters(pendingParameters ?? {});
    setParameters(parameterView.toUiParameters(nextModelParameters));
    onParametersChange(nextModelParameters);
  }, [activeExample.id, onParametersChange, parameterView, pendingParameters]);

  const handleParametersChange = useCallback(
    (nextParameters: Record<string, unknown>) => {
      setParameters(nextParameters);
      onParametersChange(parameterView.toModelParameters(nextParameters));
    },
    [onParametersChange, parameterView],
  );

  const applyPreset = useCallback(
    (preset: PlaygroundPreset) => {
      handleParametersChange(preset.parameters);
    },
    [handleParametersChange],
  );

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='flex items-center justify-between border-b p-2'>
        <h3 className='text-sm font-semibold'>Parameters</h3>
        {parameterView.presets.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant='ghost' size='xs' className='gap-1'>
                Presets
                <ChevronDown className='size-3.5' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end'>
              {parameterView.presets.map((preset) => (
                <DropdownMenuItem
                  key={preset.name}
                  onSelect={() => {
                    applyPreset(preset);
                  }}
                >
                  {preset.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div className='flex-1 overflow-hidden'>
        <ClientOnly fallback={<div data-slot='parameters' className='h-full w-full' />}>
          <Parameters
            parameters={parameters}
            defaultParameters={parameterView.defaultParameters}
            jsonSchema={parameterView.jsonSchema}
            units={parameterUnits}
            emptyDescription='This model has no parameters'
            onParametersChange={handleParametersChange}
          />
        </ClientOnly>
      </div>
    </div>
  );
}
