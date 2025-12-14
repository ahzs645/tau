import { useState } from 'react';
import type { FileUIPart } from 'ai';
import { File } from 'lucide-react';
import { cn } from '#utils/ui.utils.js';
import { Dialog, DialogContent, DialogTrigger } from '#components/ui/dialog.js';

export function ChatMessageFile({ part }: { readonly part: FileUIPart }): React.ReactNode {
  const [imageError, setImageError] = useState(false);
  const isImage = part.mediaType.startsWith('image/');
  const [open, setOpen] = useState(false);

  // Render images with preview and dialog enlargement on click
  if (isImage && !imageError) {
    // Use inline component, or if hoisting is preferred, move it outside.
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <img
            src={part.url}
            alt={part.filename ?? 'Uploaded image'}
            className="size-12 cursor-pointer rounded-lg border bg-background object-contain"
            loading="lazy"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
            }}
            onError={() => {
              setImageError(true);
            }}
          />
        </DialogTrigger>
        {open ? (
          <DialogContent className="flex aspect-auto max-h-[80vh]! max-w-[80vw]! items-center justify-center overflow-hidden rounded-lg border bg-transparent p-0 shadow-none">
            <img
              src={part.url}
              alt={part.filename ?? 'Uploaded image'}
              className="size-full rounded-lg bg-background object-cover"
              onError={() => {
                setImageError(true);
              }}
            />
          </DialogContent>
        ) : null}
      </Dialog>
    );
  }

  // Render non-image files or failed images as download links
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-background p-3">
      <File className="size-5 text-muted-foreground" />
      <div className="flex flex-1 flex-col gap-1">
        <a
          href={part.url}
          download={part.filename}
          className={cn('text-sm font-medium hover:underline', imageError && 'text-destructive')}
          target="_blank"
          rel="noopener noreferrer"
        >
          {part.filename ?? 'File'}
        </a>
        {imageError ? <span className="text-xs text-destructive">Failed to load image. Click to download.</span> : null}
        <span className="text-xs text-muted-foreground">{part.mediaType}</span>
      </div>
    </div>
  );
}
