import { useSelector } from '@xstate/react';
import { useFileManager } from '#hooks/use-file-manager.js';

type PreviewFileEntry = {
  path: string;
  name: string;
  size: number;
};

/**
 * Hook to read the file list from the file manager for the preview route.
 */
export function usePreviewFileList(): PreviewFileEntry[] {
  const fileManager = useFileManager();

  return useSelector(fileManager.fileManagerRef, (state) => {
    const fileTreeMap = state.context.fileTree;
    if (fileTreeMap.size === 0) {
      return [];
    }

    return [...fileTreeMap.values()].map((entry) => ({
      path: entry.path,
      name: entry.name,
      size: entry.size,
    }));
  });
}
