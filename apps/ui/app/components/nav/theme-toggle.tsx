import { Laptop, Moon, Sun } from 'lucide-react';
import { SidebarMenuButton } from '#components/ui/sidebar.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { useKeydown } from '#hooks/use-keydown.js';
import { KeyShortcut } from '#components/ui/key-shortcut.js';
import { useThemeToggle } from '#hooks/use-theme-toggle.js';

export function ThemeToggle(): React.JSX.Element {
  const { theme, cycleTheme } = useThemeToggle();

  const { formattedKeyCombination } = useKeydown(
    {
      key: 'u',
      metaKey: true,
    },
    cycleTheme,
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <SidebarMenuButton
          className="group relative w-auto overflow-hidden"
          data-theme={theme ?? 'system'}
          onClick={cycleTheme}
        >
          <Sun className="h-[1.2rem] w-[1.2rem] origin-right -translate-x-[400%] rotate-[-180deg] transition-transform duration-500 group-data-[theme=light]:translate-x-0 group-data-[theme=light]:rotate-0" />
          <Moon className="absolute h-[1.2rem] w-[1.2rem] origin-left translate-x-[400%] rotate-[180deg] transition-transform duration-500 group-data-[theme=dark]:translate-x-0 group-data-[theme=dark]:rotate-0" />
          <Laptop className="absolute h-[1.2rem] w-[1.2rem] origin-top translate-y-[400%] transition-transform duration-500 group-data-[theme=system]:translate-y-0" />
          <span className="sr-only">Toggle theme</span>
        </SidebarMenuButton>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex items-center gap-2 align-baseline">
        Toggle theme{' '}
        <KeyShortcut variant="tooltip" className="ml-1">
          {formattedKeyCombination}
        </KeyShortcut>
      </TooltipContent>
    </Tooltip>
  );
}
