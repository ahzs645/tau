import type { ComponentProps } from 'react';
import { cn } from '#utils/ui.utils.js';

/**
 * Checks if a URL is an external link (starts with http:// or https://).
 */
export function isExternalLink(href: string | undefined): boolean {
  return Boolean(href?.startsWith('http://')) || Boolean(href?.startsWith('https://'));
}

/**
 * Markdown link component that opens external links in a new tab.
 * Internal links (relative paths, anchor links) open in the same tab.
 */
export function MarkdownHyperlink({
  children,
  className,
  href,
  target: _target,
  rel: _rel,
  ...rest
}: ComponentProps<'a'>): React.JSX.Element {
  const isExternal = isExternalLink(href);

  return (
    <a
      {...rest}
      href={href}
      className={cn(className, 'underline underline-offset-3 transition-all duration-200 hover:underline-offset-4')}
      target={isExternal ? '_blank' : undefined}
      rel={isExternal ? 'noopener noreferrer' : undefined}
    >
      {children}
    </a>
  );
}
