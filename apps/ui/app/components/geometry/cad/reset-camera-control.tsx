import { Focus } from 'lucide-react';
import { Button } from '#components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { useGraphics } from '#hooks/use-graphics.js';

/**
 * Reset camera control button.
 * Uses the per-view graphics actor from GraphicsProvider.
 */
export function ResetCameraControl(): React.JSX.Element {
  const graphicsRef = useGraphics();

  const handleReset = (): void => {
    graphicsRef.send({ type: 'resetCamera' });
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="overlay" size="icon" onClick={handleReset}>
          <Focus className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Reset camera</TooltipContent>
    </Tooltip>
  );
}
