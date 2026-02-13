import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { cn } from '#utils/ui.utils.js';

type DockviewPaneActionProperties = {
  readonly className?: string;
  readonly children: ReactNode;
  readonly onClick?: React.MouseEventHandler<HTMLButtonElement>;
  readonly 'aria-label': string;
};

/**
 * Shared button style for Dockview tab-bar actions (e.g. open-file "+", split).
 *
 * Renders a small, centered icon button with consistent sizing, hover colours,
 * and the `.dv-pane-action` CSS class for group-hover opacity transitions.
 * Forwards its ref so it works with `asChild` wrappers (Tooltip, Popover, etc.).
 */
export const DockviewPaneAction = forwardRef<HTMLButtonElement, DockviewPaneActionProperties>(
  ({ className, children, ...properties }, ref): React.JSX.Element => {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          'dv-pane-action flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted-foreground/15 hover:text-foreground',
          className,
        )}
        {...properties}
      >
        {children}
      </button>
    );
  },
);
