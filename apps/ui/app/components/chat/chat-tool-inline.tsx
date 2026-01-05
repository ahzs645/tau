import type { LucideIcon } from 'lucide-react';
import { LoaderCircle } from 'lucide-react';
import { Badge } from '#components/ui/badge.js';
import { AnimatedShinyText } from '#components/magicui/animated-shiny-text.js';
import { cn } from '#utils/ui.utils.js';

type ChatToolInlineStatus = 'loading' | 'success' | 'error';

type ChatToolInlineProps = {
  readonly children: React.ReactNode;
  readonly status?: ChatToolInlineStatus;
  readonly icon?: LucideIcon;
  readonly className?: string;
  /**
   * Custom image to show instead of icon (e.g., favicon).
   */
  readonly image?: {
    src: string;
    alt: string;
  };
};

/**
 * Simple inline component for tool status badges and links.
 *
 * @example
 * // Loading state
 * <ChatToolInline status="loading" icon={File}>
 *   Reading main.kcl...
 * </ChatToolInline>
 *
 * // Success state
 * <ChatToolInline status="success" icon={Check}>
 *   Deleted file.kcl
 * </ChatToolInline>
 *
 * // With favicon image
 * <ChatToolInline status="success" image={{ src: faviconUrl, alt: domain }}>
 *   Visited google.com
 * </ChatToolInline>
 */
export function ChatToolInline({
  children,
  status = 'success',
  icon: Icon,
  className,
  image,
}: ChatToolInlineProps): React.JSX.Element {
  const isLoading = status === 'loading';
  const isError = status === 'error';

  return (
    <Badge
      variant={isError ? 'destructive' : 'outline'}
      className={cn('flex max-w-full flex-row items-center gap-2', className)}
    >
      {isLoading ? (
        <>
          <LoaderCircle className="size-3 shrink-0 animate-spin text-inherit" />
          <AnimatedShinyText className="truncate">{children}</AnimatedShinyText>
        </>
      ) : (
        <>
          {image ? (
            <img src={image.src} alt={image.alt} className="size-3 shrink-0 rounded-full" />
          ) : Icon ? (
            <Icon className={cn('size-3 shrink-0', isError ? 'text-destructive' : 'text-muted-foreground')} />
          ) : undefined}
          <span className="truncate">{children}</span>
        </>
      )}
    </Badge>
  );
}

type ChatToolInlineLinkProps = {
  readonly children: React.ReactNode;
  readonly status?: 'loading' | 'ready';
  readonly onClick?: (event: React.MouseEvent) => void;
  readonly className?: string;
};

/**
 * Inline link component for clickable file/path references.
 *
 * @example
 * <ChatToolInlineLink status="loading" onClick={handleClick}>
 *   Reading main.kcl L1-10...
 * </ChatToolInlineLink>
 *
 * <ChatToolInlineLink status="ready" onClick={handleClick}>
 *   Read main.kcl L1-10
 * </ChatToolInlineLink>
 */
export function ChatToolInlineLink({
  children,
  status = 'ready',
  onClick,
  className,
}: ChatToolInlineLinkProps): React.JSX.Element {
  const isLoading = status === 'loading';

  return (
    <span className={cn('text-sm text-muted-foreground', isLoading && 'animate-shiny-text', className)}>
      {isLoading ? (
        <AnimatedShinyText>{children}</AnimatedShinyText>
      ) : (
        <button
          type="button"
          className="cursor-pointer text-muted-foreground/80 underline-offset-2 hover:text-primary hover:underline"
          onClick={onClick}
        >
          {children}
        </button>
      )}
    </span>
  );
}
