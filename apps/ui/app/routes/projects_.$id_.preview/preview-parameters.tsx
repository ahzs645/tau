import type { ComponentProps } from 'react';
import { useState, useCallback, useMemo } from 'react';
import { useSelector } from '@xstate/react';
import { RefreshCcw, ChevronRight, Search } from 'lucide-react';
import { hasJsonSchemaObjectProperties } from '@taucad/utils/schema';
import { Button } from '#components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { Parameters } from '@taucad/react/parameters';
import { cn } from '#utils/ui.utils.js';
import { useCadPreview } from '#hooks/use-cad-preview.js';

type ParameterSchema = NonNullable<ComponentProps<typeof Parameters>['jsonSchema']>;

type ParameterGroup = {
  readonly key: string;
  readonly title: string;
  readonly parameterKeys: readonly string[];
};

type ParameterView = {
  readonly parameters: Record<string, unknown>;
  readonly defaultParameters: Record<string, unknown>;
  readonly jsonSchema: ComponentProps<typeof Parameters>['jsonSchema'];
  readonly toModelParameters: (parameters: Record<string, unknown>) => Record<string, unknown>;
};

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

const cloneParameterValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => cloneParameterValue(item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneParameterValue(item)]));
  }

  return value;
};

const readableTitle = (key: string): string =>
  key
    .replaceAll(/([\da-z])([A-Z])/gu, '$1 $2')
    .replaceAll(/[_-]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .replaceAll(/\b\w/gu, (match) => match.toUpperCase());

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

const groupFlatParameters = (parameters: Record<string, unknown>): readonly ParameterGroup[] | undefined => {
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

  const groups: ParameterGroup[] = [];
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
  groups: readonly ParameterGroup[],
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
  groups: readonly ParameterGroup[],
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

const groupParameterSchema = (
  jsonSchema: ParameterSchema,
  groups: readonly ParameterGroup[],
): ComponentProps<typeof Parameters>['jsonSchema'] => {
  const sourceProperties = isRecord(jsonSchema.properties) ? jsonSchema.properties : {};
  const sourceRequired = Array.isArray(jsonSchema.required)
    ? new Set(jsonSchema.required.filter((value): value is string => typeof value === 'string'))
    : new Set<string>();

  return {
    ...jsonSchema,
    properties: Object.fromEntries(
      groups.map((group) => {
        const properties = Object.fromEntries(
          group.parameterKeys.flatMap((key) => {
            const property = sourceProperties[key];
            return property === undefined ? [] : [[key, property]];
          }),
        );
        const required = group.parameterKeys.filter((key) => sourceRequired.has(key));
        return [
          group.key,
          {
            type: 'object',
            title: group.title,
            properties,
            ...(required.length > 0 ? { required } : {}),
          },
        ];
      }),
    ),
    required: undefined,
  };
};

const createParameterView = ({
  parameters,
  defaultParameters,
  jsonSchema,
}: {
  readonly parameters: Record<string, unknown>;
  readonly defaultParameters: Record<string, unknown>;
  readonly jsonSchema: ComponentProps<typeof Parameters>['jsonSchema'];
}): ParameterView => {
  const groups = groupFlatParameters(defaultParameters);
  if (!groups || !jsonSchema) {
    return {
      parameters,
      defaultParameters,
      jsonSchema,
      toModelParameters: (nextParameters) => nextParameters,
    };
  }

  return {
    parameters: groupParameterRecord(parameters, groups),
    defaultParameters: groupParameterRecord(defaultParameters, groups),
    jsonSchema: groupParameterSchema(jsonSchema, groups),
    toModelParameters(parameters) {
      return ungroupParameterRecord(parameters, groups);
    },
  };
};

export function PreviewParameters({
  headerActions,
}: { readonly headerActions?: React.ReactNode } = {}): React.JSX.Element {
  const { graphicsRef, parameters, defaultParameters, jsonSchema, setParameters } = useCadPreview();
  const units = useSelector(graphicsRef, (state) => state.context.units);

  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [isAllExpanded, setIsAllExpanded] = useState(true);
  const parameterView = useMemo(
    () => createParameterView({ parameters, defaultParameters, jsonSchema }),
    [parameters, defaultParameters, jsonSchema],
  );

  const handleParametersChange = useCallback(
    (newParameters: Record<string, unknown>) => {
      setParameters(parameterView.toModelParameters(newParameters));
    },
    [parameterView, setParameters],
  );

  const toggleSearch = useCallback(() => {
    setIsSearchVisible((current) => !current);
  }, []);

  const toggleAllExpanded = useCallback(() => {
    setIsAllExpanded((current) => !current);
  }, []);

  const resetAllParameters = useCallback(() => {
    setParameters({});
  }, [setParameters]);

  const hasModifiedParameters = Object.keys(parameters).length > 0;

  return (
    <div className='flex h-full flex-col'>
      <div className='flex items-center justify-between border-b p-2'>
        <h3 className='text-sm font-semibold'>Parameters</h3>
        <div className='flex items-center gap-1'>
          {headerActions}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant='ghost'
                size='icon'
                className={cn('size-6 rounded-sm', isSearchVisible && 'text-primary')}
                aria-label={isSearchVisible ? 'Hide search' : 'Show search'}
                onClick={toggleSearch}
              >
                <Search className='size-4' />
              </Button>
            </TooltipTrigger>
            <TooltipContent side='top'>{isSearchVisible ? 'Hide search' : 'Search parameters'}</TooltipContent>
          </Tooltip>
          {hasModifiedParameters ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon'
                  className='size-6 rounded-sm'
                  aria-label='Reset all parameters'
                  onClick={resetAllParameters}
                >
                  <RefreshCcw className='size-4' />
                </Button>
              </TooltipTrigger>
              <TooltipContent side='top'>Reset all parameters</TooltipContent>
            </Tooltip>
          ) : null}
          {jsonSchema && hasJsonSchemaObjectProperties(jsonSchema) ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon'
                  className='size-6 rounded-sm'
                  aria-expanded={isAllExpanded}
                  aria-label={isAllExpanded ? 'Collapse all' : 'Expand all'}
                  onClick={toggleAllExpanded}
                >
                  <ChevronRight
                    className={cn('size-4 transition-transform duration-300 ease-in-out', isAllExpanded && 'rotate-90')}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side='top'>{isAllExpanded ? 'Collapse all' : 'Expand all'}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>
      <div className='flex-1 overflow-hidden'>
        <Parameters
          parameters={parameterView.parameters}
          defaultParameters={parameterView.defaultParameters}
          jsonSchema={parameterView.jsonSchema}
          units={units}
          enableSearch={isSearchVisible}
          isAllExpanded={isAllExpanded}
          emptyDescription='This model has no parameters'
          onParametersChange={handleParametersChange}
        />
      </div>
    </div>
  );
}
