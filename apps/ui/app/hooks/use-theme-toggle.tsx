import { useCallback } from 'react';
import { Theme, useTheme } from 'remix-themes';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';

// Null is used to represent the system theme
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- null is used to represent the system theme, as it's serializable in JSON
export type ThemeWithSystem = Theme | null;

export type ThemeOption = {
  id: ThemeWithSystem;
  name: string;
  description: string;
};

export const themeOptions: ThemeOption[] = [
  {
    id: Theme.LIGHT,
    name: 'Light',
    description: 'A bright, clean look',
  },
  {
    id: Theme.DARK,
    name: 'Dark',
    description: 'Easy on the eyes',
  },
  {
    id: null,
    name: 'System',
    description: 'Follow your system preference',
  },
];

type UseThemeToggleReturn = {
  theme: ThemeWithSystem;
  setTheme: (theme: ThemeWithSystem) => void;
  cycleTheme: () => void;
  currentOption: ThemeOption;
};

export function useThemeToggle(): UseThemeToggleReturn {
  const [, setRemixTheme] = useTheme();
  const [theme, setThemeCookie] = useCookie<ThemeWithSystem>(cookieName.colorTheme, null);

  const setTheme = useCallback(
    (newTheme: ThemeWithSystem) => {
      setRemixTheme(newTheme);
      setThemeCookie(newTheme);
    },
    [setRemixTheme, setThemeCookie],
  );

  const cycleTheme = useCallback(() => {
    let newTheme: ThemeWithSystem;
    if (theme === Theme.LIGHT) {
      newTheme = Theme.DARK;
    } else if (theme === Theme.DARK) {
      newTheme = null;
    } else {
      newTheme = Theme.LIGHT;
    }

    setTheme(newTheme);
  }, [theme, setTheme]);

  const currentOption = themeOptions.find((option) => option.id === theme) ?? themeOptions[2]!;

  return {
    theme,
    setTheme,
    cycleTheme,
    currentOption,
  };
}
