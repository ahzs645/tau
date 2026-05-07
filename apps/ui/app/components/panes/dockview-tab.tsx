import { useCallback, useEffect, useState } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { Box, X } from 'lucide-react';
import { FileExtensionIcon } from '#components/icons/file-extension-icon.js';

export type DockviewTabProps = IDockviewPanelHeaderProps & {
  /**
   * Viewer tabs use the same cube glyph as {@link ViewerLink} / chat viewer
   * affordances; editor tabs keep extension-based icons.
   */
  readonly leadingIcon?: 'extension' | 'viewer';
};

/**
 * Custom Dockview tab component that adds a leading icon before the title.
 *
 * Reuses the dv-default-tab / dv-default-tab-content / dv-default-tab-action
 * class names so all built-in + theme CSS applies unchanged.
 */
export function DockviewTab(properties: DockviewTabProps): React.JSX.Element {
  const { api, leadingIcon = 'extension' } = properties;
  const [title, setTitle] = useState(api.title ?? '');

  // Keep title in sync when the panel updates it
  useEffect(() => {
    const disposable = api.onDidTitleChange((event) => {
      setTitle(event.title);
    });

    return () => {
      disposable.dispose();
    };
  }, [api]);

  const handleClose = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      api.close();
    },
    [api],
  );

  return (
    <div className='dv-default-tab group/default-tab'>
      <span className='dv-default-tab-content flex items-center gap-1.5'>
        {leadingIcon === 'viewer' ? (
          <Box aria-hidden className='relative -bottom-px size-3 shrink-0' />
        ) : (
          <FileExtensionIcon filename={title} className='size-3 shrink-0' />
        )}
        <span className='truncate'>{title}</span>
      </span>
      <div
        className='dv-default-tab-action size-5! rounded-xs! opacity-0 group-hover/default-tab:opacity-100'
        role='button'
        tabIndex={0}
        onClick={handleClose}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.stopPropagation();
            api.close();
          }
        }}
      >
        <X className='size-3.5' />
      </div>
    </div>
  );
}
