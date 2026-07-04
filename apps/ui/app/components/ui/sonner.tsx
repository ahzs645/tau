import { Toaster as Sonner } from 'sonner';
import { useTheme } from '#hooks/use-theme.js';
import { useIsMobile } from '#hooks/use-mobile.js';

type ToasterProperties = React.ComponentProps<typeof Sonner>;

const mobileToastOffset: NonNullable<ToasterProperties['mobileOffset']> = {
  top: 'calc(env(safe-area-inset-top) + var(--header-height, 3.3rem) + var(--spacing) * 4)',
  right: 'calc(var(--spacing) * 3)',
  bottom: 'calc(env(safe-area-inset-bottom) + 7rem)',
  left: 'calc(var(--spacing) * 3)',
};

const mobileSwipeDirections: NonNullable<ToasterProperties['swipeDirections']> = ['bottom', 'left', 'right'];

function Toaster({
  closeButton,
  mobileOffset,
  offset,
  position,
  swipeDirections,
  ...properties
}: ToasterProperties): React.JSX.Element {
  const { theme } = useTheme();
  const isMobile = useIsMobile();

  return (
    <Sonner
      theme={theme as ToasterProperties['theme']}
      className='toaster group'
      position={position ?? (isMobile ? 'bottom-center' : undefined)}
      closeButton={closeButton ?? (isMobile ? true : undefined)}
      offset={offset ?? (isMobile ? mobileToastOffset : undefined)}
      mobileOffset={mobileOffset ?? mobileToastOffset}
      swipeDirections={swipeDirections ?? (isMobile ? mobileSwipeDirections : undefined)}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:[--border-radius:var(--radius-lg)] group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
        },
      }}
      {...properties}
    />
  );
}

export { Toaster };
// oxlint-disable-next-line no-barrel-files/no-barrel-files -- keeping all toast exports in one file
export { toast } from 'sonner';
