import { useCallback, useEffect, useState } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { X } from 'lucide-react';
import { FileExtensionIcon } from '#components/icons/file-extension-icon.js';

/**
 * Custom Dockview tab component that adds a file-extension icon before the title.
 *
 * Reuses the dv-default-tab / dv-default-tab-content / dv-default-tab-action
 * class names so all built-in + theme CSS applies unchanged.
 */
export function DockviewTab(properties: IDockviewPanelHeaderProps): React.JSX.Element {
  const { api } = properties;
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
    <div className="dv-default-tab group/default-tab">
      <span className="dv-default-tab-content flex items-center gap-1.5">
        <FileExtensionIcon filename={title} className="size-3 shrink-0" />
        <span className="truncate">{title}</span>
      </span>
      <div
        className="dv-default-tab-action size-5! rounded-xs! opacity-0 group-hover/default-tab:opacity-100"
        role="button"
        tabIndex={0}
        onClick={handleClose}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.stopPropagation();
            api.close();
          }
        }}
      >
        <X className="size-3.5" />
      </div>
    </div>
  );
}
