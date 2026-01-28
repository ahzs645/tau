import { XIcon, SlidersHorizontal, Search, ChevronRight, RefreshCcw } from 'lucide-react';
import { useCallback, memo, useState } from 'react';
import { useSelector } from '@xstate/react';
import { KeyShortcut } from '#components/ui/key-shortcut.js';
import {
  FloatingPanel,
  FloatingPanelClose,
  FloatingPanelContent,
  FloatingPanelContentBody,
  FloatingPanelContentHeader,
  FloatingPanelContentHeaderActions,
  FloatingPanelContentTitle,
  FloatingPanelTrigger,
} from '#components/ui/floating-panel.js';
import { Button } from '#components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { cn } from '#utils/ui.utils.js';
import { hasJsonSchemaObjectProperties } from '#utils/schema.utils.js';
import { useKeydown } from '#hooks/use-keydown.js';
import type { KeyCombination } from '#utils/keys.utils.js';
import { formatKeyCombination } from '#utils/keys.utils.js';
import { useBuild } from '#hooks/use-build.js';
import { Parameters } from '#components/geometry/parameters/parameters.js';

const toggleParametersKeyCombination = {
  key: 'x',
  ctrlKey: true,
} satisfies KeyCombination;

// Parameters Trigger Component
export const ChatParametersTrigger = memo(function ({
  isOpen,
  onToggle,
}: {
  readonly isOpen: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <FloatingPanelTrigger
      icon={SlidersHorizontal}
      tooltipContent={
        <div className="flex items-center gap-2">
          {isOpen ? 'Close' : 'Open'} Parameters
          <KeyShortcut variant="tooltip">{formatKeyCombination(toggleParametersKeyCombination)}</KeyShortcut>
        </div>
      }
      tooltipSide="left"
      className={isOpen ? 'text-primary' : undefined}
      onClick={onToggle}
    />
  );
});

export const ChatParameters = memo(function (props: {
  readonly className?: string;
  readonly isExpanded?: boolean;
  readonly setIsExpanded?: (value: boolean | ((current: boolean) => boolean)) => void;
}) {
  const { buildRef, cadRef, graphicsRef, setParameters } = useBuild();
  const { className, isExpanded = true, setIsExpanded } = props;
  const parameters = useSelector(buildRef, (state) => state.context.build?.assets.mechanical?.parameters ?? {});
  const defaultParameters = useSelector(cadRef, (state) => state.context.defaultParameters);
  const jsonSchema = useSelector(cadRef, (state) => state.context.jsonSchema);

  // Build CadUnits object reactively from graphics state
  const units = useSelector(graphicsRef, (state) => state.context.units);

  // State to toggle search visibility
  const [isSearchVisible, setIsSearchVisible] = useState(false);

  // State to toggle expand/collapse all
  const [isAllExpanded, setIsAllExpanded] = useState(true);

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

  const toggleParametersOpen = useCallback(() => {
    setIsExpanded?.((current) => !current);
  }, [setIsExpanded]);

  const { formattedKeyCombination: formattedParametersKeyCombination } = useKeydown(
    toggleParametersKeyCombination,
    toggleParametersOpen,
  );

  return (
    <FloatingPanel isOpen={isExpanded} side="right" className={className} onOpenChange={setIsExpanded}>
      <FloatingPanelClose
        icon={XIcon}
        tooltipContent={(isOpen) => (
          <div className="flex items-center gap-2">
            {isOpen ? 'Close' : 'Open'} Parameters
            <KeyShortcut variant="tooltip">{formattedParametersKeyCombination}</KeyShortcut>
          </div>
        )}
      />
      <FloatingPanelContent>
        <FloatingPanelContentHeader>
          <FloatingPanelContentTitle>Parameters</FloatingPanelContentTitle>
          <FloatingPanelContentHeaderActions>
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
                      className={cn(
                        'size-4 transition-transform duration-300 ease-in-out',
                        isAllExpanded && 'rotate-90',
                      )}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{isAllExpanded ? 'Collapse all' : 'Expand all'}</TooltipContent>
              </Tooltip>
            ) : null}
          </FloatingPanelContentHeaderActions>
        </FloatingPanelContentHeader>

        <FloatingPanelContentBody className="overflow-y-hidden">
          <Parameters
            parameters={parameters}
            defaultParameters={defaultParameters}
            jsonSchema={jsonSchema}
            units={units}
            enableSearch={isSearchVisible}
            isAllExpanded={isAllExpanded}
            onParametersChange={setParameters}
          />
        </FloatingPanelContentBody>
      </FloatingPanelContent>
    </FloatingPanel>
  );
});
