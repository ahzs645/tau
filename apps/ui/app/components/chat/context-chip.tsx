import { useCallback, useState } from 'react';
import { MessageSquare, Camera, AlertCircle, Folder, BookOpen, X } from 'lucide-react';
import { FileExtensionIcon } from '#components/icons/file-extension-icon.js';
import { cn } from '#utils/ui.utils.js';

export type ChipType = 'file' | 'folder' | 'chat' | 'screenshot' | 'code' | 'skill';

const chipTypeIcons: Record<Exclude<ChipType, 'file'>, React.ComponentType<{ className?: string }>> = {
  folder: Folder,
  chat: MessageSquare,
  screenshot: Camera,
  code: AlertCircle,
  skill: BookOpen,
};

type ContextChipProps = React.ComponentPropsWithRef<'span'> & {
  readonly label: string;
  readonly chipType: ChipType;
  /** When provided, hovering swaps the type icon for an X button that calls this handler. */
  readonly onRemove?: () => void;
  /** Enables pointer cursor and hover background highlight (for clickable chips). */
  readonly isInteractive?: boolean;
};

export function ContextChip({
  label,
  chipType,
  onRemove,
  isInteractive = false,
  className,
  ref,
  ...rest
}: ContextChipProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const Icon = chipType === 'file' ? undefined : chipTypeIcons[chipType];

  const handleRemove = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onRemove?.();
    },
    [onRemove],
  );

  const showRemoveButton = onRemove && hovered;

  const iconElement = showRemoveButton ? (
    <button
      type='button'
      className='flex size-2.5 shrink-0 items-center justify-center'
      onClick={handleRemove}
      aria-label='Remove'
    >
      <X className='size-2.5' />
    </button>
  ) : Icon ? (
    <Icon className='size-2.5 shrink-0' />
  ) : (
    <FileExtensionIcon filename={label} className='size-2.5 shrink-0' />
  );

  const hoverProps = onRemove
    ? {
        onMouseEnter: () => {
          setHovered(true);
        },
        onMouseLeave: () => {
          setHovered(false);
        },
      }
    : undefined;

  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-primary/20 px-1.5 py-0.5 text-xs',
        'bg-primary/10 text-primary select-none',
        isInteractive ? 'cursor-pointer hover:bg-primary/15' : 'cursor-default',
        className,
      )}
      {...hoverProps}
      {...rest}
    >
      {iconElement}
      <span className='max-w-35 truncate'>{label}</span>
    </span>
  );
}
