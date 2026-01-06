import React, { useCallback, useState, useEffect, useMemo } from 'react';
import type { ClassValue } from 'clsx';
import {
  Axis3D,
  Box,
  Grid3X3,
  Rotate3D,
  Settings,
  PenLine,
  Sparkles,
  ArrowUp,
  Timer,
  Check,
  ChevronsUpDown,
} from 'lucide-react';
import { useSelector } from '@xstate/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { Button } from '#components/ui/button.js';
import { useBuild } from '#hooks/use-build.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSwitchItem,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.js';
import { ToggleGroup, ToggleGroupItem } from '#components/ui/toggle-group.js';
import { cn } from '#utils/ui.utils.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';
import { InfoTooltip } from '#components/ui/info-tooltip.js';
import { axesColors } from '#constants/color.constants.js';
import { ComboBoxResponsive } from '#components/ui/combobox-responsive.js';

type ViewSettings = {
  surface: boolean;
  lines: boolean;
  gizmo: boolean;
  grid: boolean;
  axes: boolean;
  matcap: boolean;
  upDirection: 'x' | 'y' | 'z';
};

// Default settings
const defaultSettings: ViewSettings = {
  surface: true,
  lines: true,
  gizmo: true,
  grid: true,
  axes: true,
  matcap: false,
  upDirection: 'z',
};

type ViewerSettingsProps = {
  /**
   * Optional className for styling
   */
  readonly className?: ClassValue;
};

// Default render timeout in seconds (30 seconds)
const defaultRenderTimeout = 30;

// Timeout option type
type TimeoutOption = {
  // Value in seconds
  value: number;
  label: string;
};

// Predefined timeout options
const timeoutOptions: TimeoutOption[] = [
  { value: 0, label: 'Disabled' },
  { value: 10, label: '15s' },
  { value: 30, label: '30s' },
  { value: 60, label: '1 min' },
  { value: 300, label: '5 min' },
  { value: 600, label: '10 min' },
];

// Default timeout option (30s)
const defaultTimeoutOption: TimeoutOption = { value: 30, label: '30s' };

/**
 * Component that provides camera and visibility settings for the 3D viewer
 */
export function ViewerSettings({ className }: ViewerSettingsProps): React.ReactNode {
  const { graphicsRef: graphicsActor, cadRef } = useBuild();
  const [viewSettings, setViewSettings] = useCookie<ViewSettings>(cookieName.viewSettings, defaultSettings);
  const [renderTimeout, setRenderTimeout] = useCookie(cookieName.cadRenderTimeout, defaultRenderTimeout);
  const [isOpen, setIsOpen] = useState(false);
  const is2dGeometry = useSelector(graphicsActor, (state) =>
    state.context.geometries.some((geometry) => geometry.format === 'svg'),
  );

  // Synchronize render timeout to CAD machine
  useEffect(() => {
    cadRef.send({ type: 'setRenderTimeout', timeout: renderTimeout * 1000 }); // Convert seconds to ms
  }, [renderTimeout, cadRef]);

  // Synchronize each setting to the Graphics context when settings change
  useEffect(() => {
    graphicsActor.send({ type: 'setSurfaceVisibility', payload: viewSettings.surface });
  }, [viewSettings.surface, graphicsActor]);

  useEffect(() => {
    graphicsActor.send({ type: 'setLinesVisibility', payload: viewSettings.lines });
  }, [viewSettings.lines, graphicsActor]);

  useEffect(() => {
    graphicsActor.send({ type: 'setGizmoVisibility', payload: viewSettings.gizmo });
  }, [viewSettings.gizmo, graphicsActor]);

  useEffect(() => {
    graphicsActor.send({ type: 'setGridVisibility', payload: viewSettings.grid });
  }, [viewSettings.grid, graphicsActor]);

  useEffect(() => {
    graphicsActor.send({ type: 'setAxesVisibility', payload: viewSettings.axes });
  }, [viewSettings.axes, graphicsActor]);

  useEffect(() => {
    graphicsActor.send({ type: 'setMatcapVisibility', payload: viewSettings.matcap });
  }, [viewSettings.matcap, graphicsActor]);

  useEffect(() => {
    graphicsActor.send({ type: 'setUpDirection', payload: viewSettings.upDirection });
  }, [viewSettings.upDirection, graphicsActor]);

  const handleMeshToggle = useCallback(
    (checked: boolean) => {
      setViewSettings((previous) => ({ ...previous, surface: checked }));
    },
    [setViewSettings],
  );

  const handleLinesToggle = useCallback(
    (checked: boolean) => {
      setViewSettings((previous) => ({ ...previous, lines: checked }));
    },
    [setViewSettings],
  );

  const handleGizmoToggle = useCallback(
    (checked: boolean) => {
      setViewSettings((previous) => ({ ...previous, gizmo: checked }));
    },
    [setViewSettings],
  );

  const handleGridToggle = useCallback(
    (checked: boolean) => {
      setViewSettings((previous) => ({ ...previous, grid: checked }));
    },
    [setViewSettings],
  );

  const handleAxesHelperToggle = useCallback(
    (checked: boolean) => {
      setViewSettings((previous) => ({ ...previous, axes: checked }));
    },
    [setViewSettings],
  );

  const handleMatcapToggle = useCallback(
    (checked: boolean) => {
      setViewSettings((previous) => ({ ...previous, matcap: checked }));
    },
    [setViewSettings],
  );

  const handleUpDirectionChange = useCallback(
    (value: string) => {
      if (value === 'x' || value === 'y' || value === 'z') {
        setViewSettings((previous) => ({ ...previous, upDirection: value }));
      }
    },
    [setViewSettings],
  );

  const handleRenderTimeoutChange = useCallback(
    (value: string) => {
      const seconds = Number.parseInt(value, 10);
      if (!Number.isNaN(seconds)) {
        setRenderTimeout(seconds);
      }
    },
    [setRenderTimeout],
  );

  // Get current timeout option for display (default to 30s if not found)
  const currentTimeoutOption = useMemo(
    () => timeoutOptions.find((option) => option.value === renderTimeout) ?? defaultTimeoutOption,
    [renderTimeout],
  );

  // Group timeout options for combobox
  const groupedTimeoutOptions = useMemo(() => [{ name: 'Timeout', items: timeoutOptions }], []);

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="overlay" size="icon" className={cn(className)}>
              <Settings />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Viewer settings</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        side="right"
        className="w-64"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
      >
        {!is2dGeometry && (
          <>
            <DropdownMenuLabel>Model</DropdownMenuLabel>
            <DropdownMenuSwitchItem
              className="flex w-full justify-between"
              isChecked={viewSettings.surface}
              onIsCheckedChange={handleMeshToggle}
            >
              <span className="flex items-center gap-2">
                <Box />
                Surfaces
              </span>
            </DropdownMenuSwitchItem>
            <DropdownMenuSwitchItem
              className="flex w-full justify-between"
              isChecked={viewSettings.lines}
              onIsCheckedChange={handleLinesToggle}
            >
              <span className="flex items-center gap-2">
                <PenLine />
                Lines
              </span>
            </DropdownMenuSwitchItem>
            <DropdownMenuSwitchItem
              className="flex h-10 w-full justify-between"
              isChecked={viewSettings.matcap}
              onIsCheckedChange={handleMatcapToggle}
            >
              <span className="flex items-center gap-2">
                <Sparkles />
                <div className="flex flex-col">
                  <span className="flex items-center gap-1">
                    Matcap{' '}
                    <InfoTooltip>
                      A material that gives models a consistent appearance independent of scene lighting.
                      <br /> Rendering performance is improved with this enabled.
                    </InfoTooltip>
                  </span>
                  <span className="text-xs font-medium text-muted-foreground/80">
                    Lighting effects are {viewSettings.matcap ? 'inactive' : 'active'}
                  </span>
                </div>
              </span>
            </DropdownMenuSwitchItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>Viewport</DropdownMenuLabel>
        <DropdownMenuSwitchItem
          className={cn('flex w-full justify-between', is2dGeometry && 'hidden')}
          isChecked={viewSettings.gizmo}
          onIsCheckedChange={handleGizmoToggle}
        >
          <span className="flex items-center gap-2">
            <Rotate3D />
            Gizmo
          </span>
        </DropdownMenuSwitchItem>
        <DropdownMenuSwitchItem
          className="flex w-full justify-between"
          isChecked={viewSettings.grid}
          onIsCheckedChange={handleGridToggle}
        >
          <span className="flex items-center gap-2">
            <Grid3X3 />
            Grid
          </span>
        </DropdownMenuSwitchItem>
        <DropdownMenuSwitchItem
          className="flex w-full justify-between"
          isChecked={viewSettings.axes}
          onIsCheckedChange={handleAxesHelperToggle}
        >
          <span className="flex items-center gap-2">
            <Axis3D />
            Axes
          </span>
        </DropdownMenuSwitchItem>
        {!is2dGeometry && (
          <div className="flex items-center justify-between px-2 py-0.5">
            <span className="flex items-center gap-2 text-sm">
              <ArrowUp className="size-4" />
              Up Direction
            </span>
            <ToggleGroup
              type="single"
              variant="outline"
              value={viewSettings.upDirection}
              className="font-semibold"
              onValueChange={handleUpDirectionChange}
            >
              <ToggleGroupItem value="x" aria-label="X-up" className="h-7 flex-1">
                <span style={{ color: axesColors.x }}>X</span>
              </ToggleGroupItem>
              <ToggleGroupItem value="y" aria-label="Y-up" className="h-7 flex-1">
                <span style={{ color: axesColors.y }}>Y</span>
              </ToggleGroupItem>
              <ToggleGroupItem value="z" aria-label="Z-up" className="h-7 flex-1">
                <span style={{ color: axesColors.z }}>Z</span>
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Performance</DropdownMenuLabel>
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="flex items-center gap-2 text-sm">
            <Timer className="size-4" />
            <span className="flex items-center gap-1">
              Render Timeout
              <InfoTooltip>
                Maximum time to wait for CAD rendering before timing out.
                <br /> Set to &quot;Disabled&quot; to turn off timeout.
              </InfoTooltip>
            </span>
          </span>
          <ComboBoxResponsive
            groupedItems={groupedTimeoutOptions}
            defaultValue={currentTimeoutOption}
            title="Render Timeout"
            description="Select a render timeout duration"
            isSearchEnabled={false}
            popoverProperties={{ align: 'end' }}
            getValue={(option) => String(option.value)}
            renderLabel={(option, selectedOption) => (
              <span className="flex w-full items-center justify-between">
                {option.label}
                {option.value === selectedOption?.value && <Check className="size-4" />}
              </span>
            )}
            onSelect={handleRenderTimeoutChange}
          >
            <Button variant="outline" size="sm" className="h-7 w-20 justify-between">
              <span>{currentTimeoutOption.label}</span>
              <ChevronsUpDown className="size-3 opacity-50" />
            </Button>
          </ComboBoxResponsive>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
