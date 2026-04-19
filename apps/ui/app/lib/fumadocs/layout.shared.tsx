import type { DocsLayoutProps } from 'fumadocs-ui/layouts/docs';
import { cn } from '#utils/ui.utils.js';
import { DocsSidebarWithTrigger } from '#routes/docs.$/docs-sidebar.js';

export function baseOptions(): Omit<DocsLayoutProps, 'tree'> {
  return {
    nav: {
      enabled: false,
    },
    themeSwitch: {
      enabled: false,
    },
    sidebar: {
      enabled: true,
      component: <DocsSidebarWithTrigger />,
    },
    containerProps: {
      className: cn(
        // Transition
        'transition-[padding] duration-200 ease-linear',
        // Set the sidebar width to account for both the app sidebar and the docs sidebar.
        'md:[--fd-sidebar-width:calc(var(--sidebar-width-current)+var(--docs-sidebar-width-current))]!',
        // Always account for the docs sidebar width on desktop to ensure the page doesn't shift on docs sidebar open/close.
        'xl:[--fd-sidebar-width:calc(var(--sidebar-width-current)+var(--docs-sidebar-width))]!',

        // Banner height accounts for the app header at all breakpoints so fumadocs
        // sticky elements (toc-popover, sidebar, toc panel) position below it.
        '[--fd-banner-height:var(--header-height)]',

        // Mobile ToC Popover Styles (data-toc-popover replaces old #nd-tocnav)
        '[&_[data-toc-popover]]:w-fit',
        '[&_[data-toc-popover]]:ml-auto',
        '[&_[data-toc-popover]]:mr-2',
        '[&_[data-toc-popover]]:border',
        '[&_[data-toc-popover]]:rounded-md',
        '[&_[data-toc-popover]]:overflow-hidden',
        '[&_[data-toc-popover]]:bg-muted',
        '[&_[data-toc-popover]]:h-auto!',
        '[&_[data-toc-popover]]:transition-[top,left,width] [&_[data-toc-popover]]:duration-200 [&_[data-toc-popover]]:ease-linear',
        '[&_[data-toc-popover]_header]:border-b-0',
        '[&_[data-toc-popover-trigger]]:px-2',
        '[&_[data-toc-popover-trigger]]:h-7',
        '[&_[data-toc-popover-trigger]]:text-xs',

        // Top padding on page content so it clears the fixed hamburger + toc-popover
        '[&_#nd-page]:pt-14!',

        // Desktop ToC Styles
        'xl:[--fd-toc-width:var(--docs-sidebar-width)]!',
        '[&_#nd-toc]:border',
        '[&_#nd-toc]:rounded-md',
        '[&_#nd-toc]:bg-sidebar',
        '[&_#nd-toc]:mx-2',
        '[&_#nd-toc]:p-2',
        '[&_#nd-toc]:pb-0!',
        '[&_#nd-toc]:w-(--docs-sidebar-width)',
        '[&_#nd-toc]:h-fit',
        '[&_#nd-toc]:ms-2',
        '[&_#nd-toc]:top-(--header-height)!',
        '[&_#nd-toc]:max-h-[calc(100dvh-var(--header-height)-var(--spacing)*2)]!',
        '[&_#nd-toc]:overflow-y-auto!',
        '[&_#nd-toc]:end-0!',
      ),
    },
  };
}
