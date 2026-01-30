import { useCallback, useState, useRef, useMemo, useEffect, memo } from 'react';
import { flushSync } from 'react-dom';
import type { ItemInstance } from '@headless-tree/core';
import {
  FilePlus,
  FolderPlus,
  MoreHorizontal,
  Trash2,
  Copy,
  Upload,
  FileEdit,
  Search,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  CopyMinus,
} from 'lucide-react';
import { useSelector } from '@xstate/react';
import { minimatch } from 'minimatch';
import {
  syncDataLoaderFeature,
  selectionFeature,
  hotkeysCoreFeature,
  dragAndDropFeature,
  keyboardDragAndDropFeature,
  renamingFeature,
  searchFeature,
  expandAllFeature,
  propMemoizationFeature,
} from '@headless-tree/core';
import { useTree, AssistiveTreeDescription } from '@headless-tree/react';
import { kernelConfigurations } from '@taucad/types/constants';
import type { KernelConfiguration } from '@taucad/types/constants';
import type { FileItem } from '#machines/file-explorer.machine.js';
import { cn } from '#utils/ui.utils.js';
import { Button, buttonVariants } from '#components/ui/button.js';
import { SearchInput } from '#components/search-input.js';
import { toast } from '#components/ui/sonner.js';
import {
  FloatingPanelContent,
  FloatingPanelContentBody,
  FloatingPanelContentHeader,
  FloatingPanelContentHeaderActions,
  FloatingPanelContentTitle,
} from '#components/ui/floating-panel.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#components/ui/alert-dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '#components/ui/dropdown-menu.js';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator,
} from '#components/ui/context-menu.js';
import { useBuild } from '#hooks/use-build.js';
import { EmptyItems } from '#components/ui/empty-items.js';
import { HighlightText } from '#components/highlight-text.js';
import { FileExtensionIcon, getIconIdFromExtension } from '#components/icons/file-extension-icon.js';
import { getFileExtension, encodeTextFile } from '#utils/filesystem.utils.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';

type TreeItemData = {
  path: string;
  name: string;
  isFolder: boolean;
  content?: Uint8Array<ArrayBuffer>;
  gitStatus?: FileItem['gitStatus'];
};

const rootId = '';
const defaultHiddenPatterns = ['.gitkeep', '**/.gitkeep'];

type PendingFolder = {
  parentPath: string; // '' for root
  error: string | undefined;
};

type PendingFile = {
  parentPath: string; // '' for root
  extension: string;
  defaultName: string;
  content: string;
  error: string | undefined;
};

function isHiddenFile(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern));
}

// Helper to read all entries from a directory (may require multiple calls)
async function readAllDirectoryEntries(dirReader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const entries: FileSystemEntry[] = [];
  let batch: FileSystemEntry[];
  do {
    // eslint-disable-next-line no-await-in-loop -- Must read batches sequentially
    batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      dirReader.readEntries(resolve, reject);
    });
    entries.push(...batch);
  } while (batch.length > 0);

  return entries;
}

// Recursively process a FileSystemEntry (file or directory)
async function processFileSystemEntry(
  entry: FileSystemEntry,
  basePath: string,
): Promise<Array<{ file: File; relativePath: string }>> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject);
    });
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
    return [{ file, relativePath }];
  }

  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    const children = await readAllDirectoryEntries(dirEntry.createReader());
    const results: Array<{ file: File; relativePath: string }> = [];
    for (const child of children) {
      // eslint-disable-next-line no-await-in-loop -- Must process entries sequentially
      const childResults = await processFileSystemEntry(child, dirPath);
      results.push(...childResults);
    }

    return results;
  }

  return [];
}

// Process all items from a DataTransfer object
async function processDataTransferItems(
  items: DataTransferItemList,
): Promise<Array<{ file: File; relativePath: string }>> {
  const results: Array<{ file: File; relativePath: string }> = [];
  const entries: FileSystemEntry[] = [];

  // Collect all entries first (must be done synchronously before promises)
  for (const item of items) {
    if (item.kind === 'file') {
      const entry = item.webkitGetAsEntry();
      if (entry) {
        entries.push(entry);
      }
    }
  }

  // Process entries
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop -- Must process entries sequentially
    const entryResults = await processFileSystemEntry(entry, '');
    results.push(...entryResults);
  }

  return results;
}

type ChatEditorFileTreeProps = {
  readonly enableSearch?: boolean;
  readonly onSearchChange?: (isOpen: boolean) => void;
};

export const ChatEditorFileTree = memo(function ({
  enableSearch = false,
  onSearchChange,
}: ChatEditorFileTreeProps): React.JSX.Element {
  // It's necessary to opt out of React Compiler auto-memoization for this component due to:
  // https://headless-tree.lukasbach.com/guides/react-compiler/
  'use no memo'; // Opt out of React Compiler memoization
  const { buildRef, fileExplorerRef, gitRef, cadRef } = useBuild();
  const buildId = useSelector(buildRef, (state) => state.context.buildId);
  const fileManager = useFileManager();
  const { fileManagerRef, readFile, writeFile, renameFile, deleteFile } = fileManager;

  useEffect(() => {
    // FileExplorer → FileManager → CAD coordination
    const fileOpenedSub = fileExplorerRef.on('fileOpened', (event) => {
      // Read file directly - this properly awaits the worker call
      void readFile(event.path);

      // Only send setFile when switching to a different file
      // This prevents unnecessary re-renders when clicking on an already open file
      // Content changes from editor/chat tools trigger setFile separately
      const currentFile = cadRef.getSnapshot().context.file;
      if (currentFile?.filename !== event.path) {
        cadRef.send({
          type: 'setFile',
          file: { path: `/builds/${buildId}`, filename: event.path },
        });
      }
    });

    // Build loaded → Open initial file
    const buildLoadedSub = buildRef.on('buildLoaded', (event) => {
      const mainFile = event.build.assets.mechanical?.main;
      if (mainFile) {
        fileExplorerRef.send({ type: 'openFile', path: mainFile, source: 'machine' });
      }
    });

    // Event-driven toasts for file operations
    const fileRenamedSub = fileManagerRef.on('fileRenamed', (event) => {
      const oldName = event.oldPath.split('/').pop() ?? event.oldPath;
      const newName = event.newPath.split('/').pop() ?? event.newPath;
      if (oldName === newName) {
        toast.success(`Moved: ${newName}`);
      } else {
        toast.success(`Renamed: ${oldName} → ${newName}`);
      }
    });

    const fileDeletedSub = fileManagerRef.on('fileDeleted', (event) => {
      // Only show toast for user operations (user-initiated deletes)
      if (event.source === 'user') {
        const fileName = event.path.split('/').pop() ?? event.path;
        toast.success(`Deleted: ${fileName}`);
      }
    });

    const fileWrittenSub = fileManagerRef.on('fileWritten', (event) => {
      // Only show toast for user operations (user-initiated creates/uploads)
      if (event.source === 'user') {
        const fileName = event.path.split('/').pop() ?? event.path;
        // Check if it's a .gitkeep (folder creation marker)
        if (fileName === '.gitkeep') {
          const folderPath = event.path.replace('/.gitkeep', '');
          const folderName = folderPath.split('/').pop() ?? folderPath;
          toast.success(`Created folder: ${folderName}`);
        } else {
          toast.success(`Created: ${fileName}`);
        }
      }
    });

    return () => {
      fileOpenedSub.unsubscribe();
      buildLoadedSub.unsubscribe();
      fileRenamedSub.unsubscribe();
      fileDeletedSub.unsubscribe();
      fileWrittenSub.unsubscribe();
    };
  }, [buildRef, fileExplorerRef, fileManagerRef, cadRef, buildId, readFile]);

  // Derive file tree from file-manager (reactive selector)
  // Use custom equality to prevent unnecessary re-renders
  const fileTree = useSelector(
    fileManagerRef,
    (state): FileItem[] => {
      const fileTreeMap = state.context.fileTree;
      if (fileTreeMap.size === 0) {
        return [];
      }

      const gitSnapshot = gitRef.getSnapshot();
      const { fileStatuses } = gitSnapshot.context;

      // Convert Map to array and filter for files only (not directories)
      return (
        [...fileTreeMap.values()]
          // .filter((entry) => entry.type === 'file')
          .map((entry) => ({
            id: entry.path,
            name: entry.name,
            path: entry.path,
            content: new Uint8Array(), // Placeholder - actual content in openFiles
            language: getIconIdFromExtension(getFileExtension(entry.path)),
            isDirectory: false,
            gitStatus: fileStatuses.get(entry.path)?.status,
          }))
      );
    },
    (previous, current) => {
      // Compare file paths and git statuses to determine if tree changed
      if (previous.length !== current.length) {
        return false;
      }

      const previousPaths = new Set(previous.map((f) => f.path));
      const currentPaths = new Set(current.map((f) => f.path));

      if (previousPaths.size !== currentPaths.size) {
        return false;
      }

      for (const path of currentPaths) {
        if (!previousPaths.has(path)) {
          return false;
        }
      }

      return true;
    },
  );

  const activeFilePath = useSelector(fileExplorerRef, (state) => state.context.activeFilePath);
  const openFiles = useSelector(fileExplorerRef, (state) => state.context.openFiles);

  // Tree state management
  const [expandedItems, setExpandedItems] = useState<string[]>(() => [rootId]);
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [focusedItem, setFocusedItem] = useState<string | undefined>(undefined);
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
  const hiddenFilePatterns = useMemo(() => defaultHiddenPatterns, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadTargetPath, setUploadTargetPath] = useState<string | undefined>(undefined);
  const [pendingFolder, setPendingFolder] = useState<PendingFolder | undefined>(undefined);
  const [pendingFile, setPendingFile] = useState<PendingFile | undefined>(undefined);
  const pendingFileInputRef = useRef<HTMLInputElement>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [itemsToDelete, setItemsToDelete] = useState<string[]>([]);

  // Build virtual folder structure from flat file paths
  const allPaths = useMemo(() => {
    const paths = new Set<string>();
    paths.add(rootId);

    for (const file of fileTree) {
      const parts = file.path.split('/');
      let currentPath = '';

      for (const part of parts) {
        if (!part) {
          continue;
        }

        currentPath = currentPath ? `${currentPath}/${part}` : part;
        paths.add(currentPath);
      }
    }

    return paths;
  }, [fileTree]);

  // Data loader for headless-tree
  const dataLoader = useMemo(
    () => ({
      getItem(itemId: string): TreeItemData {
        if (itemId === rootId) {
          return { path: rootId, name: 'Root', isFolder: true };
        }

        const file = fileTree.find((f) => f.path === itemId);
        if (file) {
          return {
            path: file.path,
            name: file.name,
            isFolder: false,
            content: file.content,
            gitStatus: file.gitStatus,
          };
        }

        // Virtual folder
        const name = itemId.split('/').pop() ?? itemId;
        return { path: itemId, name, isFolder: true };
      },

      getChildren(itemId: string): string[] {
        const prefix = itemId === rootId ? '' : `${itemId}/`;
        const children = [...allPaths].filter((path) => {
          if (path === rootId || path === itemId) {
            return false;
          }

          const relativePath = prefix ? path.slice(prefix.length) : path;
          if (!relativePath || path === prefix) {
            return false;
          }

          // Check if this is an immediate child
          const isImmediateChild = prefix
            ? path.startsWith(prefix) && !relativePath.includes('/')
            : !path.includes('/');

          return isImmediateChild;
        });

        // Filter hidden files
        const filtered = showHiddenFiles
          ? children
          : children.filter((path) => !isHiddenFile(path, hiddenFilePatterns));

        // Sort alphabetically (folders first, then files)
        return filtered.sort((a, b) => {
          const aName = a.split('/').pop() ?? a;
          const bName = b.split('/').pop() ?? b;
          const aIsFolder = allPaths.has(a) && fileTree.every((f) => f.path !== a);
          const bIsFolder = allPaths.has(b) && fileTree.every((f) => f.path !== b);

          // Folders first
          if (aIsFolder && !bIsFolder) {
            return -1;
          }

          if (!aIsFolder && bIsFolder) {
            return 1;
          }

          // Then alphabetically
          return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
        });
      },
    }),
    [fileTree, allPaths, showHiddenFiles, hiddenFilePatterns],
  );

  // Initialize headless-tree
  const tree = useTree<TreeItemData>({
    rootItemId: rootId,
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().isFolder,
    dataLoader,
    state: { expandedItems, selectedItems, focusedItem: focusedItem ?? null },
    setExpandedItems,
    setSelectedItems,
    setFocusedItem(value) {
      if (typeof value === 'function') {
        setFocusedItem((old) => {
          const result = value(old ?? null);
          return result ?? undefined;
        });
      } else {
        setFocusedItem(value ?? undefined);
      }
    },
    canReorder: true,
    indent: 16,
    async onDrop(draggedItems, target) {
      // Handle drag-and-drop by renaming files to new paths
      const targetPath = target.item.getId();

      // Determine target folder based on drop type
      let targetFolder = '';
      if (targetPath === rootId) {
        // Dropping on root folder
        targetFolder = '';
      } else if (target.item.isFolder()) {
        targetFolder = targetPath;
      } else {
        // Dropped on a file, use its parent folder
        const parts = targetPath.split('/');
        parts.pop();
        targetFolder = parts.join('/');
      }

      // Move each dragged item
      for (const item of draggedItems) {
        const oldPath = item.getId();
        const fileName = oldPath.split('/').pop() ?? oldPath;
        const newPath = targetFolder ? `${targetFolder}/${fileName}` : fileName;

        if (oldPath === newPath) {
          continue;
        }

        // Move file/folder in fileManager - awaits worker call
        // eslint-disable-next-line no-await-in-loop -- Sequential rename required for consistency
        await renameFile(oldPath, newPath);

        // Update file explorer paths atomically (no close/open to avoid fallback behavior)
        fileExplorerRef.send({ type: 'renameFile', oldPath, newPath });
      }
    },
    onRename(item, newName) {
      const oldPath = item.getId();
      if (oldPath === rootId) {
        return;
      }

      const parts = oldPath.split('/');
      parts[parts.length - 1] = newName;
      const newPath = parts.join('/');

      if (item.isFolder()) {
        // Remember if folder was expanded
        const wasExpanded = item.isExpanded();

        // Rename the folder directly - LightningFS supports directory rename natively
        void renameFile(oldPath, newPath);

        // Update file explorer paths atomically (no close/open to avoid fallback behavior)
        fileExplorerRef.send({ type: 'renameFile', oldPath, newPath });

        // Keep folder expanded after rename
        if (wasExpanded) {
          setExpandedItems((previous) => {
            const withoutOld = previous.filter((p) => p !== oldPath);
            return [...withoutOld, newPath];
          });
        }
      } else {
        // Rename file in fileManager - calls worker directly
        void renameFile(oldPath, newPath);

        // Update file explorer path atomically (no close/open to avoid fallback behavior)
        fileExplorerRef.send({ type: 'renameFile', oldPath, newPath });
      }
    },
    onPrimaryAction(item) {
      if (!item.isFolder()) {
        fileExplorerRef.send({
          type: 'openFile',
          path: item.getId(),
          source: 'user',
        });
      }
    },
    hotkeys: {
      customDelete: {
        hotkey: 'Delete',
        handler(_event, treeInstance) {
          const selected = treeInstance.getSelectedItems();
          if (selected.length > 0) {
            handleDelete(selected);
          }
        },
      },
      // Override submitSearch to prevent closing search on Enter
      submitSearch: {
        hotkey: 'Enter',
        handler(_event, treeInstance) {
          const matches = treeInstance.getSearchMatchingItems();
          if (matches.length > 0) {
            matches[0]?.setFocused();
            treeInstance.updateDomFocus();
          }
          // Don't close search - user must press Escape or click X
        },
      },
      // Override closeSearch to use external callback
      closeSearch: {
        hotkey: 'Escape',
        handler() {
          onSearchChange?.(false);
        },
      },
    },
    // Allow drops on any item, except when dropping into the same folder the item already lives in
    canDrop(draggedItems, target) {
      const targetPath = target.item.getId();

      // Determine target folder based on drop type (same logic as onDrop)
      let targetFolder = '';
      if (targetPath === rootId) {
        targetFolder = '';
      } else if (target.item.isFolder()) {
        targetFolder = targetPath;
      } else {
        // Dropped on a file, use its parent folder
        const parts = targetPath.split('/');
        parts.pop();
        targetFolder = parts.join('/');
      }

      // Check if ALL dragged items are already in the target folder
      // If so, disallow the drop (nothing would change)
      const allItemsAlreadyInTarget = draggedItems.every((item) => {
        const itemPath = item.getId();
        const itemParts = itemPath.split('/');
        itemParts.pop(); // Remove filename to get parent folder
        const itemParentFolder = itemParts.join('/');
        return itemParentFolder === targetFolder;
      });

      return !allItemsAlreadyInTarget;
    },
    // Allow file drops from computer on folders, root, or root-level files
    canDropForeignDragObject(_dataTransfer, target) {
      const targetId = target.item.getId();
      const isRoot = targetId === rootId;
      const isFolder = target.item.isFolder();
      const isRootLevelFile = !targetId.includes('/') && !isFolder;

      return isFolder || isRoot || isRootLevelFile;
    },
    // Handle file drops from computer (supports folders with directory structure)
    async onDropForeignDragObject(dataTransfer, target) {
      const { items } = dataTransfer;
      if (items.length === 0) {
        return;
      }

      // Process all items (files and folders) with directory structure preserved
      const filesWithPaths = await processDataTransferItems(items);
      if (filesWithPaths.length === 0) {
        return;
      }

      // Determine target folder based on drop type (same logic as onDrop)
      const targetPath = target.item.getId();
      let directory = '';
      if (targetPath === rootId) {
        // Dropping on root folder
        directory = '';
      } else if (target.item.isFolder()) {
        directory = targetPath;
      } else {
        // Dropped on a file, use its parent folder
        const parts = targetPath.split('/');
        parts.pop();
        directory = parts.join('/');
      }

      await processDroppedFiles(filesWithPaths, directory);
    },
    features: [
      syncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      dragAndDropFeature,
      keyboardDragAndDropFeature,
      renamingFeature,
      searchFeature,
      expandAllFeature,
      propMemoizationFeature,
    ],
  });

  // Rebuild tree when file data changes or hidden files toggle
  useEffect(() => {
    tree.rebuildTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tree object is not stable, only rebuild when fileTree or showHiddenFiles changes
  }, [fileTree, showHiddenFiles]);

  // Sync tree search state with external enableSearch prop
  useEffect(() => {
    if (enableSearch && !tree.isSearchOpen()) {
      tree.openSearch();
    } else if (!enableSearch && tree.isSearchOpen()) {
      tree.closeSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tree object is not stable, only sync when enableSearch changes
  }, [enableSearch]);

  // Sync active file with tree focus
  useEffect(() => {
    if (activeFilePath && activeFilePath !== focusedItem) {
      setFocusedItem(activeFilePath);
    }
  }, [activeFilePath, focusedItem]);

  const handleCreateFile = useCallback(
    (template: KernelConfiguration | undefined) => {
      const content = template?.emptyCode ?? '';
      const extension = template ? getFileExtension(template.mainFile) : 'txt';

      // Determine parent path based on focused item
      let parentPath = '';
      if (focusedItem) {
        const focusedItemInstance = tree.getItemInstance(focusedItem);
        if (focusedItemInstance.isFolder()) {
          // Focused item is a folder - create inside it
          parentPath = focusedItem;
          // Expand the folder so user can see the pending input
          setExpandedItems((previous) => (previous.includes(focusedItem) ? previous : [...previous, focusedItem]));
        } else {
          // Focused item is a file - create in its parent folder
          const lastSlashIndex = focusedItem.lastIndexOf('/');
          parentPath = lastSlashIndex > 0 ? focusedItem.slice(0, lastSlashIndex) : '';
        }
      }

      setPendingFile({
        parentPath,
        extension,
        defaultName: template?.mainFile.split('.').slice(0, -1).join('.') ?? '',
        content,
        error: undefined,
      });
    },
    [focusedItem, tree],
  );

  const handleCreateFolder = useCallback(() => {
    // Determine parent path based on focused item
    let parentPath = '';
    if (focusedItem) {
      const focusedItemInstance = tree.getItemInstance(focusedItem);
      if (focusedItemInstance.isFolder()) {
        // Focused item is a folder - create inside it
        parentPath = focusedItem;
        // Expand the folder so user can see the pending input
        setExpandedItems((previous) => (previous.includes(focusedItem) ? previous : [...previous, focusedItem]));
      } else {
        // Focused item is a file - create in its parent folder
        const lastSlashIndex = focusedItem.lastIndexOf('/');
        parentPath = lastSlashIndex > 0 ? focusedItem.slice(0, lastSlashIndex) : '';
      }
    }

    setPendingFolder({ parentPath, error: undefined });
  }, [focusedItem, tree]);

  const handleDelete = useCallback((items: Array<ItemInstance<TreeItemData>>) => {
    setItemsToDelete(items.map((item) => item.getId()));
    setDeleteDialogOpen(true);
  }, []);

  const confirmDelete = useCallback(() => {
    // Collect all paths that will be deleted (including nested files in folders)
    const deletedPaths = new Set<string>();
    for (const path of itemsToDelete) {
      if (path === rootId) {
        continue;
      }

      deletedPaths.add(path);

      // Check if path is a folder by seeing if it's not in fileTree (files are in fileTree, folders are virtual)
      const isFolder = !fileTree.some((f) => f.path === path);

      if (isFolder) {
        // Delete all files in folder
        const nested = fileTree.filter((f) => f.path.startsWith(`${path}/`));
        for (const file of nested) {
          deletedPaths.add(file.path);
          // Delete file from fileManager - calls worker directly
          void deleteFile(file.path, { source: 'user' });
          // Close file in fileExplorer if it's open
          fileExplorerRef.send({ type: 'closeFile', path: file.path });
        }
      } else {
        // Delete file from fileManager - calls worker directly
        void deleteFile(path, { source: 'user' });
        // Close file in fileExplorer if it's open
        fileExplorerRef.send({ type: 'closeFile', path });
      }
    }

    setDeleteDialogOpen(false);
    setItemsToDelete([]);

    // Clean up stale references to deleted items
    setSelectedItems((previous) => previous.filter((p) => !deletedPaths.has(p)));

    // Set focus to first remaining item (not undefined) so tree.updateDomFocus() has a valid target
    const firstRemainingItem = tree.getItems().find((i) => i.getId() !== rootId && !deletedPaths.has(i.getId()));
    setFocusedItem(firstRemainingItem?.getId());

    // Focus restoration is handled by DialogContent's onCloseAutoFocus
  }, [fileExplorerRef, deleteFile, fileTree, itemsToDelete, tree]);

  const handleDuplicate = useCallback((_items: Array<ItemInstance<TreeItemData>>) => {
    // Duplication requires file-manager content, which isn't exposed yet
    toast.info('File duplication is not yet supported');
  }, []);

  const handleUploadClick = useCallback((targetPath: string) => {
    setUploadTargetPath(targetPath);
    fileInputRef.current?.click();
  }, []);

  // Shared file processing logic for both drag-drop and upload button
  const processDroppedFiles = useCallback(
    async (files: Array<{ file: File; relativePath: string }>, targetDirectory: string) => {
      for (const { file, relativePath } of files) {
        try {
          // eslint-disable-next-line no-await-in-loop -- Files need to be read sequentially
          const arrayBuffer = await file.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          const filePath = targetDirectory ? `${targetDirectory}/${relativePath}` : relativePath;

          // Write file to fileManager - calls worker directly
          // eslint-disable-next-line no-await-in-loop -- Files need to be written sequentially
          await writeFile(filePath, uint8Array, { source: 'user' });

          // Open file in fileExplorer
          fileExplorerRef.send({ type: 'openFile', path: filePath, source: 'user' });
        } catch (error) {
          console.error(`Error uploading file ${file.name}:`, error);
        }
      }
    },
    [writeFile, fileExplorerRef],
  );

  const handleFileUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const { files } = event.target;
      if (!files || files.length === 0) {
        return;
      }

      const targetItem = uploadTargetPath ? tree.getItemInstance(uploadTargetPath) : undefined;
      const directory = targetItem?.isFolder() ? uploadTargetPath : '';

      // Convert FileList to the new format (flat files have relativePath = filename)
      const filesWithPaths = [...files].map((file) => ({ file, relativePath: file.name }));
      await processDroppedFiles(filesWithPaths, directory ?? '');

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      setUploadTargetPath(undefined);
    },
    [uploadTargetPath, tree, processDroppedFiles],
  );

  // Get display name for delete dialog
  const deleteItemName = useMemo(() => {
    if (itemsToDelete.length === 0) {
      return '';
    }

    if (itemsToDelete.length === 1) {
      // Derive name from path (last segment)
      const path = itemsToDelete[0] ?? '';
      return path.split('/').pop() ?? path;
    }

    return `${itemsToDelete.length} items`;
  }, [itemsToDelete]);

  return (
    <>
      <input
        ref={fileInputRef}
        multiple
        type="file"
        className="hidden"
        aria-label="Upload files"
        onChange={handleFileUpload}
      />

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={(event) => {
            // Prevent default focus restoration (trigger element is gone)
            // and manually focus the tree container
            event.preventDefault();
            const container = document.querySelector('[data-tree-container]');
            if (container instanceof HTMLElement) {
              container.focus();
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure you want to delete &apos;{deleteItemName}&apos;?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={confirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <FloatingPanelContent>
        <FloatingPanelContentHeader>
          <FloatingPanelContentTitle>Files</FloatingPanelContentTitle>
          <FloatingPanelContentHeaderActions>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={showHiddenFiles ? 'Hide hidden files' : 'Show hidden files'}
                  className="size-6 rounded-sm"
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    setShowHiddenFiles(!showHiddenFiles);
                  }}
                >
                  {showHiddenFiles ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{showHiddenFiles ? 'Hide hidden files' : 'Show hidden files'}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={enableSearch ? 'Hide search' : 'Search files'}
                  className={cn('size-6 rounded-sm', enableSearch && 'text-primary')}
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    onSearchChange?.(!enableSearch);
                  }}
                >
                  <Search className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{enableSearch ? 'Hide search' : 'Search files'}</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <Tooltip>
                <Button asChild aria-label="Create new file" className="size-6 rounded-sm" size="icon" variant="ghost">
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger>
                      <FilePlus className="size-4" />
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                </Button>
                <DropdownMenuContent
                  align="end"
                  onCloseAutoFocus={(event) => {
                    // Prevent Radix from restoring focus to trigger
                    event.preventDefault();
                    // Focus the pending file input (exists because we used flushSync)
                    pendingFileInputRef.current?.focus();
                  }}
                >
                  <DropdownMenuLabel>New File</DropdownMenuLabel>
                  <DropdownMenuItem
                    onSelect={() => {
                      // Use flushSync to ensure component renders synchronously
                      // so it exists when onCloseAutoFocus fires
                      flushSync(() => {
                        handleCreateFile(undefined);
                      });
                    }}
                  >
                    <FileExtensionIcon filename="file.txt" className="size-4" />
                    Blank
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {kernelConfigurations.map((kernel) => (
                    <DropdownMenuItem
                      key={kernel.id}
                      onSelect={() => {
                        // Use flushSync to ensure component renders synchronously
                        flushSync(() => {
                          handleCreateFile(kernel);
                        });
                      }}
                    >
                      <FileExtensionIcon filename={kernel.mainFile} className="size-4" />
                      {kernel.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
                <TooltipContent>Create new file</TooltipContent>
              </Tooltip>
            </DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Create new folder"
                  className="size-6 rounded-sm"
                  size="icon"
                  variant="ghost"
                  onClick={handleCreateFolder}
                >
                  <FolderPlus className="mt-0.5 size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Create new folder</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Collapse all folders"
                  className="size-6 rounded-sm"
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    tree.collapseAll();
                  }}
                >
                  <CopyMinus className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Collapse all folders</TooltipContent>
            </Tooltip>
          </FloatingPanelContentHeaderActions>
        </FloatingPanelContentHeader>
        <FloatingPanelContentBody className="flex min-h-0 flex-col">
          {enableSearch ? (
            <div className="flex w-full shrink-0 flex-row gap-2 border-b bg-sidebar p-2">
              <SearchInput
                {...tree.getSearchInputElementProps()}
                placeholder="Search files..."
                className="h-7 w-full bg-background"
                // Override onBlur to prevent clearing search when clicking on tree items
                onBlur={undefined}
                onClear={() => {
                  // Only clear the search text, don't close the search panel
                  // Closing is handled by the search toggle button in the header
                  tree.setSearch('');
                }}
              />
            </div>
          ) : null}

          {tree.getItems().length > 0 || pendingFolder !== undefined || pendingFile !== undefined ? (
            <div
              data-tree-container
              {...tree.getContainerProps()}
              className="flex min-h-full flex-1 flex-col gap-0 outline-none"
            >
              <AssistiveTreeDescription tree={tree} />
              {/* Pending folder at root level */}
              {pendingFolder?.parentPath === '' ? (
                <PendingFolderInput
                  parentPath=""
                  error={pendingFolder.error}
                  allPaths={allPaths}
                  level={0}
                  onSubmit={(name) => {
                    const gitkeepPath = `${name}/.gitkeep`;
                    void writeFile(gitkeepPath, encodeTextFile(''), { source: 'user' });
                    setPendingFolder(undefined);
                    setExpandedItems((previous) => [...previous, name]);
                  }}
                  onCancel={() => {
                    setPendingFolder(undefined);
                  }}
                  onError={(error) => {
                    setPendingFolder((previous) => (previous ? { ...previous, error } : undefined));
                  }}
                />
              ) : null}
              {/* Pending file at root level */}
              {pendingFile?.parentPath === '' ? (
                <PendingFileInput
                  inputRef={pendingFileInputRef}
                  parentPath=""
                  extension={pendingFile.extension}
                  defaultName={pendingFile.defaultName}
                  error={pendingFile.error}
                  allPaths={allPaths}
                  level={0}
                  onSubmit={(filename) => {
                    void writeFile(filename, encodeTextFile(pendingFile.content), { source: 'user' });
                    fileExplorerRef.send({ type: 'openFile', path: filename, source: 'user' });
                    setPendingFile(undefined);
                  }}
                  onCancel={() => {
                    setPendingFile(undefined);
                  }}
                  onError={(error) => {
                    setPendingFile((previous) => (previous ? { ...previous, error } : undefined));
                  }}
                />
              ) : null}
              {(() => {
                const items = tree.getItems();
                const rootItem = tree.getRootItem();
                const dragTargetItem = items.find((i) => i.isDragTarget());

                // Determine highlighting strategy
                // Root item or root-level file = highlight all items
                const isRootDragTarget = rootItem.isDragTarget();
                const highlightAllItems =
                  isRootDragTarget ||
                  (dragTargetItem !== undefined && !dragTargetItem.isFolder() && !dragTargetItem.getId().includes('/'));
                let dragTargetFolderPath: string | undefined;

                if (dragTargetItem) {
                  const targetPath = dragTargetItem.getId();
                  if (dragTargetItem.isFolder()) {
                    // Folder - highlight folder and children
                    dragTargetFolderPath = targetPath;
                  } else if (targetPath.includes('/')) {
                    // Nested file - use parent folder
                    const parts = targetPath.split('/');
                    parts.pop();
                    dragTargetFolderPath = parts.join('/');
                  }
                  // Root-level file case is handled by highlightAllItems above
                }

                return (
                  <>
                    {items
                      .filter((item) => item.getId() !== rootId)
                      .map((item) => {
                        const itemId = item.getId();
                        const itemLevel = item.getItemMeta().level;

                        // Item is highlighted if:
                        // 1. highlightAllItems is true (dropping at root - ALL items highlighted), OR
                        // 2. It IS the drag target folder, OR
                        // 3. It's inside the drag target folder
                        const isInsideDragTarget =
                          highlightAllItems ||
                          (dragTargetFolderPath !== undefined &&
                            (itemId === dragTargetFolderPath || itemId.startsWith(`${dragTargetFolderPath}/`)));

                        return (
                          <div key={itemId}>
                            <TreeItem
                              item={item}
                              isActive={activeFilePath === itemId}
                              isOpen={openFiles.some((f) => f.path === itemId)}
                              searchQuery={tree.getState().search ?? ''}
                              isInsideDragTarget={isInsideDragTarget}
                              onDelete={handleDelete}
                              onDuplicate={handleDuplicate}
                              onUpload={handleUploadClick}
                            />
                            {/* Pending folder inside this folder */}
                            {pendingFolder && pendingFolder.parentPath === itemId && item.isFolder() ? (
                              <PendingFolderInput
                                parentPath={pendingFolder.parentPath}
                                error={pendingFolder.error}
                                allPaths={allPaths}
                                level={itemLevel + 1}
                                onSubmit={(name) => {
                                  const folderPath = `${pendingFolder.parentPath}/${name}`;
                                  const gitkeepPath = `${folderPath}/.gitkeep`;
                                  void writeFile(gitkeepPath, encodeTextFile(''), { source: 'user' });
                                  setPendingFolder(undefined);
                                  setExpandedItems((previous) => [...previous, folderPath]);
                                }}
                                onCancel={() => {
                                  setPendingFolder(undefined);
                                }}
                                onError={(error) => {
                                  setPendingFolder((previous) => (previous ? { ...previous, error } : undefined));
                                }}
                              />
                            ) : null}
                            {/* Pending file inside this folder */}
                            {pendingFile && pendingFile.parentPath === itemId && item.isFolder() ? (
                              <PendingFileInput
                                inputRef={pendingFileInputRef}
                                parentPath={pendingFile.parentPath}
                                extension={pendingFile.extension}
                                defaultName={pendingFile.defaultName}
                                error={pendingFile.error}
                                allPaths={allPaths}
                                level={itemLevel + 1}
                                onSubmit={(filename) => {
                                  const filePath = `${pendingFile.parentPath}/${filename}`;
                                  void writeFile(filePath, encodeTextFile(pendingFile.content), { source: 'user' });
                                  fileExplorerRef.send({ type: 'openFile', path: filePath, source: 'user' });
                                  setPendingFile(undefined);
                                }}
                                onCancel={() => {
                                  setPendingFile(undefined);
                                }}
                                onError={(error) => {
                                  setPendingFile((previous) => (previous ? { ...previous, error } : undefined));
                                }}
                              />
                            ) : null}
                          </div>
                        );
                      })}

                    {/* Root item as spacer to capture empty space drops */}
                    <div
                      {...rootItem.getProps()}
                      className={cn('min-h-4 flex-1', highlightAllItems && 'bg-primary/20')}
                    />
                  </>
                );
              })()}
            </div>
          ) : (
            <EmptyItems className="m-2">No files available</EmptyItems>
          )}
        </FloatingPanelContentBody>
      </FloatingPanelContent>
    </>
  );
});

type TreeItemProps = {
  readonly item: ItemInstance<TreeItemData>;
  readonly isActive: boolean;
  readonly isOpen: boolean;
  readonly searchQuery: string;
  readonly isInsideDragTarget: boolean;
  readonly onDelete: (items: Array<ItemInstance<TreeItemData>>) => void;
  readonly onDuplicate: (items: Array<ItemInstance<TreeItemData>>) => void;
  readonly onUpload: (path: string) => void;
};

// eslint-disable-next-line complexity -- UI rendering with many conditional states
function TreeItem({
  item,
  isActive,
  isOpen,
  searchQuery,
  isInsideDragTarget,
  onDelete,
  onDuplicate,
  onUpload,
}: TreeItemProps): React.JSX.Element {
  const data = item.getItemData();
  const hasGitChanges = Boolean(data.gitStatus && data.gitStatus !== 'clean');
  const paddingLeft = item.getItemMeta().level * 16 + 8;
  const isSelected = item.isSelected();
  const isRenaming = item.isRenaming();
  const isFolder = item.isFolder();

  // Rename input - NOT wrapped by ContextMenu to avoid focus interference
  if (isRenaming) {
    const renameInputProps = item.getRenameInputProps() as React.InputHTMLAttributes<HTMLInputElement>;
    return (
      <div
        className="flex h-7 items-center border border-primary py-1 pr-1 pl-2"
        style={{ paddingLeft: `${paddingLeft}px` }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isFolder ? (
            item.isExpanded() ? (
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <Folder className="size-4 shrink-0 text-muted-foreground" />
            )
          ) : (
            <FileExtensionIcon filename={item.getItemName()} className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <input
            className="h-full min-w-0 flex-1 border-none bg-transparent px-0 text-sm shadow-none outline-none focus:border-transparent focus:ring-0 focus:ring-offset-0"
            autoCorrect="off"
            {...renameInputProps}
            onFocus={(event) => {
              // Call the library's onFocus handler first if it exists
              renameInputProps.onFocus?.(event);

              // Then select text: for folders select all, for files select name without extension
              const input = event.currentTarget;
              if (isFolder) {
                input.setSelectionRange(0, input.value.length);
              } else {
                const lastDotIndex = input.value.lastIndexOf('.');
                const endIndex = lastDotIndex > 0 ? lastDotIndex : input.value.length;
                input.setSelectionRange(0, endIndex);
              }
            }}
          />
        </div>
      </div>
    );
  }

  // Normal view - wrapped by ContextMenu
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          {...item.getProps()}
          className={cn(
            'group/file relative flex h-7 w-full cursor-pointer items-center justify-between py-1 pr-1 pl-2 text-sm text-sidebar-foreground',
            !isActive && 'hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
            isActive && !isSelected && 'bg-sidebar-accent',
            isSelected && 'bg-sidebar-accent/70 text-sidebar-accent-foreground',
            item.isMatchingSearch() && 'bg-primary/20',
            (item.isDragTarget() || isInsideDragTarget) && 'bg-primary/20',
          )}
          style={{ paddingLeft: `${paddingLeft}px` }}
        >
          <div className="flex min-w-0 flex-1 grow items-center gap-2">
            {isFolder ? (
              item.isExpanded() ? (
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="size-4 shrink-0 text-muted-foreground" />
              )
            ) : (
              <FileExtensionIcon filename={item.getItemName()} className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className={cn('truncate', isOpen && 'font-medium', isActive && 'text-primary')}>
              <HighlightText text={item.getItemName()} searchTerm={searchQuery} />
            </span>
            {hasGitChanges ? (
              <span
                aria-label={`File has changes: ${data.gitStatus ?? ''}`}
                className="size-2 shrink-0 rounded-full bg-yellow"
                title={`File status: ${data.gitStatus ?? ''}`}
              />
            ) : null}
          </div>
          {isFolder ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  className="absolute top-1/2 right-1 size-5 -translate-y-1/2 opacity-0 group-hover/file:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  onSelect={() => {
                    item.startRenaming();
                  }}
                >
                  <FileEdit className="size-4" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(event) => {
                    event.stopPropagation();
                    onUpload(item.getId());
                  }}
                >
                  <Upload className="size-4" />
                  Upload Files
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(event) => {
                    event.stopPropagation();
                    onDuplicate([item]);
                  }}
                >
                  <Copy className="size-4" />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete([item]);
                  }}
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            item.startRenaming();
          }}
        >
          <FileEdit className="size-4" />
          Rename
        </ContextMenuItem>
        {isFolder ? (
          <ContextMenuItem
            onClick={() => {
              onUpload(item.getId());
            }}
          >
            <Upload className="size-4" />
            Upload Files
          </ContextMenuItem>
        ) : (
          <>
            <ContextMenuItem
              onClick={() => {
                onUpload(item.getId());
              }}
            >
              <Upload className="size-4" />
              Upload Files
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                onDuplicate([item]);
              }}
            >
              <Copy className="size-4" />
              Duplicate
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onClick={() => {
            onDelete([item]);
          }}
        >
          <Trash2 className="size-4" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

type PendingFolderInputProps = {
  readonly parentPath: string;
  readonly error: string | undefined;
  readonly allPaths: Set<string>;
  readonly level: number;
  readonly onSubmit: (name: string) => void;
  readonly onCancel: () => void;
  readonly onError: (error: string | undefined) => void;
};

function PendingFolderInput({
  parentPath,
  error,
  allPaths,
  level,
  onSubmit,
  onCancel,
  onError,
}: PendingFolderInputProps): React.JSX.Element {
  const [value, setValue] = useState('');
  const paddingLeft = level * 16 + 8;

  const validate = useCallback(
    (name: string): string | undefined => {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return 'A file or folder name must be provided.';
      }

      const fullPath = parentPath ? `${parentPath}/${trimmedName}` : trimmedName;
      if (allPaths.has(fullPath)) {
        return `A file or folder ${trimmedName} already exists at this location. Please choose a different name.`;
      }

      return undefined;
    },
    [parentPath, allPaths],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const validationError = validate(value);
        if (validationError) {
          onError(validationError);
        } else {
          onSubmit(value.trim());
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    },
    [value, validate, onSubmit, onCancel, onError],
  );

  const handleBlur = useCallback(() => {
    // Cancel on blur (user clicked elsewhere)
    onCancel();
  }, [onCancel]);

  return (
    <div className="flex w-full flex-col gap-0.5">
      <div
        className="flex h-7 w-full items-center border border-primary py-1 pr-1"
        style={{ paddingLeft: `${paddingLeft}px` }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Folder className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={value}
            className="h-full min-w-0 flex-1 border-none bg-transparent px-0 text-sm shadow-none outline-none focus:border-transparent focus:ring-0 focus:ring-offset-0"
            placeholder="Folder name"
            onChange={(event) => {
              setValue(event.target.value);
              // Clear error when user types
              if (error) {
                onError(undefined);
              }
            }}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
          />
        </div>
      </div>
      {error ? (
        <div
          className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive"
          style={{ marginLeft: `${paddingLeft}px` }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

type PendingFileInputProps = {
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- React ref object
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly parentPath: string;
  readonly extension: string;
  readonly defaultName: string;
  readonly error: string | undefined;
  readonly allPaths: Set<string>;
  readonly level: number;
  readonly onSubmit: (name: string) => void;
  readonly onCancel: () => void;
  readonly onError: (error: string | undefined) => void;
};

function PendingFileInput({
  inputRef,
  parentPath,
  extension,
  defaultName,
  error,
  allPaths,
  level,
  onSubmit,
  onCancel,
  onError,
}: PendingFileInputProps): React.JSX.Element {
  const fullDefaultName = defaultName ? `${defaultName}.${extension}` : '';
  const [value, setValue] = useState(fullDefaultName);
  const paddingLeft = level * 16 + 8;

  // Handle focus to select filename without extension
  const handleFocus = useCallback((event: React.FocusEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    // Select only the name part, not the extension
    const lastDotIndex = input.value.lastIndexOf('.');
    const endIndex = lastDotIndex > 0 ? lastDotIndex : input.value.length;
    input.setSelectionRange(0, endIndex);
  }, []);

  const validate = useCallback(
    (filename: string): string | undefined => {
      const trimmedName = filename.trim();
      if (!trimmedName) {
        return 'A file name must be provided.';
      }

      const fullPath = parentPath ? `${parentPath}/${trimmedName}` : trimmedName;
      if (allPaths.has(fullPath)) {
        return `A file ${trimmedName} already exists at this location. Please choose a different name.`;
      }

      return undefined;
    },
    [parentPath, allPaths],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const validationError = validate(value);
        if (validationError) {
          onError(validationError);
        } else {
          onSubmit(value.trim());
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    },
    [value, validate, onSubmit, onCancel, onError],
  );

  const handleBlur = useCallback(() => {
    onCancel();
  }, [onCancel]);

  // Get the current extension from the value for the icon
  const currentExtension = value.includes('.') ? (value.split('.').pop() ?? extension) : extension;

  return (
    <div className="flex w-full flex-col gap-0.5">
      <div
        className="flex h-7 w-full items-center border border-primary py-1 pr-1"
        style={{ paddingLeft: `${paddingLeft}px` }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileExtensionIcon
            filename={`file.${currentExtension}`}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <input
            ref={inputRef}
            autoFocus
            value={value}
            className="h-full min-w-0 flex-1 border-none bg-transparent px-0 text-sm shadow-none outline-none focus:border-transparent focus:ring-0 focus:ring-offset-0"
            placeholder="New File"
            onChange={(event) => {
              setValue(event.target.value);
              // Clear error when user types
              if (error) {
                onError(undefined);
              }
            }}
            onFocus={handleFocus}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
          />
        </div>
      </div>
      {error ? (
        <div
          className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive"
          style={{ marginLeft: `${paddingLeft}px` }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
