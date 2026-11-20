import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Laptop, Moon, Sun } from 'lucide-react';
import { Button } from '@taucad/ui/components/button';

type Theme = 'light' | 'dark' | 'system';
type GalleryTheme = { readonly theme: Theme; readonly colorScheme: 'light' | 'dark'; readonly cycle: () => void };
const storageKey = 'tau-gallery-theme';
const ThemeContext = createContext<GalleryTheme | undefined>(undefined);

const readTheme = (): Theme => {
  try {
    const stored = globalThis.localStorage.getItem(storageKey);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
};

export const GalleryThemeProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [systemDark, setSystemDark] = useState(() => globalThis.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const media = globalThis.matchMedia('(prefers-color-scheme: dark)');
    const update = (event: MediaQueryListEvent): void => {
      setSystemDark(event.matches);
    };
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
    };
  }, []);
  const colorScheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  useEffect(() => {
    document.documentElement.classList.toggle('dark', colorScheme === 'dark');
    document.documentElement.dataset['colorScheme'] = colorScheme;
  }, [colorScheme]);
  const cycle = useCallback(() => {
    setTheme((previous) => {
      const next = previous === 'system' ? 'light' : previous === 'light' ? 'dark' : 'system';
      try {
        globalThis.localStorage.setItem(storageKey, next);
      } catch {
        /* Theme remains usable when browser storage is disabled. */
      }
      return next;
    });
  }, []);
  const value = useMemo(() => ({ theme, colorScheme, cycle }), [theme, colorScheme, cycle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useGalleryTheme = (): GalleryTheme => {
  const theme = useContext(ThemeContext);
  if (!theme) {
    throw new Error('Gallery theme controls require GalleryThemeProvider.');
  }
  return theme;
};

export const ThemeToggle = (): React.JSX.Element => {
  const { theme, cycle } = useGalleryTheme();
  const Icon = theme === 'system' ? Laptop : theme === 'dark' ? Moon : Sun;
  return (
    <Button
      variant='outline'
      size='icon-touch'
      onClick={cycle}
      aria-label={`Change theme, currently ${theme}`}
      title={`Theme: ${theme}`}
    >
      <Icon aria-hidden />
    </Button>
  );
};
