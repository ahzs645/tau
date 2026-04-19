import { useState } from 'react';
import type { FileUIPart } from 'ai';
import { File } from 'lucide-react';
import { cn } from '#utils/ui.utils.js';
import { ImagePreview, ImagePreviewTrigger, ImagePreviewImage } from '#components/ui/image-preview.js';

export function ChatMessageFile({ part }: { readonly part: FileUIPart }): React.ReactNode {
  const [imageError, setImageError] = useState(false);
  const isImage = part.mediaType.startsWith('image/');

  // Render images with preview and dialog enlargement on click
  if (isImage && !imageError) {
    return (
      <ImagePreview
        src={part.url}
        alt={part.filename ?? 'Uploaded image'}
        onError={() => {
          setImageError(true);
        }}
      >
        <ImagePreviewTrigger>
          <ImagePreviewImage className='size-12 rounded-lg border bg-background object-contain' />
        </ImagePreviewTrigger>
      </ImagePreview>
    );
  }

  // Render non-image files or failed images as download links
  return (
    <div className='flex items-center gap-2 rounded-lg border bg-background p-3'>
      <File className='size-5 text-muted-foreground' />
      <div className='flex flex-1 flex-col gap-1'>
        <a
          href={part.url}
          download={part.filename}
          className={cn('text-sm font-medium hover:underline', imageError && 'text-destructive')}
          target='_blank'
          rel='noopener noreferrer'
        >
          {part.filename ?? 'File'}
        </a>
        {imageError ? <span className='text-xs text-destructive'>Failed to load image. Click to download.</span> : null}
        <span className='text-xs text-muted-foreground'>{part.mediaType}</span>
      </div>
    </div>
  );
}
