import { useState, useCallback } from 'react';
import { useSelector } from '@xstate/react';
import { RefreshCcw, ChevronRight, Search } from 'lucide-react';
import { Button } from '#components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { Parameters } from '#components/geometry/parameters/parameters.js';
import { cn } from '#utils/ui.utils.js';
import { hasJsonSchemaObjectProperties } from '#utils/schema.utils.js';
import { useBuild, useMainGraphics } from '#hooks/use-build.js';

export function PreviewParameters(): React.JSX.Element {
  const { compilationUnits, mainEntryFile } = useBuild();
  const graphicsActor = useMainGraphics();
  const cadActor = compilationUnits.get(mainEntryFile);
  const parameters = useSelector(cadActor, (snapshot) => snapshot?.context.parameters ?? {});
  const defaultParameters = useSelector(cadActor, (snapshot) => snapshot?.context.defaultParameters ?? {});
  const jsonSchema = useSelector(cadActor, (snapshot) => snapshot?.context.jsonSchema);
  const units = useSelector(graphicsActor, (state) => state?.context.units) ?? {
    length: { symbol: 'mm' as const, factor: 1 },
  };

  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [isAllExpanded, setIsAllExpanded] = useState(true);

  const handleParametersChange = useCallback(
    (newParameters: Record<string, unknown>) => {
      cadActor?.send({ type: 'setParameters', parameters: newParameters });
    },
    [cadActor],
  );

  const toggleSearch = useCallback(() => {
    setIsSearchVisible((current) => !current);
  }, []);

  const toggleAllExpanded = useCallback(() => {
    setIsAllExpanded((current) => !current);
  }, []);

  const resetAllParameters = useCallback(() => {
    cadActor?.send({ type: 'setParameters', parameters: {} });
  }, [cadActor]);

  const hasModifiedParameters = Object.keys(parameters).length > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b p-2">
        <h3 className="text-sm font-semibold">Parameters</h3>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn('size-6 rounded-sm', isSearchVisible && 'text-primary')}
                aria-label={isSearchVisible ? 'Hide search' : 'Show search'}
                onClick={toggleSearch}
              >
                <Search className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{isSearchVisible ? 'Hide search' : 'Search parameters'}</TooltipContent>
          </Tooltip>
          {hasModifiedParameters ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 rounded-sm"
                  aria-label="Reset all parameters"
                  onClick={resetAllParameters}
                >
                  <RefreshCcw className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Reset all parameters</TooltipContent>
            </Tooltip>
          ) : null}
          {jsonSchema && hasJsonSchemaObjectProperties(jsonSchema) ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 rounded-sm"
                  aria-expanded={isAllExpanded}
                  aria-label={isAllExpanded ? 'Collapse all' : 'Expand all'}
                  onClick={toggleAllExpanded}
                >
                  <ChevronRight
                    className={cn('size-4 transition-transform duration-300 ease-in-out', isAllExpanded && 'rotate-90')}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{isAllExpanded ? 'Collapse all' : 'Expand all'}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <Parameters
          parameters={parameters}
          defaultParameters={defaultParameters}
          jsonSchema={jsonSchema}
          units={units}
          enableSearch={isSearchVisible}
          isAllExpanded={isAllExpanded}
          emptyDescription="This model has no parameters"
          onParametersChange={handleParametersChange}
        />
      </div>
    </div>
  );
}
