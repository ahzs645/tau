import { Box } from 'lucide-react';
import { useGraphicsSelector } from '#hooks/use-graphics.js';
import { cn } from '#utils/ui.utils.js';

function formatLength(value: number, factor: number): string {
  const scaled = value * factor;
  const rounded = Math.round(scaled * 100) / 100;
  return String(rounded);
}

/**
 * Live readout of placed measurements: overall distance plus per-axis deltas,
 * like desktop viewer measure panels. Renders nothing while the measure tool
 * is inactive or no measurements exist.
 */
export function MeasureReadout({ className }: { readonly className?: string }): React.ReactNode {
  const isMeasureActive = useGraphicsSelector((state) => state.context.isMeasureActive);
  const measurements = useGraphicsSelector((state) => state.context.measurements);
  const lengthFactor = useGraphicsSelector((state) => state.context.units.length.factor);
  const lengthSymbol = useGraphicsSelector((state) => state.context.units.length.symbol);

  if (!isMeasureActive || measurements.length === 0) {
    return undefined;
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-md border bg-background/80 px-2.5 py-2 font-mono text-xs shadow-sm backdrop-blur-sm',
        className,
      )}
    >
      {measurements.map((measurement, index) => {
        const deltas = [0, 1, 2].map((axis) =>
          Math.abs((measurement.endPoint[axis] ?? 0) - (measurement.startPoint[axis] ?? 0)),
        );
        return (
          <div key={measurement.id} className='flex items-baseline gap-2.5'>
            <span className='text-muted-foreground'>{index + 1}.</span>
            <span className='font-semibold'>
              {formatLength(measurement.distance, lengthFactor)} {lengthSymbol}
            </span>
            <span className='text-muted-foreground'>
              ΔX {formatLength(deltas[0]!, lengthFactor)} · ΔY {formatLength(deltas[1]!, lengthFactor)} · ΔZ{' '}
              {formatLength(deltas[2]!, lengthFactor)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Bounding-box dimensions chip (W × D × H in display units) for the loaded
 * model. Renders nothing until the scene bounds are known.
 */
export function ModelSizeIndicator({ className }: { readonly className?: string }): React.ReactNode {
  const sceneSize = useGraphicsSelector((state) => state.context.sceneSize);
  const lengthFactor = useGraphicsSelector((state) => state.context.units.length.factor);
  const lengthSymbol = useGraphicsSelector((state) => state.context.units.length.symbol);

  if (!sceneSize || sceneSize.every((axis) => axis <= 0)) {
    return undefined;
  }

  return (
    <div
      className={cn(
        'flex w-fit items-center gap-1.5 rounded-md border bg-background/80 px-2 py-1 font-mono text-xs text-muted-foreground shadow-sm backdrop-blur-sm',
        className,
      )}
    >
      <Box className='size-3.5' aria-hidden />
      <span>
        {sceneSize.map((axis) => formatLength(axis, lengthFactor)).join(' × ')} {lengthSymbol}
      </span>
    </div>
  );
}
