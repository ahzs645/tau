import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import React, { useEffect, useMemo, useRef } from 'react';
import { cn } from '#utils/ui.utils.js';
import { Tabs, TabsList, TabsTrigger, TabsContents } from '#components/ui/tabs.js';
import { Separator } from '#components/ui/separator.js';

export type ResponsiveTabItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  group?: string;
};

type ResponsiveTabsProps = {
  readonly tabs: readonly ResponsiveTabItem[];
  readonly activeTab: string;
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly enableContentAnimation?: boolean;
};

/**
 * Responsive tabs component that switches between:
 * - Mobile: horizontal orientation with flex-col layout (tabs on top, content below)
 * - Desktop: vertical orientation with flex-row layout (tabs on left, content on right)
 *
 * Uses pure CSS via Tailwind responsive utilities (no JS media queries)
 * Automatically scrolls active tab into view on mobile
 */
export function ResponsiveTabs({
  tabs,
  activeTab,
  children,
  className,
  enableContentAnimation = true,
}: ResponsiveTabsProps): React.JSX.Element {
  const tabsListRef = useRef<HTMLDivElement>(null);

  // Scroll active tab into view when activeTab changes
  useEffect(() => {
    if (tabsListRef.current) {
      const activeTabElement = tabsListRef.current.querySelector(`[data-state="active"]`);
      activeTabElement?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      });
    }
  }, [activeTab]);

  const tabsList = useMemo(() => {
    return (
      <>
        <TabsList
          ref={tabsListRef}
          className={cn(
            // Mobile: horizontal scrollable tabs with scroll shadows
            'max-md:w-full max-md:justify-start max-md:scroll-shadows-x',
            'max-md:[scrollbar-width:none]',
            // Enable smooth scrolling with consistent speed
            'max-md:scroll-smooth',
            // Desktop: remove scroll shadows and set width
            'md:mt-14 md:w-fit',
          )}
        >
          {tabs.map((tab, index) => {
            const previousGroup = index > 0 ? tabs[index - 1]!.group : tab.group;
            const showDivider = index > 0 && tab.group !== previousGroup;

            return (
              <React.Fragment key={tab.label}>
                {showDivider && <Separator className='my-1 max-md:hidden' />}
                <TabsTrigger
                  asChild
                  value={tab.label}
                  className={cn(
                    // Mobile: compact horizontal layout
                    'flex-row justify-center gap-2',
                    // Desktop: left-aligned with icon
                    'md:justify-start',
                    // Icon color
                    '[&_svg]:text-muted-foreground',
                  )}
                >
                  <Link to={tab.href}>
                    <tab.icon />
                    {tab.label}
                  </Link>
                </TabsTrigger>
              </React.Fragment>
            );
          })}
        </TabsList>

        <div className='flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto'>
          <h2 className='hidden text-2xl font-bold md:block'>{activeTab}</h2>
          <TabsContents className={cn('w-full')} enableAnimation={enableContentAnimation}>
            {children}
          </TabsContents>
        </div>
      </>
    );
  }, [tabs, activeTab, children, enableContentAnimation]);

  return (
    <>
      {/* Desktop */}
      <Tabs
        orientation='vertical'
        value={activeTab}
        className={cn('hidden md:flex', 'h-full flex-row gap-6', className)}
      >
        {tabsList}
      </Tabs>

      {/* Mobile */}
      <Tabs
        orientation='horizontal'
        value={activeTab}
        className={cn('flex h-full w-full flex-col md:hidden', className)}
      >
        {tabsList}
      </Tabs>
    </>
  );
}
