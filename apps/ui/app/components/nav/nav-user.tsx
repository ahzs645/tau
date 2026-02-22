import { AuthUIContext, SignedIn, SignedOut, UserAvatar } from '@daveyplate/better-auth-ui';
import { CreditCard, LogIn, LogOut, Settings, Sparkles } from 'lucide-react';
import { useContext } from 'react';
import { NavLink } from 'react-router';
import { Button } from '#components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { Loader } from '#components/ui/loader.js';
import { ClientOnly } from '#components/ui/utils/client-only.js';
import { useAuthLinks } from '#hooks/use-auth-links.js';
import { openSettingsDialog } from '#hooks/use-settings-dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.js';

export function NavUser(): React.JSX.Element {
  const { hooks } = useContext(AuthUIContext);
  const { data: session } = hooks.useSession();
  const { signIn, signUp, signOut } = useAuthLinks();

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
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="select-none">
                  <UserAvatar className="size-8 rounded-md" user={session?.user} />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Profile</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" sideOffset={8} className="w-48">
            <DropdownMenuGroup>
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => {
                  openSettingsDialog('billing');
                }}
              >
                <Sparkles />
                Upgrade to Pro
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => {
                  openSettingsDialog('billing');
                }}
              >
                <CreditCard />
                Billing
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => {
                  openSettingsDialog('general');
                }}
              >
                <Settings />
                Settings
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild className="cursor-pointer">
                <NavLink to={signOut}>
                  <LogOut />
                  Sign Out
                </NavLink>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SignedIn>
    </ClientOnly>
  );
}
