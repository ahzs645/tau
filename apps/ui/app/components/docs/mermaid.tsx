import { Suspense, use, useEffect, useId, useState } from 'react';
import { Theme, useTheme } from '#hooks/use-theme.js';

const cache = new Map<string, Promise<unknown>>();

async function cachePromise<T>(key: string, setPromise: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) {
    return cached as Promise<T>;
  }

  const promise = setPromise();
  cache.set(key, promise);
  return promise;
}

function MermaidRenderer({ chart }: { readonly chart: string }): React.JSX.Element {
  const id = useId();
  const { theme } = useTheme();
  const { default: mermaid } = use(cachePromise('mermaid', async () => import('mermaid')));

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    fontFamily: 'inherit',
    // eslint-disable-next-line @typescript-eslint/naming-convention -- mermaid API.
    themeCSS: 'margin: 1.5rem auto 0;',
    theme: theme === Theme.DARK ? 'dark' : 'default',
  });

  const { svg, bindFunctions } = use(
    cachePromise(`${chart}-${theme}`, async () => {
      return mermaid.render(id, chart.replaceAll(String.raw`\n`, '\n'));
    }),
  );

  return (
    <div
      ref={(container) => {
        if (container) {
          bindFunctions?.(container);
        }
      }}
      // eslint-disable-next-line react/no-danger -- mermaid API.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * Renders a Mermaid diagram from chart definition text.
 * Only mounts on the client to avoid SSR hydration issues.
 */
export function Mermaid({ chart }: { readonly chart: string }): React.JSX.Element | undefined {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return undefined;
  }

  return (
    <Suspense>
      <MermaidRenderer chart={chart} />
    </Suspense>
  );
}
