import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from 'react-router';
import { Links, Meta, Scripts, ScrollRestoration, useRouteLoaderData } from 'react-router';
import { PreventFlashOnWrongTheme } from 'remix-themes';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { throwRedirectIfSubdomain } from '#lib/react-router.lib.js';
import { useTheme } from '#hooks/use-theme.js';
import type { ThemeWithSystem } from '#hooks/use-theme.js';
import { getEnvironment } from '#environment.config.js';
import { metaConfig } from '#constants/meta.constants.js';
import { cn } from '#utils/ui.utils.js';
import { Toaster } from '#components/ui/sonner.js';
import { webManifestHref } from '#routes/manifest[.webmanifest].js';
import { useColor } from '#hooks/use-color.js';
import { useFavicon } from '#hooks/use-favicon.js';
import { ErrorPage } from '#components/error-page.js';
import { globalStylesLinks } from '#styles/global.styles.js';
import { SvgSpriteMount } from '#components/icons/svg-sprite-mount.js';
import { useAppVersionCheck } from '#hooks/use-app-version-check.js';
import { themeSessionResolver } from '#sessions.server.js';
import { rootHandle, RootPage, RootProviders } from '#root-shell.js';

export const links: LinksFunction = () => [...globalStylesLinks];

export const meta: MetaFunction = () => [
  { title: metaConfig.name },
  { name: 'description', content: metaConfig.description },
  // oxlint-disable-next-line tau-lint/no-hardcoded-color -- browser meta tag
  { name: 'theme-color', content: '#ffffff' },
  { name: 'apple-mobile-web-app-title', content: metaConfig.name },
  { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
  { name: 'apple-mobile-web-app-capable', content: 'yes' },
  { name: 'mobile-web-app-capable', content: 'yes' },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
  { rel: 'icon', href: '/favicon.ico', sizes: 'any' },
  { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
];

// oxlint-disable-next-line unicorn-js/prefer-export-from -- no-barrel-files forbids re-exporting from the shell module.
export const handle = rootHandle;

// oxlint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- loaders require type inference
export async function loader({ request }: LoaderFunctionArgs) {
  // Redirect www to apex domain (e.g., www.example.new -> example.new)
  throwRedirectIfSubdomain(request, 'www');

  const { getTheme } = await themeSessionResolver(request);
  const cookie = request.headers.get('Cookie') ?? '';

  return {
    theme: getTheme(),
    cookie,
    env: await getEnvironment(),
  };
}

export function Layout({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const data = useRouteLoaderData<typeof loader>('root');
  // Preserve null for system theme - remix-themes needs null to detect system preference
  const ssrTheme = data?.theme ?? null;

  return (
    <RootProviders ssrTheme={ssrTheme}>
      <LayoutDocument env={data?.env ?? {}} ssrTheme={ssrTheme}>
        {children}
      </LayoutDocument>
    </RootProviders>
  );
}

function LayoutDocument({
  children,
  env,
  ssrTheme,
}: {
  readonly children: ReactNode;
  readonly env: Record<string, string | boolean | undefined>;
  readonly ssrTheme: ThemeWithSystem;
}): React.JSX.Element {
  useAppVersionCheck();
  // Use ssrTheme (the raw resolved theme) for the HTML className.
  // This is null during SSR when no theme preference is stored (system theme mode),
  // which allows PreventFlashOnWrongTheme's script to correctly detect and apply the
  // system preference before the page renders (prevents light mode flash on dark systems).
  const { ssrTheme: resolvedTheme } = useTheme();
  const color = useColor();
  const { setFaviconColor } = useFavicon();

  useEffect(() => {
    setFaviconColor(color.serialized.hex);
  }, [setFaviconColor, color]);

  const publicBasePath = getPublicBasePath(env['TAU_FRONTEND_URL']);

  return (
    <html
      lang='en'
      className={cn(
        '[--spacing:0.275rem] md:[--spacing:0.25rem]',
        // Leave this class last as the `PreventFlashOnWrongTheme` script will
        // append the theme last when needed to prevent light mode flash on dark systems.
        resolvedTheme,
      )}
      style={color.rootStyles}
    >
      <head>
        <meta charSet='utf-8' />
        <meta name='viewport' content='width=device-width, initial-scale=1' />
        <Meta />
        <PreventFlashOnWrongTheme ssrTheme={ssrTheme !== null} />
        <Links />
        <link rel='manifest' href={`${publicBasePath}${webManifestHref}`} />
      </head>
      <body>
        <script
          // oxlint-disable-next-line react/no-danger -- safe for environment injection as recommended by Remix
          dangerouslySetInnerHTML={{
            __html: `window.ENV = ${JSON.stringify(env)}`,
          }}
        />
        <SvgSpriteMount />
        {children}
        <ScrollRestoration />
        <Scripts />
        <Toaster />
      </body>
    </html>
  );
}

function getPublicBasePath(frontendUrl: string | boolean | undefined): string {
  if (typeof frontendUrl !== 'string') {
    return '';
  }

  try {
    const { pathname } = new URL(frontendUrl);
    return pathname === '/' ? '' : pathname.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export default function App(): React.JSX.Element {
  return <RootPage />;
}

export function ErrorBoundary(): React.JSX.Element {
  return <RootPage error={<ErrorPage />} />;
}
