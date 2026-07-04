import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ThemeProvider } from 'remix-themes';
import { Page } from '#components/layout/page.js';
import type { Handle } from '#types/matches.types.js';
import { RootCommandPaletteItems } from '#root-command-items.js';
import { ProjectManagerProvider } from '#hooks/use-project-manager.js';
import { FileManagerProvider } from '#hooks/use-file-manager.js';
import { AnalyticsProvider } from '#hooks/use-analytics.js';
import { KeyboardProvider } from '#hooks/use-keyboard.js';
import { UnloadProvider } from '#hooks/use-flush-on-close.js';
import { ChatSessionStoreProvider } from '#hooks/chat-session-store-provider.js';
import { GlobalChatFlushGuard } from '#components/global-chat-flush-guard.js';
import { ProjectActivityTracker } from '#hooks/project-activity-tracker.js';
import { AuthConfigProvider } from '#providers/auth-provider.js';
import { ColorProvider } from '#hooks/use-color.js';
import { TooltipProvider } from '#components/ui/tooltip.js';
import type { ThemeWithSystem } from '#hooks/use-theme.js';

export const rootHandle: Handle = {
  commandPalette(match) {
    return <RootCommandPaletteItems match={match} />;
  },
};

type RootProvidersProps = {
  readonly children: ReactNode;
  readonly ssrTheme: ThemeWithSystem;
};

/**
 * Extracts a human-readable string from the `error.error.message` payload of a
 * `BetterFetchError` (e.g. `"You can't unlink your last account"`). Falls back
 * to the outer `Error.message` when the inner shape is missing.
 *
 * `BetterFetchError.error` is typed as `any` upstream, so we duck-type the
 * shape here to satisfy the linter without dragging in unsafe-argument noise.
 */
const extractAuthErrorMessage = (error: Error): string => {
  const fromBody = extractBetterFetchErrorBodyMessage(error);
  return fromBody ?? error.message;
};

const extractBetterFetchErrorBodyMessage = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const candidate = (error as { error?: unknown }).error;
  if (!candidate || typeof candidate !== 'object' || !('message' in candidate)) {
    return undefined;
  }
  const { message } = candidate as { message?: unknown };
  return typeof message === 'string' ? message : undefined;
};

export function RootProviders({ children, ssrTheme }: RootProvidersProps): React.JSX.Element {
  const queryClient = useMemo(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { networkMode: 'offlineFirst' },
        mutations: { networkMode: 'offlineFirst' },
      },
    });

    // Surface unhandled better-auth-ui mutation/query errors as toasts. Inline
    // `onError` handlers on individual `useMutation` calls (e.g. sign-in) take
    // precedence and override this default, so we never double-toast.
    client.setMutationDefaults([], {
      onError: (error) => {
        toast.error(extractAuthErrorMessage(error));
      },
    });

    client.getQueryCache().config.onError = (error) => {
      const message = extractBetterFetchErrorBodyMessage(error);
      if (message !== undefined) {
        toast.error(message);
      }
    };

    return client;
  }, []);

  return (
    <AuthConfigProvider>
      <QueryClientProvider client={queryClient}>
        <AnalyticsProvider>
          <FileManagerProvider rootDirectory='/' initialBackend='indexeddb'>
            <ProjectManagerProvider>
              <ThemeProvider specifiedTheme={ssrTheme} themeAction='/action/set-theme'>
                <ColorProvider>
                  <TooltipProvider>
                    <KeyboardProvider>
                      <UnloadProvider>
                        <ChatSessionStoreProvider>
                          <GlobalChatFlushGuard />
                          <ProjectActivityTracker />
                          {children}
                        </ChatSessionStoreProvider>
                      </UnloadProvider>
                    </KeyboardProvider>
                  </TooltipProvider>
                </ColorProvider>
              </ThemeProvider>
            </ProjectManagerProvider>
          </FileManagerProvider>
        </AnalyticsProvider>
      </QueryClientProvider>
    </AuthConfigProvider>
  );
}

export function RootPage({ error }: { readonly error?: ReactNode }): React.JSX.Element {
  return <Page error={error} />;
}
