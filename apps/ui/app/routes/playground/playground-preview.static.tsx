import type { ComponentProps } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, ChevronDown } from 'lucide-react';
import { Parameters } from '@taucad/react/parameters';
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

const parameterUnits = {
  length: {
    symbol: 'mm',
    factor: 1,
  },
} as const satisfies ParameterUnits;

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
  if (initializerIndex === undefined) {
    return undefined;
  }

  const result = parseObjectLiteral({ source, index: initializerIndex });
  return result.success && isRecord(result.value) ? result.value : undefined;
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
): ParameterSchema => {
  const presets = example.presets ?? [];
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

export function PlaygroundPreviewPane({
  activeExample,
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
          {activeExample.image ? (
            <img
              src={activeExample.image}
              alt=''
              loading='eager'
              decoding='async'
              className='size-full object-contain'
            />
          ) : (
            <div className='flex size-full items-center justify-center'>
              <Box className='size-12 text-muted-foreground/40' strokeWidth={1.25} aria-hidden />
            </div>
          )}
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
  const defaultParameters = useMemo(() => deriveDefaultParameters(activeExample), [activeExample]);
  const jsonSchema = useMemo(
    () => buildParameterSchema(activeExample, defaultParameters),
    [activeExample, defaultParameters],
  );
  const [parameters, setParameters] = useState<Record<string, unknown>>({});

  useEffect(() => {
    const nextParameters = pendingParameters ?? {};
    setParameters(nextParameters);
    onParametersChange(nextParameters);
  }, [activeExample.id, onParametersChange, pendingParameters]);

  const handleParametersChange = useCallback(
    (nextParameters: Record<string, unknown>) => {
      setParameters(nextParameters);
      onParametersChange(nextParameters);
    },
    [onParametersChange],
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
        {activeExample.presets && activeExample.presets.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant='ghost' size='xs' className='gap-1'>
                Presets
                <ChevronDown className='size-3.5' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end'>
              {activeExample.presets.map((preset) => (
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
            defaultParameters={defaultParameters}
            jsonSchema={jsonSchema}
            units={parameterUnits}
            emptyDescription='This model has no parameters'
            onParametersChange={handleParametersChange}
          />
        </ClientOnly>
      </div>
    </div>
  );
}
