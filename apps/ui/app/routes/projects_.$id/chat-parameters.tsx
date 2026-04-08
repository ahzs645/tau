import { XIcon, SlidersHorizontal, Search, ChevronRight, RefreshCcw } from 'lucide-react';
import { useCallback, memo, useState, useMemo } from 'react';
import { useSelector } from '@xstate/react';
import type { ActorRefFrom } from 'xstate';
import type { PaneviewApi, PaneviewPanelApi } from 'dockview-react';
import { PaneviewReact } from 'dockview-react';
import { hasJsonSchemaObjectProperties } from '@taucad/utils/schema';
import { KeyShortcut } from '#components/ui/key-shortcut.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#components/ui/select.js';
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
import {
  PaneviewHeader,
  PaneviewHeaderAction,
  PaneviewHeaderActionGroup,
  paneviewStyleOverrides,
} from '#components/panes/paneview-header.js';
import { useKeybinding } from '#hooks/use-keyboard.js';
import type { KeyCombination } from '#utils/keys.utils.js';
import { formatKeyCombination } from '#utils/keys.utils.js';
import { useProject, useMainGraphics } from '#hooks/use-project.js';
import { Parameters } from '#components/geometry/parameters/parameters.js';
import type { cadMachine } from '#machines/cad.machine.js';
import { getActiveSetValues } from '#utils/parameter-config.utils.js';
import { sortCompilationEntries } from '#routes/projects_.$id/compilation-unit.utils.js';
import { usePaneviewPersistence, getInitialPanelOptions } from '#routes/projects_.$id/use-chat-interface-state.js';

const toggleParametersKeyCombination = {
  key: 'x',
  ctrlKey: true,
} satisfies KeyCombination;

// ---------------------------------------------------------------------------
// Parameter set selector (dropdown for switching active set)
// ---------------------------------------------------------------------------

function ParameterSetSelector({
  filePath,
  sets,
  activeSet,
}: {
  readonly filePath: string;
  readonly sets: Record<string, { values: Record<string, unknown> }>;
  readonly activeSet: string;
}): React.JSX.Element {
  const { switchParameterSet } = useProject();
  const setNames = Object.keys(sets);

  const handleChange = useCallback(
    (value: string) => {
      switchParameterSet(filePath, value);
    },
    [switchParameterSet, filePath],
  );

  if (setNames.length <= 1) {
    return <span className='text-[10px] text-muted-foreground'>{activeSet}</span>;
  }

  return (
    <Select value={activeSet} onValueChange={handleChange}>
      <SelectTrigger size='sm' className='h-5 min-w-0 gap-1 border-0 bg-transparent px-1 text-[10px] shadow-none'>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {setNames.map((name) => (
          <SelectItem key={name} value={name} className='text-xs'>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ---------------------------------------------------------------------------
// CU parameters panel body (used in both flat and paneview modes)
// ---------------------------------------------------------------------------

function CompilationUnitParameters({
  entryFile,
  cadRef,
  enableSearch,
  isAllExpanded,
}: {
  readonly entryFile: string;
  readonly cadRef: ActorRefFrom<typeof cadMachine>;
  readonly enableSearch: boolean;
  readonly isAllExpanded: boolean;
}): React.JSX.Element {
  const { parameterConfig, setCompilationUnitParameters } = useProject();
  const graphicsActor = useMainGraphics();

  const parameters = useMemo(
    () => (parameterConfig ? getActiveSetValues(parameterConfig, entryFile) : {}),
    [parameterConfig, entryFile],
  );

  const defaultParameters = useSelector(cadRef, (state) => state.context.defaultParameters);
  const jsonSchema = useSelector(cadRef, (state) => state.context.jsonSchema);
  const units = useSelector(graphicsActor, (state) => state?.context.units) ?? {
    length: { symbol: 'mm', factor: 1 },
  };

  const handleParametersChange = useCallback(
    (newParams: Record<string, unknown>) => {
      setCompilationUnitParameters(entryFile, newParams);
    },
    [setCompilationUnitParameters, entryFile],
  );

  return (
    <Parameters
      parameters={parameters}
      defaultParameters={defaultParameters}
      jsonSchema={jsonSchema}
      units={units}
      enableSearch={enableSearch}
      isAllExpanded={isAllExpanded}
      onParametersChange={handleParametersChange}
    />
  );
}

// ---------------------------------------------------------------------------
// Paneview panel body
// ---------------------------------------------------------------------------

type ParametersPanelParams = {
  entryFile: string;
  cadRef: ActorRefFrom<typeof cadMachine>;
  enableSearch: boolean;
  isAllExpanded: boolean;
};

function ParametersPanelBody({ params }: { readonly params: ParametersPanelParams }): React.JSX.Element {
  return (
    <CompilationUnitParameters
      entryFile={params.entryFile}
      cadRef={params.cadRef}
      enableSearch={params.enableSearch}
      isAllExpanded={params.isAllExpanded}
    />
  );
}

// ---------------------------------------------------------------------------
// Paneview panel header: file name + set selector
// ---------------------------------------------------------------------------

function ParametersPanelHeader({
  api,
  params,
}: {
  readonly api: PaneviewPanelApi;
  readonly params: ParametersPanelParams;
}): React.JSX.Element {
  const { parameterConfig, setCompilationUnitParameters } = useProject();
  const fileEntry = parameterConfig?.files[params.entryFile];
  const jsonSchema = useSelector(params.cadRef, (state) => state.context.jsonSchema);

  const showCollapseToggle = jsonSchema && hasJsonSchemaObjectProperties(jsonSchema);

  const hasModifiedParameters = useMemo(() => {
    if (!parameterConfig) {
      return false;
    }
    return Object.keys(getActiveSetValues(parameterConfig, params.entryFile)).length > 0;
  }, [parameterConfig, params.entryFile]);

  const handleReset = useCallback(() => {
    setCompilationUnitParameters(params.entryFile, {});
  }, [setCompilationUnitParameters, params.entryFile]);

  const handleToggleAllExpanded = useCallback(() => {
    api.updateParameters({ isAllExpanded: !params.isAllExpanded });
  }, [api, params.isAllExpanded]);

  return (
    <PaneviewHeader
      api={api}
      title={params.entryFile}
      actions={
        showCollapseToggle || hasModifiedParameters ? (
          <PaneviewHeaderActionGroup>
            {showCollapseToggle ? (
              <PaneviewHeaderAction
                aria-expanded={params.isAllExpanded}
                aria-label={params.isAllExpanded ? 'Collapse all' : 'Expand all'}
                tooltip={params.isAllExpanded ? 'Collapse all' : 'Expand all'}
                onClick={handleToggleAllExpanded}
              >
                <ChevronRight
                  className={cn('transition-transform duration-300 ease-in-out', params.isAllExpanded && 'rotate-90')}
                />
              </PaneviewHeaderAction>
            ) : null}
            {hasModifiedParameters ? (
              <PaneviewHeaderAction tooltip='Reset parameters' aria-label='Reset parameters' onClick={handleReset}>
                <RefreshCcw />
              </PaneviewHeaderAction>
            ) : null}
          </PaneviewHeaderActionGroup>
        ) : undefined
      }
    >
      {fileEntry ? (
        <ParameterSetSelector filePath={params.entryFile} sets={fileEntry.sets} activeSet={fileEntry.activeSet} />
      ) : undefined}
    </PaneviewHeader>
  );
}

const paneviewComponents = { parametersPanel: ParametersPanelBody };
const paneviewHeaderComponents = { parametersHeader: ParametersPanelHeader };

// ---------------------------------------------------------------------------
// Multi-CU Paneview layout
// ---------------------------------------------------------------------------

function ParametersPaneview({
  entries,
  mainEntryFile,
  enableSearch,
}: {
  readonly entries: Array<[string, ActorRefFrom<typeof cadMachine>]>;
  readonly mainEntryFile: string;
  readonly enableSearch: boolean;
}): React.JSX.Element {
  const { savedState, connectApi } = usePaneviewPersistence('parametersPaneview');

  const sortedEntries = useMemo(() => sortCompilationEntries(entries, mainEntryFile), [entries, mainEntryFile]);

  const paneviewKey = useMemo(() => sortedEntries.map(([file]) => file).join('\0'), [sortedEntries]);

  const handleReady = useCallback(
    (event: { api: PaneviewApi }) => {
      connectApi(event.api);

      for (const [entryFile, cadRef] of sortedEntries) {
        const isMain = entryFile === mainEntryFile;
        const initial = getInitialPanelOptions(savedState, entryFile, {
          isExpanded: isMain,
          size: isMain ? 200 : undefined,
        });

        event.api.addPanel({
          id: entryFile,
          title: entryFile,
          component: 'parametersPanel',
          headerComponent: 'parametersHeader',
          isExpanded: initial.isExpanded,
          minimumBodySize: 80,
          size: initial.size,
          params: { entryFile, cadRef, enableSearch, isAllExpanded: true } satisfies ParametersPanelParams,
        });
      }
    },
    [sortedEntries, mainEntryFile, enableSearch, savedState, connectApi],
  );

  return (
    <PaneviewReact
      key={paneviewKey}
      className={paneviewStyleOverrides}
      components={paneviewComponents}
      headerComponents={paneviewHeaderComponents}
      onReady={handleReady}
    />
  );
}

// ---------------------------------------------------------------------------
// Parameters content: single vs multi CU
// ---------------------------------------------------------------------------

function ParametersContent({ enableSearch }: { readonly enableSearch: boolean }): React.JSX.Element {
  const { compilationUnits, mainEntryFile } = useProject();
  const entries = useMemo(() => [...compilationUnits.entries()], [compilationUnits]);

  if (entries.length === 0) {
    return <p className='p-4 text-center text-xs text-muted-foreground'>No compilation units.</p>;
  }

  return <ParametersPaneview entries={entries} mainEntryFile={mainEntryFile} enableSearch={enableSearch} />;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

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
        <div className='flex items-center gap-2'>
          {isOpen ? 'Close' : 'Open'} Parameters
          <KeyShortcut variant='tooltip'>{formatKeyCombination(toggleParametersKeyCombination)}</KeyShortcut>
        </div>
      }
      tooltipSide='left'
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
  const { className, isExpanded = true, setIsExpanded } = props;

  const [isSearchVisible, setIsSearchVisible] = useState(false);

  const toggleSearch = useCallback(() => {
    setIsSearchVisible((current) => !current);
  }, []);

  const toggleParametersOpen = useCallback(() => {
    setIsExpanded?.((current) => !current);
  }, [setIsExpanded]);

  const { formattedKeyCombination: formattedParametersKeyCombination } = useKeybinding(
    toggleParametersKeyCombination,
    toggleParametersOpen,
  );

  return (
    <FloatingPanel isOpen={isExpanded} side='right' className={className} onOpenChange={setIsExpanded}>
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
                <Search className='size-4' />
              </FloatingPanelMenuButton>
            </FloatingPanelButtonGroup>
            <FloatingPanelClose
              icon={XIcon}
              tooltipContent={(isOpen) => (
                <div className='flex items-center gap-2'>
                  {isOpen ? 'Close' : 'Open'} Parameters
                  <KeyShortcut variant='tooltip'>{formattedParametersKeyCombination}</KeyShortcut>
                </div>
              )}
            />
          </FloatingPanelContentHeaderActions>
        </FloatingPanelContentHeader>

        <FloatingPanelContentBody className='overflow-y-hidden'>
          <ParametersContent enableSearch={isSearchVisible} />
        </FloatingPanelContentBody>
      </FloatingPanelContent>
    </FloatingPanel>
  );
});
