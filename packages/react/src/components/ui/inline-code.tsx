import type { ComponentProps } from 'react';
import { cn } from '#utils/ui.utils.js';

/**
 * Inline `<code>` chip. Local to this package so the parameters panel does not
 * pull in the app's shiki-backed code viewer just for field-name styling.
 */
export function InlineCode({ children, className, ...rest }: ComponentProps<'code'>): React.JSX.Element {
  return (
    <code
      {...rest}
      data-slot='inline-code'
      className={cn(
        className,
        'rounded-xs border bg-neutral/10 px-1 py-0 font-normal text-foreground/80 before:content-none after:content-none',
      )}
    >
      {children}
    </code>
  );
}
