import { useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useSelector } from '@xstate/react';
import { useBuild } from '#hooks/use-build.js';
import { useHorizontalScroll } from '#hooks/use-horizontal-scroll.js';
import { Button } from '#components/ui/button.js';
import { cn } from '#utils/ui.utils.js';
import { FloatingPanelContentHeader } from '#components/ui/floating-panel.js';
import { FileExtensionIcon } from '#components/icons/file-extension-icon.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';

export function ChatEditorTabs(): React.JSX.Element {
  const { editorRef, gitRef } = useBuild();

  const openFiles = useSelector(editorRef, (state) => state.context.openFiles);
  const activeFilePath = useSelector(editorRef, (state) => state.context.activeFilePath);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Get git statuses for display
  const gitStatuses = useSelector(gitRef, (state) => state.context.fileStatuses);

  const handleTabClick = useCallback(
    (path: string) => {
      editorRef.send({ type: 'setActiveFile', path });
    },
    [editorRef],
  );

  const handleTabClose = useCallback(
    (event: React.MouseEvent, path: string) => {
      event.stopPropagation();
      editorRef.send({ type: 'closeFile', path });
    },
    [editorRef],
  );

  // Enable horizontal scrolling with mouse wheel
  useHorizontalScroll(scrollContainerRef);

  // Scroll a tab into view by path
  const scrollToTab = useCallback((path: string) => {
    if (!scrollContainerRef.current) {
      return;
    }

    const tab = scrollContainerRef.current.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (tab) {
      tab.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
    }
  }, []);

  // Scroll active tab into view when it changes
  useEffect(() => {
    if (activeFilePath) {
      scrollToTab(activeFilePath);
    }
  }, [activeFilePath, scrollToTab]);

  // Subscribe to fileOpened events to scroll to tab even when file is already active
  useEffect(() => {
    const subscription = editorRef.on('fileOpened', (event) => {
      scrollToTab(event.path);
    });

    return subscription.unsubscribe;
  }, [editorRef, scrollToTab]);

  return (
    <FloatingPanelContentHeader className="pl-0">
      <div
        ref={scrollContainerRef}
        className="z-40 -mb-px h-7.75 overflow-x-auto overflow-y-hidden overscroll-x-none [scrollbar-width:none]"
      >
        <div className="flex h-full w-max">
          {openFiles.map((file) => {
            const gitStatus = gitStatuses.get(file.path)?.status;
            const isActive = activeFilePath === file.path;

            return (
              <div key={file.path} data-path={file.path} className="flex h-full">
                <div
                  className={cn(
                    'group/editor-tab flex h-full min-w-0 cursor-pointer items-center gap-0 border-y border-y-transparent pr-1 pl-3 text-sm transition-colors',
                    isActive ? 'bg-background text-foreground' : 'text-muted-foreground',
                  )}
                  role="tab"
                  tabIndex={0}
                  aria-selected={isActive}
                  onClick={() => {
                    handleTabClick(file.path);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      handleTabClick(file.path);
                    }
                  }}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex max-w-32 items-center gap-1.5 truncate">
                        <FileExtensionIcon filename={file.name} className="size-3 shrink-0" />
                        <span className="truncate">{file.name}</span>
                        {gitStatus && gitStatus !== 'clean' ? (
                          <span
                            aria-label={`File has git changes: ${gitStatus}`}
                            className="size-1.5 shrink-0 rounded-full bg-yellow"
                            title={`Git status: ${gitStatus}`}
                          />
                        ) : null}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{file.path}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className={cn(
                          'ml-1 size-6 rounded-sm p-0 transition-opacity hover:bg-primary/20',
                          isActive ? 'opacity-100' : 'opacity-0 group-hover/editor-tab:opacity-100',
                        )}
                        aria-label={`Close ${file.name}`}
                        onClick={(event) => {
                          handleTabClose(event, file.path);
                        }}
                      >
                        <X className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Close</TooltipContent>
                  </Tooltip>
                </div>
                <div className="h-full w-px bg-border" />
              </div>
            );
          })}
        </div>
      </div>
    </FloatingPanelContentHeader>
  );
}
