import type { ReactNode } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '#utils/ui.utils.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';

type TooltipSide = 'left' | 'right' | 'top' | 'bottom';

type PaneButtonProps = React.ComponentProps<'button'> & {
  readonly asChild?: boolean;
  readonly tooltip?: ReactNode;
  readonly tooltipSide?: TooltipSide;
};

/**
 * Shared icon-button primitive for panel headers (Dockview tab-bar actions,
 * floating-panel header buttons, etc.).
 *
 * Renders a small (24 px), centered button with consistent sizing, hover
 * colours, focus ring, and disabled state. Accepts `ref` as a regular prop
 * (React 19) and supports `asChild` via Radix `Slot` for composition with
 * triggers (DropdownMenuTrigger, PopoverTrigger, etc.).
 *
 * An optional `tooltip` prop wraps the button in a Tooltip automatically.
 */
function PaneButton({
  asChild = false,
  tooltip,
  tooltipSide = 'top',
  className,
  ...properties
}: PaneButtonProps): React.JSX.Element {
  const Comp = asChild ? Slot : 'button';

  const button = (
    <Comp
      type={asChild ? undefined : 'button'}
      className={cn(
        'flex size-6 items-center justify-center rounded-sm',
        'text-muted-foreground transition-colors',
        'hover:bg-muted-foreground/15 hover:text-foreground',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'disabled:pointer-events-none disabled:opacity-50',
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        'shrink-0 select-none',
        className,
      )}
      {...properties}
    />
  );

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side={tooltipSide}>{tooltip}</TooltipContent>
      </Tooltip>
    );
  }

  return button;
}

export { PaneButton };
export type { PaneButtonProps };
