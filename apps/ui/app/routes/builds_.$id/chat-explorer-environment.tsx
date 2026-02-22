import { useCallback } from 'react';
import { Sun, Lightbulb, Cloud, Zap } from 'lucide-react';
import { useSelector } from '@xstate/react';
import { useMainGraphics, useBuild } from '#hooks/use-build.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';
import type { EnvironmentPreset } from '#constants/editor.constants.js';
import { cn } from '#utils/ui.utils.js';

const presets: Array<{
  id: EnvironmentPreset;
  label: string;
  description: string;
  icon: typeof Sun;
}> = [
  {
    id: 'studio',
    label: 'Studio',
    description: 'Full lighting rig with reflections',
    icon: Sun,
  },
  {
    id: 'neutral',
    label: 'Neutral',
    description: 'Reduced intensity, minimal reflections',
    icon: Lightbulb,
  },
  {
    id: 'soft',
    label: 'Soft',
    description: 'Hemisphere lighting, no environment',
    icon: Cloud,
  },
  {
    id: 'performance',
    label: 'Performance',
    description: 'Minimal lights for best performance',
    icon: Zap,
  },
];

export function ChatEditorExplorerEnvironment(): React.JSX.Element {
  const { viewGraphics } = useBuild();
  const mainGraphicsRef = useMainGraphics();
  const currentPreset = useSelector(mainGraphicsRef, (state) => state?.context.environmentPreset ?? 'studio');
  const [, setEnvironmentCookie] = useCookie(cookieName.viewerEnvironment, 'studio');

  const handlePresetChange = useCallback(
    (preset: EnvironmentPreset) => {
      // Send to ALL viewer panels so every view updates
      for (const graphicsRef of viewGraphics.values()) {
        graphicsRef.send({ type: 'setEnvironmentPreset', payload: preset });
      }

      setEnvironmentCookie(preset);
    },
    [viewGraphics, setEnvironmentCookie],
  );

  return (
    <div className="flex flex-col gap-0.5 px-2 py-1">
      {presets.map((preset) => {
        const isActive = currentPreset === preset.id;
        const Icon = preset.icon;

        return (
          <button
            key={preset.id}
            type="button"
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
              isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50',
            )}
            onClick={() => {
              handlePresetChange(preset.id);
            }}
          >
            <Icon className="size-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{preset.label}</div>
              <div className="truncate text-[10px] opacity-60">{preset.description}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
