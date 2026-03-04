import { Pipette } from 'lucide-react';
import { ColorPicker } from '#components/ui/color-picker.js';
import { Button } from '#components/ui/button.js';
import { cn } from '#utils/ui.utils.js';
import { useColor } from '#hooks/use-color.js';

export function ColorToggle(): React.JSX.Element {
  const { hue, setHue, resetHue } = useColor();

  return (
    <ColorPicker
      value={{ h: hue, s: 100, l: 75 }}
      onReset={resetHue}
      onChange={(value) => {
        setHue(value.h);
      }}
    >
      <Button
        variant='ghost'
        size='icon'
        className={cn(
          'size-7 overflow-hidden border-none bg-transparent shadow-none ring-sidebar-ring! dark:bg-transparent',
          // Active styles - show primary color when popover is open
          'data-[state=open]:bg-primary hover:data-[state=open]:bg-primary',
          // Text styles
          'data-[state=open]:text-primary-foreground hover:data-[state=open]:text-primary-foreground',
        )}
      >
        <Pipette className='size-4' />
      </Button>
    </ColorPicker>
  );
}
