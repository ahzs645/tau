import { XIcon, SlidersHorizontal, Search, ChevronRight, ChevronDown, Pencil, Trash } from 'lucide-react';
import { useCallback, memo, useState, useMemo, useRef, useEffect } from 'react';
import { useSelector } from '@xstate/react';
import type { ActorRefFrom } from 'xstate';
import type { PaneviewApi, PaneviewPanelApi } from 'dockview-react';
import { PaneviewReact } from 'dockview-react';
import { hasJsonSchemaObjectProperties } from '@taucad/utils/schema';
import { KeyShortcut } from '#components/ui/key-shortcut.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
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
import { Button } from '#components/ui/button.js';
import { Input } from '#components/ui/input.js';
import { ComboBoxResponsive } from '#components/ui/combobox-responsive.js';
import { cn } from '#utils/ui.utils.js';
import {
  PaneviewHeader,
  PaneviewHeaderAction,
  PaneviewHeaderControls,
  PaneviewHeaderContentActions,
  paneviewStyleOverrides,
} from '#components/panes/paneview-header.js';
import { ModifiedIndicator } from '#components/ui/modified-indicator.js';
import { useKeybinding } from '#hooks/use-keyboard.js';
import type { KeyCombination } from '#utils/keys.utils.js';
import { formatKeyCombination } from '#utils/keys.utils.js';
import { useProject, useMainGraphics } from '#hooks/use-project.js';
import { Parameters } from '#components/geometry/parameters/parameters.js';
import type { cadMachine } from '#machines/cad.machine.js';
import { getActiveGroupValues } from '#utils/parameter-config.utils.js';
import { sortCompilationEntries } from '#routes/projects_.$id/compilation-unit.utils.js';
import { usePaneviewPersistence, getInitialPanelOptions } from '#routes/projects_.$id/use-chat-interface-state.js';

const toggleParametersKeyCombination = {
  key: 'x',
  ctrlKey: true,
} satisfies KeyCombination;

type ParameterGroupItem = {
  name: string;
  parameterCount: number;
  isActive: boolean;
};

// ---------------------------------------------------------------------------
// Parameter group selector: VS Code branch-selector-style dropdown
// ---------------------------------------------------------------------------

const createNewGroupValue = '__create_new_group__';

type ParameterGroupSelectorItem =
  | ParameterGroupItem
  | { name: typeof createNewGroupValue; parameterCount: 0; isActive: false };

function ParameterGroupSelector({
  filePath,
  groups,
  activeGroup,
}: {
  readonly filePath: string;
  readonly groups: Record<string, { values: Record<string, unknown> }>;
  readonly activeGroup: string;
}): React.JSX.Element {
  const { switchParameterGroup, createParameterGroup, deleteParameterGroup, renameParameterGroup } = useProject();

  const [isCreating, setIsCreating] = useState(false);
  const [createValue, setCreateValue] = useState('');
  const [renamingGroup, setRenamingGroup] = useState<string | undefined>(undefined);
  const [renameValue, setRenameValue] = useState('');

  const groupItems = useMemo<ParameterGroupItem[]>(
    () =>
      Object.entries(groups).map(([name, group]) => ({
        name,
        parameterCount: Object.keys(group.values).length,
        isActive: name === activeGroup,
      })),
    [groups, activeGroup],
  );

  const selectorItems = useMemo<ParameterGroupSelectorItem[]>(
    () => [...groupItems, { name: createNewGroupValue, parameterCount: 0, isActive: false }],
    [groupItems],
  );

  const groupedItems = useMemo(() => [{ name: 'Parameter Groups', items: selectorItems }], [selectorItems]);

  const handleSelect = useCallback(
    (value: string) => {
      if (value === createNewGroupValue) {
        setCreateValue(`${activeGroup} copy`);
        setIsCreating(true);
        return;
      }
      switchParameterGroup(filePath, value);
    },
    [switchParameterGroup, filePath, activeGroup],
  );

  const shouldCloseOnSelect = useCallback((value: string) => value !== createNewGroupValue, []);

  const handleCommitCreate = useCallback(() => {
    const trimmed = createValue.trim();
    if (!trimmed || groups[trimmed]) {
      setIsCreating(false);
      return;
    }
    const currentValues = groups[activeGroup]?.values ?? {};
    createParameterGroup(filePath, trimmed, currentValues);
    switchParameterGroup(filePath, trimmed);
    setIsCreating(false);
  }, [createValue, groups, activeGroup, filePath, createParameterGroup, switchParameterGroup]);

  const handleCancelCreate = useCallback(() => {
    setIsCreating(false);
  }, []);

  const handleStartRename = useCallback((groupName: string) => {
    setRenamingGroup(groupName);
    setRenameValue(groupName);
  }, []);

  const handleCommitRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (!renamingGroup || !trimmed || trimmed === renamingGroup || groups[trimmed]) {
      setRenamingGroup(undefined);
      return;
    }
    renameParameterGroup(filePath, renamingGroup, trimmed);
    setRenamingGroup(undefined);
  }, [renameValue, renamingGroup, groups, filePath, renameParameterGroup]);

  const handleCancelRename = useCallback(() => {
    setRenamingGroup(undefined);
  }, []);

  const handleDelete = useCallback(
    (groupName: string) => {
      deleteParameterGroup(filePath, groupName);
    },
    [deleteParameterGroup, filePath],
  );

  const getItemValue = useCallback((item: ParameterGroupSelectorItem) => item.name, []);

  const renderLabel = useCallback(
    (item: ParameterGroupSelectorItem, _selected: ParameterGroupSelectorItem | undefined) => {
      if (item.name === createNewGroupValue) {
        if (isCreating) {
          return (
            <form
              className='flex w-full items-center gap-1'
              onSubmit={(event) => {
                event.preventDefault();
                handleCommitCreate();
              }}
            >
              <Input
                autoFocus
                autoComplete='off'
                value={createValue}
                className='h-6 text-xs'
                onChange={(event) => {
                  setCreateValue(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    handleCancelCreate();
                  }
                }}
                onBlur={handleCommitCreate}
                onFocus={(event) => {
                  event.target.select();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                }}
              />
              <Button type='submit' size='xs' disabled={!createValue.trim() || Boolean(groups[createValue.trim()])}>
                Save
              </Button>
            </form>
          );
        }

        return <span className='text-xs text-muted-foreground'>Save as new group&hellip;</span>;
      }

      if (renamingGroup === item.name) {
        return (
          <form
            className='flex w-full items-center gap-1'
            onSubmit={(event) => {
              event.preventDefault();
              handleCommitRename();
            }}
          >
            <Input
              autoFocus
              autoComplete='off'
              value={renameValue}
              className='h-6 text-xs'
              onChange={(event) => {
                setRenameValue(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  handleCancelRename();
                }
              }}
              onBlur={handleCommitRename}
              onFocus={(event) => {
                event.target.select();
              }}
              onClick={(event) => {
                event.stopPropagation();
              }}
            />
            <Button
              type='submit'
              size='sm'
              className='h-6 px-2 text-xs'
              disabled={!renameValue.trim() || renameValue === item.name}
            >
              Save
            </Button>
          </form>
        );
      }

      return (
        <div className='group flex w-full items-start justify-between'>
          <div className='flex min-w-0 flex-col'>
            <span className={cn('text-sm font-medium', item.isActive && 'text-primary')}>{item.name}</span>
            <span className='text-xs text-muted-foreground'>
              {item.parameterCount} {item.parameterCount === 1 ? 'override' : 'overrides'}
            </span>
          </div>
          <div className='flex gap-1 opacity-0 group-hover:opacity-100'>
            <Button
              variant='ghost'
              size='icon'
              className='size-6 hover:bg-neutral/20!'
              onClick={(event) => {
                event.stopPropagation();
                handleStartRename(item.name);
              }}
            >
              <Pencil className='size-3' />
            </Button>
            <Button
              variant='ghost'
              size='icon'
              className='size-6 hover:bg-destructive/20!'
              disabled={item.isActive}
              onClick={(event) => {
                event.stopPropagation();
                handleDelete(item.name);
              }}
            >
              <Trash className='size-3' />
            </Button>
          </div>
        </div>
      );
    },
    [
      isCreating,
      createValue,
      renamingGroup,
      renameValue,
      groups,
      handleCommitCreate,
      handleCancelCreate,
      handleCommitRename,
      handleCancelRename,
      handleStartRename,
      handleDelete,
    ],
  );

  const selectedItem = useMemo(() => groupItems.find((item) => item.isActive), [groupItems]);

  return (
    <Tooltip>
      <ComboBoxResponsive
        groupedItems={groupedItems}
        renderLabel={renderLabel}
        getValue={getItemValue}
        defaultValue={selectedItem}
        placeholder='Select a parameter group'
        searchPlaceHolder='Search groups...'
        title='Parameter Groups'
        description='Select a parameter group to apply.'
        isSearchEnabled={groupItems.length > 5}
        shouldCloseOnSelect={shouldCloseOnSelect}
        popoverProperties={{
          align: 'end',
          className: 'w-[260px]',
        }}
        onSelect={handleSelect}
      >
        <TooltipTrigger>
          <button
            type='button'
            aria-label='Parameter groups'
            className='hover:text-accent-foreground flex h-5 max-w-24 items-center gap-0.5 rounded-sm px-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent'
          >
            <span className='truncate'>{activeGroup}</span>
            <ChevronDown className='size-2.5 shrink-0 opacity-60' />
          </button>
        </TooltipTrigger>
      </ComboBoxResponsive>
      <TooltipContent side='top'>Parameter groups</TooltipContent>
    </Tooltip>
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
  const { parameterEntries, setCompilationUnitParameters } = useProject();
  const graphicsActor = useMainGraphics();

  const parameters = useMemo(
    () => getActiveGroupValues(parameterEntries.get(entryFile)),
    [parameterEntries, entryFile],
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
  const { parameterEntries, setCompilationUnitParameters } = useProject();
  const entry = parameterEntries.get(params.entryFile);
  const jsonSchema = useSelector(params.cadRef, (state) => state.context.jsonSchema);

  const showCollapseToggle = Boolean(jsonSchema && hasJsonSchemaObjectProperties(jsonSchema));

  const hasModifiedParameters = useMemo(() => {
    return Object.keys(getActiveGroupValues(entry)).length > 0;
  }, [entry]);

  const handleReset = useCallback(() => {
    setCompilationUnitParameters(params.entryFile, {});
  }, [setCompilationUnitParameters, params.entryFile]);

  const handleToggleAllExpanded = useCallback(() => {
    api.updateParameters({ isAllExpanded: !params.isAllExpanded });
  }, [api, params.isAllExpanded]);

  return (
    <PaneviewHeader api={api} title={params.entryFile}>
      {hasModifiedParameters ? (
        <ModifiedIndicator
          onReset={handleReset}
          tooltip='Reset parameters'
          className='[.dv-pane:hover_&]:**:data-[slot=dot]:opacity-0 [.dv-pane:hover_&]:**:data-[slot=icon]:opacity-100'
        />
      ) : null}
      <PaneviewHeaderControls>
        {entry ? (
          <ParameterGroupSelector filePath={params.entryFile} groups={entry.groups} activeGroup={entry.activeGroup} />
        ) : null}
        <PaneviewHeaderContentActions>
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
        </PaneviewHeaderContentActions>
      </PaneviewHeaderControls>
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
  const paneviewApiRef = useRef<PaneviewApi | undefined>(undefined);

  const sortedEntries = useMemo(() => sortCompilationEntries(entries, mainEntryFile), [entries, mainEntryFile]);

  const paneviewKey = useMemo(() => sortedEntries.map(([file]) => file).join('\0'), [sortedEntries]);

  const handleReady = useCallback(
    (event: { api: PaneviewApi }) => {
      paneviewApiRef.current = event.api;
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

  useEffect(() => {
    const api = paneviewApiRef.current;
    if (!api) {
      return;
    }
    for (const panel of api.panels) {
      panel.api.updateParameters({ enableSearch });
    }
  }, [enableSearch]);

  return (
    <PaneviewReact
      key={paneviewKey}
      className={cn(paneviewStyleOverrides, '[&_.dv-pane-body]:overflow-y-hidden!')}
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
