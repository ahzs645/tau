import { AuthUIContext, SignedIn, SignedOut, UserAvatar, UserButton } from '@daveyplate/better-auth-ui';
import type { UserButtonProps } from '@daveyplate/better-auth-ui';
import { CreditCard, LogIn, Settings, Sparkles } from 'lucide-react';
import { useContext } from 'react';
import { NavLink } from 'react-router';
import { Button } from '#components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { Loader } from '#components/ui/loader.js';
import { ClientOnly } from '#components/ui/utils/client-only.js';
import { useAuthLinks } from '#hooks/use-auth-links.js';

const additionalUserButtonLinks: UserButtonProps['additionalLinks'] = [
  {
    href: '/settings/billing',
    label: 'Upgrade to Pro',
    icon: <Sparkles />,
    signedIn: true,
  },
  {
    href: '/settings/billing',
    label: 'Billing',
    icon: <CreditCard />,
    signedIn: true,
  },
  {
    href: '/settings/general',
    label: 'Settings',
    icon: <Settings />,
    signedIn: true,
  },
];

export function NavUser(): React.JSX.Element {
  const { hooks } = useContext(AuthUIContext);
  const { data: session } = hooks.useSession();
  const { signIn, signUp } = useAuthLinks();

  return (
    <ClientOnly>
      <SignedOut>
        <Button asChild variant="overlay" className="hidden select-none lg:flex">
          <NavLink to={signIn} tabIndex={-1}>
            {({ isPending }) => (isPending ? <Loader /> : 'Sign In')}
          </NavLink>
        </Button>
        <Button asChild className="hidden select-none">
          <NavLink to={signUp} tabIndex={-1}>
            {({ isPending }) => (isPending ? <Loader /> : 'Sign Up')}
          </NavLink>
        </Button>
        <Button asChild size="icon" variant="overlay" className="text-primary select-none lg:hidden">
          <NavLink to={signIn} tabIndex={-1}>
            {({ isPending }) => (isPending ? <Loader /> : <LogIn />)}
          </NavLink>
        </Button>
      </SignedOut>
      <SignedIn>
        <Tooltip>
          <UserButton
            disableDefaultLinks
            trigger={
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="select-none">
                  <UserAvatar className="size-8 rounded-md" user={session?.user} />
                </Button>
              </TooltipTrigger>
            }
            size="icon"
            classNames={{ content: { menuItem: 'cursor-pointer' } }}
            additionalLinks={additionalUserButtonLinks}
          />
          <TooltipContent>Profile</TooltipContent>
        </Tooltip>
      </SignedIn>
    </ClientOnly>
  );
}
