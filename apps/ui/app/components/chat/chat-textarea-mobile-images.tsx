import { memo } from 'react';
import { X } from 'lucide-react';
import { ImagePreview, ImagePreviewTrigger, ImagePreviewImage } from '#components/ui/image-preview.js';
import { cn } from '#utils/ui.utils.js';
import { focusTrapAttribute } from '#components/chat/chat-textarea-types.js';

type ChatTextareaMobileImagesProperties = {
  readonly images: string[];
  readonly onRemoveImage: (index: number) => void;
};

/**
 * Mobile image preview component for the chat textarea.
 * Displays compact thumbnails that open in a full-screen dialog when tapped.
 */
export const ChatTextareaMobileImages = memo(function ({
  images,
  onRemoveImage,
}: ChatTextareaMobileImagesProperties): React.JSX.Element | undefined {
  if (images.length === 0) {
    return undefined;
  }

  return (
    <div className='flex flex-wrap gap-1'>
      {images.map((image, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- unique key for each image
        <div key={`image-${index}-${image}`} className='relative'>
          {/* Thumbnail - tap to open dialog */}
          <ImagePreview
            src={image}
            alt={`Uploaded ${index + 1}`}
            dialogProps={{ [focusTrapAttribute]: focusTrapAttribute }}
          >
            <ImagePreviewTrigger>
              <div className='size-8 overflow-hidden rounded-xs border focus:ring-2 focus:ring-primary focus:outline-none'>
                <ImagePreviewImage className='size-full object-cover' />
              </div>
            </ImagePreviewTrigger>
          </ImagePreview>
          {/* Remove button */}
          <button
            type='button'
            className={cn(
              'absolute -top-1 -right-1 flex size-4 items-center justify-center',
              'rounded-full border bg-background text-muted-foreground',
              'hover:text-destructive focus:ring-1 focus:ring-primary focus:outline-none',
            )}
            onClick={(event) => {
              event.stopPropagation();
              onRemoveImage(index);
            }}
          >
            <X className='size-3' />
          </button>
        </div>
      ))}
    </div>
  );
});
