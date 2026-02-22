import { useCallback, useMemo } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { Columns2, Copy, FileCode, FolderTree, Rows2, X, XCircle } from 'lucide-react';
import { ContextMenuItem, ContextMenuSeparator } from '#components/ui/context-menu.js';
import {
  closeOtherPanels,
  closePanelsToTheRight,
  closePanelsToTheLeft,
  closeAllPanelsInGroup,
  copyPathToClipboard,
} from '#components/panes/tab-context-menu-actions.js';
import { useBuild } from '#hooks/use-build.js';
import { withTabContextMenu } from '#components/panes/with-tab-context-menu.js';

type ViewerPanelParameters = {
  viewId: string;
  entryFile: string | undefined;
};

/**
 * Context menu content for viewer tabs.
 *
 * Provides close operations, path copying, split controls,
 * and cross-dock navigation (open in editor, reveal in file tree).
 */
function ViewerTabContextMenu(properties: IDockviewPanelHeaderProps): React.JSX.Element {
  const { api, containerApi } = properties;
  const { editorRef } = useBuild();

  const entryFile = (properties.params as ViewerPanelParameters | undefined)?.entryFile;

  const { hasOthers, hasRight, hasLeft } = useMemo(() => {
    const { panels } = api.group;
    const currentIndex = panels.findIndex((panel) => panel.id === api.id);

    return {
      hasOthers: panels.length > 1,
      hasRight: currentIndex < panels.length - 1,
      hasLeft: currentIndex > 0,
    };
  }, [api]);

  // ── Close actions ──
  const handleClose = useCallback(() => {
    api.close();
  }, [api]);

  const handleCloseOthers = useCallback(() => {
    closeOtherPanels(api);
  }, [api]);

  const handleCloseRight = useCallback(() => {
    closePanelsToTheRight(api);
  }, [api]);

  const handleCloseLeft = useCallback(() => {
    closePanelsToTheLeft(api);
  }, [api]);

  const handleCloseAll = useCallback(() => {
    closeAllPanelsInGroup(api);
  }, [api]);

  // ── Copy path ──
  const handleCopyPath = useCallback(() => {
    if (entryFile) {
      void copyPathToClipboard(entryFile);
    }
  }, [entryFile]);

  // ── Split actions ──
  const handleSplitRight = useCallback(() => {
    containerApi.addGroup({
      referenceGroup: api.group,
      direction: 'right',
    });
  }, [api, containerApi]);

  const handleSplitDown = useCallback(() => {
    containerApi.addGroup({
      referenceGroup: api.group,
      direction: 'below',
    });
  }, [api, containerApi]);

  // ── Navigation actions ──
  const handleOpenInEditor = useCallback(() => {
    if (entryFile) {
      editorRef.send({ type: 'openFile', path: entryFile, source: 'user' });
    }
  }, [editorRef, entryFile]);

  const handleRevealInFileTree = useCallback(() => {
    if (entryFile) {
      editorRef.send({ type: 'revealFileInTree', path: entryFile });
    }
  }, [editorRef, entryFile]);

  return (
    <>
      {/* ── Close group ── */}
      <ContextMenuItem onSelect={handleClose}>
        <X />
        Close
      </ContextMenuItem>
      <ContextMenuItem disabled={!hasOthers} onSelect={handleCloseOthers}>
        <XCircle />
        Close Others
      </ContextMenuItem>
      <ContextMenuItem disabled={!hasRight} onSelect={handleCloseRight}>
        Close to the Right
      </ContextMenuItem>
      <ContextMenuItem disabled={!hasLeft} onSelect={handleCloseLeft}>
        Close to the Left
      </ContextMenuItem>
      <ContextMenuItem onSelect={handleCloseAll}>Close All</ContextMenuItem>

      <ContextMenuSeparator />

      {/* ── Copy path ── */}
      <ContextMenuItem disabled={!entryFile} onSelect={handleCopyPath}>
        <Copy />
        Copy Path
      </ContextMenuItem>

      <ContextMenuSeparator />

      {/* ── Split group ── */}
      <ContextMenuItem onSelect={handleSplitRight}>
        <Columns2 />
        Split Right
      </ContextMenuItem>
      <ContextMenuItem onSelect={handleSplitDown}>
        <Rows2 />
        Split Down
      </ContextMenuItem>

      <ContextMenuSeparator />

      {/* ── Navigation group ── */}
      <ContextMenuItem disabled={!entryFile} onSelect={handleOpenInEditor}>
        <FileCode />
        Open in Editor
      </ContextMenuItem>
      <ContextMenuItem disabled={!entryFile} onSelect={handleRevealInFileTree}>
        <FolderTree />
        Reveal in File Tree
      </ContextMenuItem>
    </>
  );
}

/**
 * Viewer tab component with a right-click context menu.
 * Use as `defaultTabComponent` in the viewer Dockview.
 */
export const ViewerDockviewTab = withTabContextMenu(ViewerTabContextMenu);
