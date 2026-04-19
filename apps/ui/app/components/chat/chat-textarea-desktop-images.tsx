import { memo } from 'react';
import { X } from 'lucide-react';
import { ImagePreview, ImagePreviewTrigger, ImagePreviewImage } from '#components/ui/image-preview.js';
import { Button } from '#components/ui/button.js';
import { cn } from '#utils/ui.utils.js';
import { focusTrapAttribute } from '#components/chat/chat-textarea-types.js';

type ChatTextareaImagesProperties = {
  readonly images: string[];
  readonly onRemoveImage: (index: number) => void;
};

/**
 * Shared image preview overlay component for the chat textarea.
 * Displays uploaded images with click-to-preview and remove functionality.
 */
export const ChatTextareaDesktopImages = memo(function ({
  images,
  onRemoveImage,
}: ChatTextareaImagesProperties): React.JSX.Element | undefined {
  if (images.length === 0) {
    return undefined;
  }

  return (
    <div className='absolute top-3 right-3 left-3 flex flex-wrap gap-1'>
      {images.map((image, index) => (
        <div
          // oxlint-disable-next-line react/no-array-index-key -- unique key for each image
          key={`image-${index}-${image}`}
          className='group/image-item relative text-muted-foreground hover:text-foreground'
        >
          <ImagePreview src={image} alt='Uploaded' dialogProps={{ [focusTrapAttribute]: focusTrapAttribute }}>
            <ImagePreviewTrigger>
              <div className='flex h-6 cursor-pointer items-center justify-center overflow-hidden rounded-xs border bg-background hover:bg-accent'>
                <ImagePreviewImage className='size-6 border-r object-cover' />
                <span className='px-1 text-xs'>Image</span>
              </div>
            </ImagePreviewTrigger>
          </ImagePreview>
          <Button
            size='icon'
            className={cn(
              'absolute top-1/2 left-0 z-10 size-6 -translate-y-1/2 rounded-none rounded-l-xs border border-r-0',
              'hidden group-hover/image-item:flex',
            )}
            aria-label='Remove image'
            type='button'
            onClick={() => {
              onRemoveImage(index);
            }}
          >
            <X className='size-3! stroke-2' />
          </Button>
        </div>
      ))}
    </div>
  );
});
