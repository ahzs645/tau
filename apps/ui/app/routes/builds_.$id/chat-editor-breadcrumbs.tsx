import type { ReactNode } from 'react';
import { Fragment, useMemo, useCallback, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { useSelector } from '@xstate/react';
import { useBuild } from '#hooks/use-build.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { useHorizontalScroll } from '#hooks/use-horizontal-scroll.js';
import { FileExtensionIcon } from '#components/icons/file-extension-icon.js';
import { FileSelector } from '#components/files/file-selector.js';

type ChatEditorBreadcrumbsProperties = {
  readonly filePath: string;
};

export function ChatEditorBreadcrumbs({ filePath }: ChatEditorBreadcrumbsProperties): ReactNode {
  const { editorRef } = useBuild();
  const { fileManagerRef } = useFileManager();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Enable horizontal scrolling with mouse wheel
  useHorizontalScroll(scrollContainerRef);

  // Derive breadcrumb data from the panel's own file path
  const activeFile = useMemo(
    () => ({
      path: filePath,
      parts: filePath.split('/'),
      name: filePath.split('/').pop() ?? '',
    }),
    [filePath],
  );

  // Get file list from file manager for the FileSelector
  const files = useSelector(
    fileManagerRef,
    (state) => {
      const fileTreeMap = state.context.fileTree;
      if (fileTreeMap.size === 0) {
        return [];
      }

      return [...fileTreeMap.values()].map((entry) => ({
        path: entry.path,
      }));
    },
    (previous, current) => {
      // Compare file paths to determine if list changed
      if (previous.length !== current.length) {
        return false;
      }

      const previousPaths = new Set(previous.map((f) => f.path));
      for (const file of current) {
        if (!previousPaths.has(file.path)) {
          return false;
        }
      }

      return true;
    },
  );

  // Handle file selection - opens file in editor
  const handleFileSelect = useCallback(
    (path: string) => {
      editorRef.send({ type: 'openFile', path, source: 'user' });
    },
    [editorRef],
  );

  // Compute breadcrumb data with paths for each segment
  const breadcrumbs = useMemo(() => {
    return activeFile.parts.map((part, index) => ({
      name: part,
      // Full path up to this segment
      path: activeFile.parts.slice(0, index + 1).join('/'),
      // Parent path (directory to show in FileSelector)
      parentPath: index === 0 ? '' : activeFile.parts.slice(0, index).join('/'),
      isLast: index === activeFile.parts.length - 1,
    }));
  }, [activeFile.parts]);

  if (!activeFile.path) {
    return null;
  }

  return (
    <div className="flex flex-row items-center justify-between px-2 py-1 text-muted-foreground">
      <div
        ref={scrollContainerRef}
        className="flex min-w-0 flex-1 flex-row items-center gap-0.5 overflow-x-auto overscroll-x-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {breadcrumbs.length > 0 ? (
          breadcrumbs.map((crumb) => (
            <Fragment key={crumb.path}>
              <FileSelector
                files={files}
                selectedFile={activeFile.path}
                initialPath={crumb.parentPath}
                popoverProperties={{ align: 'start' }}
                onSelect={handleFileSelect}
              >
                <button
                  type="button"
                  className="flex max-w-32 shrink-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-sm font-medium hover:bg-muted"
                >
                  {crumb.isLast ? <FileExtensionIcon filename={crumb.name} className="size-3 shrink-0" /> : undefined}
                  <span className="truncate">{crumb.name}</span>
                </button>
              </FileSelector>
              {crumb.isLast ? undefined : <ChevronRight className="size-4 shrink-0" />}
            </Fragment>
          ))
        ) : (
          // Maintain height with invisible content when empty
          <span className="opacity-0">placeholder</span>
        )}
      </div>
    </div>
  );
}
