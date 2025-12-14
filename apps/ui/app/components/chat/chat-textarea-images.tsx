import { memo } from 'react';
import { X } from 'lucide-react';
import { HoverCard, HoverCardContent, HoverCardPortal, HoverCardTrigger } from '#components/ui/hover-card.js';
import { Button } from '#components/ui/button.js';
import { cn } from '#utils/ui.utils.js';

type ChatTextareaImagesProperties = {
  readonly images: string[];
  readonly onRemoveImage: (index: number) => void;
};

/**
 * Shared image preview overlay component for the chat textarea.
 * Displays uploaded images with hover preview and remove functionality.
 */
export const ChatTextareaImages = memo(function ({
  images,
  onRemoveImage,
}: ChatTextareaImagesProperties): React.JSX.Element | null {
  if (images.length === 0) {
    return null;
  }

  return (
    <div className="absolute top-3 right-3 left-3 flex flex-wrap gap-1">
      {images.map((image, index) => (
        <div key={image} className="group/image-item relative text-muted-foreground hover:text-foreground">
          <HoverCard openDelay={100} closeDelay={100}>
            <HoverCardTrigger asChild>
              <div className="flex h-6 cursor-zoom-in items-center justify-center overflow-hidden rounded-xs border bg-background object-cover">
                <img src={image} alt="Uploaded" className="size-6 border-r object-cover" />
                <span className="px-1 text-xs">Image</span>
              </div>
            </HoverCardTrigger>
            <HoverCardPortal>
              <HoverCardContent side="top" align="start" className="size-auto max-w-screen overflow-hidden p-0">
                <img src={image} alt="Uploaded" className="h-48 object-cover md:h-96" />
              </HoverCardContent>
            </HoverCardPortal>
          </HoverCard>
          <Button
            size="icon"
            className={cn(
              'absolute top-1/2 left-0 z-10 size-6 -translate-y-1/2 rounded-none rounded-l-xs border border-r-0',
              'hidden group-hover/image-item:flex',
            )}
            aria-label="Remove image"
            type="button"
            onClick={() => {
              onRemoveImage(index);
            }}
          >
            <X className="size-3! stroke-2" />
          </Button>
        </div>
      ))}
    </div>
  );
});
