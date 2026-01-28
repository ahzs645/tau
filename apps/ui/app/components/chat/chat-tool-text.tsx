import { cn } from '#utils/ui.utils.js';

// ============================================================================
// ChatToolAction
// ============================================================================

type ChatToolActionProps = {
  readonly children: React.ReactNode;
  readonly className?: string;
};

/**
 * Inline component for the action verb in tool displays (e.g., "Read", "Listed", "Visited").
 * Used in both card and inline tool components for consistent styling.
 *
 * @example
 * <ChatToolAction>Read</ChatToolAction>
 * <ChatToolAction>Listed</ChatToolAction>
 */
export function ChatToolAction({ children, className }: ChatToolActionProps): React.JSX.Element {
  return <span className={cn('font-medium text-foreground/60', className)}>{children}</span>;
}

// ============================================================================
// ChatToolDescription
// ============================================================================

type ChatToolDescriptionProps = {
  readonly children: React.ReactNode;
  readonly className?: string;
};

/**
 * Inline component for the description in tool displays (e.g., path, duration, count).
 * Used in both card and inline tool components for consistent styling.
 *
 * @example
 * <ChatToolDescription>main.kcl L1-10</ChatToolDescription>
 * <ChatToolDescription>for 2.5s</ChatToolDescription>
 */
export function ChatToolDescription({ children, className }: ChatToolDescriptionProps): React.JSX.Element {
  return <span className={cn('text-foreground/50', className)}>{children}</span>;
}
