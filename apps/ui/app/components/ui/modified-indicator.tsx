import { RefreshCcwDot } from 'lucide-react';
import { cn } from '#utils/ui.utils.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';

/**
 * Dot indicator that signals a value has been modified from its default.
 *
 * Renders a small `bg-yellow/50` dot that morphs into a reset icon on hover.
 * Uses its own `group/modified` scope for self-contained hover behavior.
 * Consumers can layer wider hover scopes via `className` targeting
 * `[data-slot=dot]` and `[data-slot=icon]`.
 */
export function ModifiedIndicator({
  onReset,
  tooltip = 'Reset',
  tooltipSide = 'left',
  className,
}: {
  readonly onReset: () => void;
  readonly tooltip?: string;
  readonly tooltipSide?: 'left' | 'right' | 'top' | 'bottom';
  readonly className?: string;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type='button'
          className={cn('group/modified relative flex size-4 shrink-0 items-center justify-center', className)}
          aria-label={tooltip}
          onClick={(event) => {
            event.stopPropagation();
            onReset();
          }}
        >
          <span
            data-slot='dot'
            className='size-1.5 rounded-full bg-yellow transition-opacity group-hover/modified:opacity-0 dark:bg-yellow'
          />
          <RefreshCcwDot
            data-slot='icon'
            className='absolute inset-0 m-auto size-3 text-muted-foreground opacity-0 transition-opacity group-hover/modified:opacity-100'
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
