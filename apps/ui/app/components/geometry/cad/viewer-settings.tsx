import React, { useCallback, useState, useEffect, useMemo } from 'react';
import type { ClassValue } from 'clsx';
import { Axis3D, Box, Grid3X3, Rotate3D, Settings, PenLine, Sparkles, ArrowUp, Timer } from 'lucide-react';
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
  DropdownMenuSelectItem,
  DropdownMenuToggleGroupItem,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.js';
import { cn } from '#utils/ui.utils.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';
import { InfoTooltip } from '#components/ui/info-tooltip.js';
import { axesColors } from '#constants/color.constants.js';

// Up direction options
type UpDirection = 'x' | 'y' | 'z';

type ViewSettings = {
  surface: boolean;
  lines: boolean;
  gizmo: boolean;
  grid: boolean;
  axes: boolean;
  matcap: boolean;
  upDirection: UpDirection;
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
  { value: 15, label: '15s' },
  { value: 30, label: '30s' },
  { value: 60, label: '1 min' },
  { value: 300, label: '5 min' },
  { value: 600, label: '10 min' },
];

const upDirectionOptions: Array<{ value: UpDirection; label: React.ReactNode; ariaLabel: string }> = [
  { value: 'x', label: <span style={{ color: axesColors.x }}>X</span>, ariaLabel: 'X-up' },
  { value: 'y', label: <span style={{ color: axesColors.y }}>Y</span>, ariaLabel: 'Y-up' },
  { value: 'z', label: <span style={{ color: axesColors.z }}>Z</span>, ariaLabel: 'Z-up' },
];

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
    (value: UpDirection) => {
      setViewSettings((previous) => ({ ...previous, upDirection: value }));
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
    () => timeoutOptions.find((option) => option.value === renderTimeout) ?? timeoutOptions[2]!,
    [renderTimeout],
  );

  const getTimeoutValue = useCallback((option: TimeoutOption): string => String(option.value), []);
  const getTimeoutLabel = useCallback((option: TimeoutOption): string => option.label, []);

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
            <DropdownMenuSwitchItem isChecked={viewSettings.surface} onIsCheckedChange={handleMeshToggle}>
              <Box />
              Surfaces
            </DropdownMenuSwitchItem>
            <DropdownMenuSwitchItem isChecked={viewSettings.lines} onIsCheckedChange={handleLinesToggle}>
              <PenLine />
              Lines
            </DropdownMenuSwitchItem>
            <DropdownMenuSwitchItem
              className="h-10"
              isChecked={viewSettings.matcap}
              onIsCheckedChange={handleMatcapToggle}
            >
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
            </DropdownMenuSwitchItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>Viewport</DropdownMenuLabel>
        <DropdownMenuSwitchItem
          className={cn(is2dGeometry && 'hidden')}
          isChecked={viewSettings.gizmo}
          onIsCheckedChange={handleGizmoToggle}
        >
          <Rotate3D />
          Gizmo
        </DropdownMenuSwitchItem>
        <DropdownMenuSwitchItem isChecked={viewSettings.grid} onIsCheckedChange={handleGridToggle}>
          <Grid3X3 />
          Grid
        </DropdownMenuSwitchItem>
        <DropdownMenuSwitchItem isChecked={viewSettings.axes} onIsCheckedChange={handleAxesHelperToggle}>
          <Axis3D />
          Axes
        </DropdownMenuSwitchItem>
        {!is2dGeometry && (
          <DropdownMenuToggleGroupItem
            value={viewSettings.upDirection}
            options={upDirectionOptions}
            onValueChange={handleUpDirectionChange}
          >
            <ArrowUp />
            Up Direction
          </DropdownMenuToggleGroupItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Rendering</DropdownMenuLabel>
        <DropdownMenuSelectItem
          value={currentTimeoutOption}
          options={timeoutOptions}
          getOptionValue={getTimeoutValue}
          getOptionLabel={getTimeoutLabel}
          infoTooltip={
            <InfoTooltip>
              Maximum time to wait for CAD rendering before timing out.
              <br /> Set to &quot;Disabled&quot; to turn off timeout.
            </InfoTooltip>
          }
          onValueChange={handleRenderTimeoutChange}
        >
          <Timer />
          Timeout
        </DropdownMenuSelectItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
