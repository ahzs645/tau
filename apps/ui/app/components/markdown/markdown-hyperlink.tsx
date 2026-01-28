import type { ComponentProps } from 'react';
import { Link } from 'react-router';
import { cn } from '#utils/ui.utils.js';
import { ExternalLink } from '#components/external-link.js';

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

  if (isExternal && href) {
    return (
      <ExternalLink href={href} className={className} arrowSize="xs" isArrowOnHoverOnly={false}>
        {children}
      </ExternalLink>
    );
  }

  return (
    <Link
      {...rest}
      to={href ?? ''}
      className={cn(className, 'underline underline-offset-3 transition-all duration-200 hover:underline-offset-4')}
    >
      {children}
    </Link>
  );
}
