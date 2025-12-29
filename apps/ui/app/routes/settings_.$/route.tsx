import { AccountView, useAuthenticate } from '@daveyplate/better-auth-ui';
import { Link, useLocation } from 'react-router';
import { CreditCard, Key, Lock, Settings2, User } from 'lucide-react';
import { TabsContent } from '#components/ui/tabs.js';
import type { Handle } from '#types/matches.types.js';
import { Button } from '#components/ui/button.js';
import { ResponsiveTabs } from '#components/ui/responsive-tabs.js';
import type { ResponsiveTabItem } from '#components/ui/responsive-tabs.js';
import { GeneralSettings } from '#routes/settings_.$/general-settings.js';

const generalTabs: readonly ResponsiveTabItem[] = [
  {
    label: 'General',
    href: '/settings/general',
    icon: Settings2,
  },
] as const;

const authTabs: readonly ResponsiveTabItem[] = [
  {
    label: 'Account',
    href: '/settings/account',
    icon: User,
  },
  {
    label: 'Security',
    href: '/settings/security',
    icon: Lock,
  },
  {
    label: 'API Keys',
    href: '/settings/api-keys',
    icon: Key,
  },
  // {
  //   tabView: 'ORGANIZATION',
  //   label: 'Organization',
  //   href: '/settings/organization',
  //   icon: Building,
  // },
  // {
  //   tabView: 'MEMBERS',
  //   label: 'Team',
  //   href: '/settings/team',
  //   icon: Users,
  // },
] as const;

const otherTabs: readonly ResponsiveTabItem[] = [
  {
    label: 'Billing',
    href: '/settings/billing',
    icon: CreditCard,
  },
] as const;

const allTabs: readonly ResponsiveTabItem[] = [...generalTabs, ...authTabs, ...otherTabs];

const defaultTab = generalTabs[0]!.label;
const defaultLabel = generalTabs[0]!.label;

export const handle: Handle = {
  breadcrumb() {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- useLocation needed to get current route for breadcrumb
    const location = useLocation();
    const currentTab = allTabs.find((tab) => tab.href === location.pathname);
    const label = currentTab?.label ?? defaultLabel;

    return (
      <Button asChild variant="ghost">
        <Link to={location.pathname}>{label}</Link>
      </Button>
    );
  },
  enableOverflowY: true,
};

export default function SettingsPage(): React.JSX.Element {
  useAuthenticate();
  const location = useLocation();

  // Map pathname to cardView
  const getActiveTab = (): string => {
    const currentTab = allTabs.find((tab) => tab.href === location.pathname);
    return currentTab?.label ?? defaultTab;
  };

  const activeTab = getActiveTab();

  return (
    <div className="mx-auto size-full max-w-4xl flex-1 px-2 md:px-4">
      <ResponsiveTabs tabs={allTabs} activeTab={activeTab} enableContentAnimation={false}>
        {authTabs.map((tab) => (
          <TabsContent key={tab.label} enableAnimation={false} value={tab.label} className="*:md:gap-0">
            <AccountView
              hideNav
              pathname={location.pathname}
              classNames={{ cards: 'h-full', sidebar: { base: 'hidden' }, base: 'h-full pb-6' }}
            />
          </TabsContent>
        ))}
        <TabsContent enableAnimation={false} value="General">
          <GeneralSettings />
        </TabsContent>
        <TabsContent enableAnimation={false} value="Billing">
          <div>Billing - TODO</div>
        </TabsContent>
      </ResponsiveTabs>
    </div>
  );
}
