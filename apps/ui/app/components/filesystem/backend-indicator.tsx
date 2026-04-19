/**
 * Shared filesystem backend indicator.
 *
 * Shows an icon with a tooltip label describing the active storage backend.
 * Used in project cards, chat details, and settings panels.
 */

import type { FileSystemBackend } from '@taucad/types';
import { filesystemBackendMeta } from '@taucad/types/constants';
import { Database, HardDrive, FolderOpen, MemoryStick } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { cn } from '#utils/ui.utils.js';

/** Icon mapping for each filesystem backend. */
export const backendIcons: Record<FileSystemBackend, typeof Database> = {
  indexeddb: Database,
  opfs: HardDrive,
  webaccess: FolderOpen,
  memory: MemoryStick,
};

export function BackendIndicator({
  backend,
  className,
}: {
  readonly backend: FileSystemBackend;
  readonly className?: string;
}): React.JSX.Element {
  const Icon = backendIcons[backend];
  const meta = filesystemBackendMeta[backend];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex', className)}>
          <Icon className='size-3.5 text-muted-foreground' />
        </span>
      </TooltipTrigger>
      <TooltipContent>{meta.label}</TooltipContent>
    </Tooltip>
  );
}
