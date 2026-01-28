import type { IChangeEvent } from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import { Info } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import Form from '@rjsf/core';
import type { RJSFSchema } from '@rjsf/utils';
import { SearchInput } from '#components/search-input.js';
import { cn } from '#utils/ui.utils.js';
import { templates, uiSchema, widgets } from '#components/geometry/parameters/rjsf-theme.js';
import type { RJSFContext, Units } from '#components/geometry/parameters/rjsf-context.js';
import { rjsfIdPrefix, rjsfIdSeparator } from '#components/geometry/parameters/rjsf-utils.js';
import { deleteValueAtPath, extractModifiedProperties, getValueAtPath, setValueAtPath } from '#utils/object.utils.js';
import { EmptyItems } from '#components/ui/empty-items.js';

type ParametersProperties = {
  readonly parameters: Record<string, unknown>;
  readonly defaultParameters: Record<string, unknown>;
  readonly jsonSchema: RJSFSchema | undefined;
  readonly onParametersChange: (parameters: Record<string, unknown>) => void;
  readonly className?: string;
  readonly enableSearch?: boolean;
  readonly searchPlaceholder?: string;
  readonly emptyMessage?: string;
  readonly emptyDescription?: string;
  readonly units: Units;
  readonly isInitialExpanded?: boolean;
  readonly isAllExpanded?: boolean;
};

export function Parameters({
  parameters,
  defaultParameters,
  jsonSchema,
  onParametersChange,
  className,
  enableSearch = true,
  searchPlaceholder = 'Search parameters...',
  emptyMessage = 'No parameters available',
  emptyDescription = 'Parameters will appear here when they become available for this model',
  units,
  isInitialExpanded = true,
  isAllExpanded,
}: ParametersProperties): React.JSX.Element {
  // Use controlled state if provided, otherwise use initial value
  const allExpanded = isAllExpanded ?? isInitialExpanded;
  const [searchTerm, setSearchTerm] = useState('');
  const searchInputReference = React.useRef<HTMLInputElement>(null);
  // Ref to track current form data from RJSF's onChange handler
  const currentFormDataRef = React.useRef<Record<string, unknown>>({});
  // Ref to track previous enableSearch value to detect changes
  const previousEnableSearchRef = React.useRef(enableSearch);

  // Focus the search input when search changes from disabled to enabled (not on initial render)
  React.useEffect(() => {
    const wasDisabled = !previousEnableSearchRef.current;
    const isNowEnabled = enableSearch;

    // Only focus if transitioning from disabled to enabled
    if (wasDisabled && isNowEnabled && searchInputReference.current) {
      searchInputReference.current.focus();
    }

    previousEnableSearchRef.current = enableSearch;
  }, [enableSearch]);

  // Clear search term when search is hidden
  React.useEffect(() => {
    if (!enableSearch) {
      setSearchTerm('');
    }
  }, [enableSearch]);

  const setParameters = useCallback(
    (newParameters: Record<string, unknown>) => {
      // Extract only modified parameters before calling onParametersChange
      const modifiedParameters = extractModifiedProperties(newParameters, defaultParameters);
      onParametersChange(modifiedParameters);
    },
    [onParametersChange, defaultParameters],
  );

  // Enhanced reset function that handles nested paths and arrays
  const resetSingleParameter = useCallback(
    (fieldPath: string[]) => {
      // Use the current form data from RJSF instead of the parameters prop
      // This ensures we're working with the actual form state, not stale props
      const currentFormData = currentFormDataRef.current;

      // Check if we're resetting an array item (path ends with a numeric string)
      const lastSegment = fieldPath.at(-1);
      const isArrayItem = lastSegment !== undefined && /^\d+$/.test(lastSegment);

      if (isArrayItem) {
        // For array items, restore the default value instead of deleting
        // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- getValueAtPath returns value or undefined, not void
        const defaultValue = getValueAtPath(defaultParameters, fieldPath as readonly string[]);
        const updatedParameters = setValueAtPath(currentFormData, fieldPath, defaultValue);
        setParameters(updatedParameters);
      } else {
        // For non-array items, delete the value (which removes it from modified parameters)
        const updatedParameters = deleteValueAtPath(currentFormData, fieldPath);
        setParameters(updatedParameters);
      }
    },
    [setParameters, defaultParameters],
  );

  const handleSearchChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(event.target.value);
  }, []);

  const clearSearch = useCallback(() => {
    setSearchTerm('');
  }, []);

  const formContext = useMemo<RJSFContext>(
    () => ({
      allExpanded,
      searchTerm,
      resetSingleParameter,
      defaultParameters,
      shouldShowField(text) {
        if (!searchTerm) {
          return true;
        }

        return text.toLowerCase().includes(searchTerm.toLowerCase());
      },
      units,
    }),
    [allExpanded, searchTerm, resetSingleParameter, defaultParameters, units],
  );

  const mergedData = useMemo(() => ({ ...defaultParameters, ...parameters }), [defaultParameters, parameters]);
  const hasParameters = jsonSchema && Object.keys(jsonSchema.properties ?? {}).length > 0;

  // Initialize the ref with the current edited parameters when component mounts or data changes
  React.useEffect(() => {
    currentFormDataRef.current = mergedData;
  }, [mergedData]);

  const handleChange = (event: IChangeEvent<Record<string, unknown>, RJSFSchema, RJSFContext>) => {
    const formData = event.formData ?? {};
    setParameters(formData);
  };

  return (
    <div data-slot="parameters" className={cn('group flex h-full w-full flex-col', className)}>
      {hasParameters ? (
        <>
          {/* Search Bar */}
          {enableSearch ? (
            <div className="flex w-full flex-row gap-2 border-b bg-sidebar p-2">
              <SearchInput
                ref={searchInputReference}
                placeholder={searchPlaceholder}
                value={searchTerm}
                className="h-7 w-full bg-background"
                onChange={handleSearchChange}
                onClear={clearSearch}
              />
            </div>
          ) : null}
          <Form<Record<string, unknown>, RJSFSchema, RJSFContext>
            // @ts-expect-error -- TODO: fix this
            validator={validator}
            // @ts-expect-error -- TODO: fix this
            templates={templates}
            schema={jsonSchema}
            // @ts-expect-error -- TODO: fix this
            uiSchema={uiSchema}
            idPrefix={rjsfIdPrefix}
            idSeparator={rjsfIdSeparator}
            widgets={widgets}
            formData={mergedData}
            formContext={formContext}
            className="flex flex-1 flex-col overflow-y-auto px-0 py-0"
            onChange={handleChange}
          />
        </>
      ) : (
        <EmptyItems>
          <div className="mb-3 rounded-full bg-muted/50 p-2">
            <Info className="size-6 text-muted-foreground" strokeWidth={1.5} />
          </div>
          <h3 className="mb-1 text-base font-medium">{emptyMessage}</h3>
          <p className="text-muted-foreground">{emptyDescription}</p>
        </EmptyItems>
      )}
    </div>
  );
}
