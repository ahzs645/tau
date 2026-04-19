import { useCallback, useSyncExternalStore } from 'react';
import type { FileEntry } from '@taucad/types';
import { useFileManager } from '#hooks/use-file-manager.js';

const noop = (): void => {
  /* Intentional no-op when subscribe is unavailable (useSyncExternalStore fallback). */
};
const emptyTree = new Map<string, FileEntry>();

/**
 * Reactive hook for the file tree Map. Uses `useSyncExternalStore` for
 * targeted re-renders — only triggers when the tree Map reference changes
 * (on actual tree mutations), unlike `useSelector` which re-evaluates on
 * every machine event.
 */
export function useFileTreeMap(): Map<string, FileEntry> {
  const { treeService } = useFileManager();

  return useSyncExternalStore(
    useCallback((callback: () => void) => treeService?.subscribeTree(callback) ?? noop, [treeService]),
    useCallback(() => treeService?.getTreeSnapshot() ?? emptyTree, [treeService]),
    () => emptyTree,
  );
}

/**
 * Reactive hook for a single file tree entry by path.
 */
export function useFileTreeEntry(path: string | undefined): FileEntry | undefined {
  const tree = useFileTreeMap();
  return path ? tree.get(path) : undefined;
}
