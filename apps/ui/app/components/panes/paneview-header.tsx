import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { PaneviewPanelApi } from 'dockview-react';
import { cn } from '#utils/ui.utils.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';

const defaultExpandedHeight = 200;

/**
 * Shared CSS variable overrides for PaneviewReact containers.
 *
 * Sets the built-in `--dv-paneview-header-border-color` for a 1px separator
 * between stacked panels, and configures sash (resize handle) appearance to
 * match the Allotment sash pattern used in the main editor layout.
 */
export const paneviewStyleOverrides = cn(
  'h-full',
  '[--dv-paneview-header-border-color:var(--border)]',
  '[--dv-sash-color:transparent]',
  '[--dv-active-sash-color:var(--primary)]',
  '[--dv-active-sash-transition-duration:0.1s]',
  '[--dv-active-sash-transition-delay:0.5s]',
);

/**
 * Shared header component for PaneviewReact panels.
 *
 * Renders a rotating chevron indicator and toggles panel expansion on click.
 * When expanding a collapsed panel, sets a default body height so content is
 * immediately visible.
 */
export function PaneviewHeader({
  api,
  title,
  children,
  actions,
}: {
  readonly api: PaneviewPanelApi;
  readonly title: string;
  readonly children?: React.ReactNode;
  /** Trailing content shown only when the panel is expanded. */
  readonly actions?: React.ReactNode;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(api.isExpanded);

  useEffect(() => {
    const disposable = api.onDidExpansionChange(({ isExpanded }) => {
      setExpanded(isExpanded);
    });
    return () => {
      disposable.dispose();
    };
  }, [api]);

  const handleClick = useCallback(() => {
    const next = !expanded;
    api.setExpanded(next);
    if (next) {
      api.setSize({ size: defaultExpandedHeight });
    }
  }, [api, expanded]);

  return (
    <div
      role='button'
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleClick();
        }
      }}
      className='flex h-full w-full cursor-pointer items-center gap-1 pr-2 pl-1 select-none'
    >
      <ChevronRight
        className={cn(
          'size-3 shrink-0 text-muted-foreground transition-transform duration-200',
          expanded && 'rotate-90',
        )}
      />
      <span className='truncate text-xs font-medium text-foreground'>{title}</span>
      {children !== undefined || (expanded && actions !== undefined) ? (
        <div
          className='ml-auto flex items-center gap-1'
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          {children}
          {expanded ? actions : undefined}
        </div>
      ) : undefined}
    </div>
  );
}

/**
 * Compact icon button for paneview panel headers.
 *
 * Sized at 20px (`size-5`) with ghost hover styling to fit the ~22px header
 * row. Wraps in a `Tooltip` when the `tooltip` prop is provided.
 */
export function PaneviewHeaderAction({
  tooltip,
  tooltipSide = 'top',
  className,
  children,
  ...properties
}: React.ComponentProps<'button'> & {
  readonly tooltip?: React.ReactNode;
  readonly tooltipSide?: 'left' | 'right' | 'top' | 'bottom';
}): React.JSX.Element {
  const button = (
    <button
      type='button'
      className={cn(
        'flex size-5 items-center justify-center rounded-sm',
        'text-muted-foreground transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'disabled:pointer-events-none disabled:opacity-50',
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3",
        'shrink-0 select-none',
        className,
      )}
      {...properties}
    >
      {children}
    </button>
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

/**
 * Flex container for grouping trailing items (selectors, action buttons)
 * inside a `PaneviewHeader` children slot.
 */
export function PaneviewHeaderActionGroup({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  return <div className={cn('flex items-center gap-1', className)}>{children}</div>;
}
