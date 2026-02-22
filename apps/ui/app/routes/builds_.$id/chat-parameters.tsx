import { XIcon, SlidersHorizontal, Search, ChevronRight, RefreshCcw } from 'lucide-react';
import { useCallback, memo, useState } from 'react';
import { useSelector } from '@xstate/react';
import { hasJsonSchemaObjectProperties } from '@taucad/utils/schema';
import { KeyShortcut } from '#components/ui/key-shortcut.js';
import {
  FloatingPanel,
  FloatingPanelClose,
  FloatingPanelContent,
  FloatingPanelContentBody,
  FloatingPanelContentHeader,
  FloatingPanelContentHeaderActions,
  FloatingPanelMenuButton,
  FloatingPanelButtonGroup,
  FloatingPanelContentTitle,
  FloatingPanelTrigger,
} from '#components/ui/floating-panel.js';
import { cn } from '#utils/ui.utils.js';
import { useKeybinding } from '#hooks/use-keyboard.js';
import type { KeyCombination } from '#utils/keys.utils.js';
import { formatKeyCombination } from '#utils/keys.utils.js';
import { useBuild, useMainGraphics } from '#hooks/use-build.js';
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
  const { buildRef, compilationUnits, mainEntryFile, setParameters } = useBuild();
  const { className, isExpanded = true, setIsExpanded } = props;
  const graphicsActor = useMainGraphics();
  const cadActor = compilationUnits.get(mainEntryFile);
  const parameters = useSelector(buildRef, (state) => state.context.build?.assets.mechanical?.parameters ?? {});
  const defaultParameters = useSelector(cadActor, (state) => state?.context.defaultParameters ?? {});
  const jsonSchema = useSelector(cadActor, (state) => state?.context.jsonSchema ?? undefined);

  // Build CadUnits object reactively from graphics state
  const units = useSelector(graphicsActor, (state) => state?.context.units) ?? {
    length: { symbol: 'mm' as const, factor: 1 },
  };

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

  const { formattedKeyCombination: formattedParametersKeyCombination } = useKeybinding(
    toggleParametersKeyCombination,
    toggleParametersOpen,
  );

  return (
    <FloatingPanel isOpen={isExpanded} side="right" className={className} onOpenChange={setIsExpanded}>
      <FloatingPanelContent>
        <FloatingPanelContentHeader>
          <FloatingPanelContentTitle>Parameters</FloatingPanelContentTitle>
          <FloatingPanelContentHeaderActions>
            <FloatingPanelButtonGroup>
              <FloatingPanelMenuButton
                className={cn(isSearchVisible && 'text-primary')}
                aria-label={isSearchVisible ? 'Hide search' : 'Show search'}
                tooltip={isSearchVisible ? 'Hide search' : 'Search parameters'}
                onClick={toggleSearch}
              >
                <Search className="size-4" />
              </FloatingPanelMenuButton>
              {hasModifiedParameters ? (
                <FloatingPanelMenuButton
                  aria-label="Reset all parameters"
                  tooltip="Reset all parameters"
                  onClick={resetAllParameters}
                >
                  <RefreshCcw className="size-4" />
                </FloatingPanelMenuButton>
              ) : null}
              {jsonSchema && hasJsonSchemaObjectProperties(jsonSchema) ? (
                <FloatingPanelMenuButton
                  aria-expanded={isAllExpanded}
                  aria-label={isAllExpanded ? 'Collapse all' : 'Expand all'}
                  tooltip={isAllExpanded ? 'Collapse all' : 'Expand all'}
                  onClick={toggleAllExpanded}
                >
                  <ChevronRight
                    className={cn('size-4 transition-transform duration-300 ease-in-out', isAllExpanded && 'rotate-90')}
                  />
                </FloatingPanelMenuButton>
              ) : null}
            </FloatingPanelButtonGroup>
            <FloatingPanelClose
              icon={XIcon}
              tooltipContent={(isOpen) => (
                <div className="flex items-center gap-2">
                  {isOpen ? 'Close' : 'Open'} Parameters
                  <KeyShortcut variant="tooltip">{formattedParametersKeyCombination}</KeyShortcut>
                </div>
              )}
            />
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
