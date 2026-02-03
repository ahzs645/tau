import { cva } from 'class-variance-authority';

/**
 * Shared item styling for all menu-like components (dropdown-menu, context-menu, command, select).
 * Uses compact py-1 padding for a tighter, more refined appearance.
 */
export const menuItemVariants = cva(
  // Base: compact py-1 padding, rounded-md, standard disabled states
  "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
  {
    variants: {
      variant: {
        default: '',
        destructive:
          'text-destructive focus:bg-destructive/10 focus:text-destructive dark:focus:bg-destructive/20 *:[svg]:text-destructive!',
      },
      inset: {
        true: 'pl-8', // For items with left indicator (checkbox/radio)
        false: '',
      },
      focusable: {
        true: 'focus:bg-accent focus:text-accent-foreground', // Standard focus states for dropdown/context menus
        false: '', // For cmdk which uses data-[selected=true] instead of focus
      },
    },
    defaultVariants: {
      variant: 'default',
      inset: false,
      focusable: true,
    },
  },
);

/**
 * Content container styling for menu popover/dropdown containers.
 */
export const menuContentVariants = cva(
  'z-50 min-w-32 overflow-hidden rounded-sm border bg-popover p-1 text-popover-foreground shadow-md',
  {
    variants: {
      animated: {
        true: 'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
        false: '',
      },
    },
    defaultVariants: {
      animated: true,
    },
  },
);

/**
 * Label styling for menu section headers.
 */
export const menuLabelVariants = cva('px-2 py-1 text-xs font-medium text-muted-foreground', {
  variants: {
    inset: {
      true: 'pl-8',
      false: '',
    },
  },
  defaultVariants: {
    inset: false,
  },
});

/**
 * Separator styling for menu dividers.
 */
export const menuSeparatorVariants = cva('-mx-1 my-1 h-px bg-border');
