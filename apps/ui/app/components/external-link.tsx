import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '#utils/ui.utils.js';

type ExternalLinkProps = {
  readonly href: string;
  readonly children: ReactNode;
  readonly className?: string;
  /**
   * Whether to show the arrow icon on hover.
   * @default true
   */
  readonly withArrow?: boolean;
  /**
   * Size of the arrow icon.
   * @default 'sm'
   */
  readonly arrowSize?: 'xs' | 'sm' | 'md';
};

const arrowSizeClasses = {
  xs: 'size-3',
  sm: 'size-4',
  md: 'size-5',
} as const;

export function ExternalLink({
  href,
  children,
  className,
  withArrow = true,
  arrowSize = 'sm',
}: ExternalLinkProps): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'group/external-link inline-flex items-center gap-1 underline decoration-muted-foreground/50 underline-offset-2 transition-colors hover:decoration-foreground',
        className,
      )}
    >
      {children}
      {withArrow ? (
        <ArrowUpRight
          className={cn(
            arrowSizeClasses[arrowSize],
            '-translate-x-1 opacity-0 transition-all group-hover/external-link:translate-x-0 group-hover/external-link:opacity-100',
          )}
        />
      ) : undefined}
    </a>
  );
}
