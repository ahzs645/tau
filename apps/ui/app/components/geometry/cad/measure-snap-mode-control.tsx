import { Asterisk, Circle, Minus, Square } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '#components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { cn } from '#utils/ui.utils.js';
import { useGraphics, useGraphicsSelector } from '#hooks/use-graphics.js';
import type { MeasureSnapMode } from '#machines/graphics.machine.js';

const snapModes: ReadonlyArray<{ mode: MeasureSnapMode; label: string; icon: LucideIcon }> = [
  { mode: 'all', label: 'Snap to any feature', icon: Asterisk },
  { mode: 'vertex', label: 'Snap to vertices', icon: Circle },
  { mode: 'edge', label: 'Snap to edge midpoints', icon: Minus },
  { mode: 'face', label: 'Snap to face centers', icon: Square },
];

/**
 * Vertex / edge / face pick-mode selector for the measure tool, mirroring the
 * feature-select modes of desktop CAD measure tools. Renders nothing while the
 * measure tool is inactive.
 */
export function MeasureSnapModeControl({ className }: { readonly className?: string }): React.ReactNode {
  const graphicsRef = useGraphics();
  const isMeasureActive = useGraphicsSelector((state) => state.context.isMeasureActive);
  const measureSnapMode = useGraphicsSelector((state) => state.context.measureSnapMode);

  if (!isMeasureActive) {
    return undefined;
  }

  return (
    <div className={cn('flex flex-col gap-1 rounded-md', className)}>
      {snapModes.map(({ mode, label, icon: Icon }) => (
        <Tooltip key={mode}>
          <TooltipTrigger asChild>
            <Button
              variant='overlay'
              size='icon'
              data-active={measureSnapMode === mode ? 'true' : 'false'}
              className='size-7 data-[active=true]:bg-accent data-[active=true]:text-primary'
              onClick={() => {
                graphicsRef.send({ type: 'setMeasureSnapMode', payload: mode });
              }}
            >
              <Icon className='size-3.5' />
            </Button>
          </TooltipTrigger>
          <TooltipContent side='right'>{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
