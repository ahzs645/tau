import type { CSSProperties, ReactNode } from 'react';
import { Outlet } from 'react-router';
import { ThemeProvider } from 'remix-themes';
import { ColorProvider } from '#hooks/use-color.js';
import { KeyboardProvider } from '#hooks/use-keyboard.js';
import { FileManagerProvider } from '#hooks/use-file-manager.js';
import type { ThemeWithSystem } from '#hooks/use-theme.js';
import { SidebarStateProvider } from '#components/ui/sidebar.js';
import { TooltipProvider } from '#components/ui/tooltip.js';
import { useTypedMatches } from '#hooks/use-typed-matches.js';
import { cn } from '#utils/ui.utils.js';
import type { Handle } from '#types/matches.types.js';

export const rootHandle: Handle = {};

type RootProvidersProps = {
  readonly children: ReactNode;
  readonly ssrTheme: ThemeWithSystem;
};

export function RootProviders({ children, ssrTheme }: RootProvidersProps): React.JSX.Element {
  return (
    <ThemeProvider specifiedTheme={ssrTheme} themeAction='/action/set-theme'>
      <ColorProvider>
        <TooltipProvider>
          <KeyboardProvider>
            <FileManagerProvider rootDirectory='/' initialBackend='indexeddb'>
              <SidebarStateProvider>{children}</SidebarStateProvider>
            </FileManagerProvider>
          </KeyboardProvider>
        </TooltipProvider>
      </ColorProvider>
    </ThemeProvider>
  );
}

export function RootPage({ error }: { readonly error?: ReactNode }): React.JSX.Element {
  const { enablePageWrapper, enableOverflowY } = useTypedMatches((handles) => ({
    enablePageWrapper: !handles.enablePageWrapper.some((match) => match.handle.enablePageWrapper === false),
    enableOverflowY: handles.enableOverflowY.some((match) => match.handle.enableOverflowY === true),
  }));

  const content = error ?? <Outlet />;
  if (!enablePageWrapper) {
    return <div className='contents'>{content}</div>;
  }

  return (
    <main
      style={{ '--header-height': '0px' } as CSSProperties}
      className={cn('min-h-dvh bg-background text-foreground', enableOverflowY && 'h-dvh overflow-y-auto')}
    >
      {content}
    </main>
  );
}
