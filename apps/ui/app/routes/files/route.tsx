import { useState, useCallback, useEffect, useMemo } from 'react';
import { Link } from 'react-router';
import { Database, Download, FolderArchive, FolderOpen, MoreHorizontal, RefreshCw, Star, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FilesystemBackend, Build } from '@taucad/types';
import { ExternalLink } from '#components/external-link.js';
import { Button } from '#components/ui/button.js';
import { ComboBoxResponsive } from '#components/ui/combobox-responsive.js';
import { Loader } from '#components/ui/loader.js';
import { Tree, Folder, File } from '#components/magicui/file-tree.js';
import type { TreeViewElement } from '#components/magicui/file-tree.js';
import { useCookie } from '#hooks/use-cookie.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { useBuilds } from '#hooks/use-builds.js';
import { cookieName } from '#constants/cookie.constants.js';
import { isFileSystemAccessSupported } from '#constants/browser.constants.js';
import type { Handle } from '#types/matches.types.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { cn } from '#utils/ui.utils.js';
import {
  getStoredDirectoryHandle,
  storeDirectoryHandle,
  checkHandlePermission,
  requestHandlePermission,
} from '#filesystem/handle-store.js';
import type { FileTreeNode } from '#machines/file-manager.js';

export const handle: Handle = {
  breadcrumb() {
    return (
      <Button asChild variant="ghost">
        <Link to="/files">Files</Link>
      </Button>
    );
  },
};

/**
 * Backend column metadata.
 */
type BackendColumnMeta = {
  key: FilesystemBackend;
  label: string;
  icon: LucideIcon;
  description: string;
  isSupported: boolean;
};

const backendColumns: BackendColumnMeta[] = [
  {
    key: 'indexeddb',
    label: 'IndexedDB',
    icon: Database,
    description: 'Browser database storage',
    isSupported: true,
  },
  // OPFS column removed -- disabled due to file corruption issues
  {
    key: 'webaccess',
    label: 'File System',
    icon: FolderOpen,
    description: 'Local directory on your computer',
    isSupported: isFileSystemAccessSupported,
  },
];

/**
 * Action type for ComboBoxResponsive
 */
type ItemAction = {
  value: string;
  label: string;
  icon: LucideIcon;
  variant?: 'default' | 'destructive';
};

/**
 * Available file actions
 */
const fileActions: ItemAction[] = [
  { value: 'download', label: 'Download', icon: Download },
  { value: 'delete', label: 'Delete', icon: Trash2, variant: 'destructive' },
];

/**
 * Available folder actions
 */
const folderActions: ItemAction[] = [
  { value: 'download-zip', label: 'Download as ZIP', icon: FolderArchive },
  { value: 'delete', label: 'Delete Directory', icon: Trash2, variant: 'destructive' },
];

/**
 * Extract build ID from a path that is exactly "/builds/bld_xxx" (not subfolders)
 */
function extractBuildId(path: string): string | undefined {
  const match = /^\/builds\/([^/]+)$/.exec(path);
  return match?.[1];
}

/**
 * Link to a build page that opens in a new tab
 */
function BuildLink({
  buildId,
  buildName,
}: {
  readonly buildId: string;
  readonly buildName: string;
}): React.JSX.Element {
  return (
    <span
      role="presentation"
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      <ExternalLink
        withArrow
        isArrowOnHoverOnly
        href={`/builds/${buildId}`}
        className="text-xs text-muted-foreground max-md:hidden"
        arrowSize="xs"
      >
        {buildName}
      </ExternalLink>
    </span>
  );
}

/**
 * Trigger download of a blob with a filename
 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * File actions component
 */
function FileActions({
  path,
  onDelete,
  onDownload,
}: {
  readonly path: string;
  readonly onDelete: (path: string) => Promise<void>;
  readonly onDownload: (path: string) => Promise<void>;
}): React.JSX.Element {
  const handleAction = useCallback(
    async (actionValue: string) => {
      if (actionValue === 'delete') {
        await onDelete(path);
      } else if (actionValue === 'download') {
        await onDownload(path);
      }
    },
    [onDelete, onDownload, path],
  );

  return (
    <ComboBoxResponsive
      groupedItems={[{ name: 'Actions', items: fileActions }]}
      defaultValue={undefined}
      getValue={(item) => item.value}
      renderLabel={(item) => (
        <div
          className={cn(
            'flex items-center gap-2',
            item.variant === 'destructive' && 'text-destructive [&>svg]:text-destructive!',
          )}
        >
          <item.icon className="size-4" />
          <span>{item.label}</span>
        </div>
      )}
      title="File Actions"
      description="Choose an action for this file"
      isSearchEnabled={false}
      onSelect={handleAction}
    >
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <MoreHorizontal className="size-4" />
      </Button>
    </ComboBoxResponsive>
  );
}

/**
 * Folder actions component
 */
function FolderActions({
  path,
  onDelete,
  onDownloadZip,
}: {
  readonly path: string;
  readonly onDelete: (path: string) => Promise<void>;
  readonly onDownloadZip: (path: string) => Promise<void>;
}): React.JSX.Element {
  const handleAction = useCallback(
    async (actionValue: string) => {
      if (actionValue === 'delete') {
        await onDelete(path);
      } else if (actionValue === 'download-zip') {
        await onDownloadZip(path);
      }
    },
    [onDelete, onDownloadZip, path],
  );

  return (
    <ComboBoxResponsive
      groupedItems={[{ name: 'Actions', items: folderActions }]}
      defaultValue={undefined}
      getValue={(item) => item.value}
      renderLabel={(item) => (
        <div
          className={cn(
            'flex items-center gap-2',
            item.variant === 'destructive' && 'text-destructive [&>svg]:text-destructive!',
          )}
        >
          <item.icon className="size-4" />
          <span>{item.label}</span>
        </div>
      )}
      title="Folder Actions"
      description="Choose an action for this folder"
      isSearchEnabled={false}
      onSelect={handleAction}
    >
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <MoreHorizontal className="size-4" />
      </Button>
    </ComboBoxResponsive>
  );
}

/**
 * Action handlers type for renderTree
 */
type TreeActionHandlers = {
  onDeleteFile: (path: string) => Promise<void>;
  onDownloadFile: (path: string) => Promise<void>;
  onDeleteFolder: (path: string) => Promise<void>;
  onDownloadFolderZip: (path: string) => Promise<void>;
  buildsMap: Map<string, Build>;
};

/**
 * Compose folder label with optional build link
 */
function FolderLabel({ name, build }: { readonly name: string; readonly build?: Build }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2">
      <span>{name}</span>
      {build ? <BuildLink buildId={build.id} buildName={build.name} /> : undefined}
    </span>
  );
}

/**
 * Render tree elements recursively
 */
function renderTree(elements: TreeViewElement[], handlers: TreeActionHandlers): React.ReactNode {
  return elements.map((element) => {
    if (element.children) {
      // Check if this folder corresponds to a build
      const buildId = extractBuildId(element.id);
      const build = buildId ? handlers.buildsMap.get(buildId) : undefined;

      return (
        <Folder
          key={element.id}
          element={<FolderLabel name={element.name} build={build} />}
          value={element.id}
          actions={
            <FolderActions
              path={element.id}
              onDelete={handlers.onDeleteFolder}
              onDownloadZip={handlers.onDownloadFolderZip}
            />
          }
        >
          {renderTree(element.children, handlers)}
        </Folder>
      );
    }

    return (
      <File
        key={element.id}
        value={element.id}
        actions={
          <FileActions path={element.id} onDelete={handlers.onDeleteFile} onDownload={handlers.onDownloadFile} />
        }
      >
        {element.name}
      </File>
    );
  });
}

/**
 * Convert FileTreeNode[] from the worker to TreeViewElement[] for the file tree component.
 * The types are structurally compatible, but this explicit mapping ensures type safety.
 */
function toTreeViewElements(nodes: FileTreeNode[]): TreeViewElement[] {
  return nodes.map((node) => ({
    id: node.id,
    name: node.name,
    children: node.children ? toTreeViewElements(node.children) : undefined,
  }));
}

/**
 * Recursively count entries whose name starts with `bld_` (build directories).
 */
function countBuilds(elements: TreeViewElement[]): number {
  let count = 0;
  for (const element of elements) {
    if (element.name.startsWith('bld_')) {
      count += 1;
    }

    if (element.children) {
      count += countBuilds(element.children);
    }
  }

  return count;
}

/**
 * Collect IDs of all folders named "builds" so they can be expanded by default.
 */
function findBuildsFolderIds(elements: TreeViewElement[]): string[] {
  const ids: string[] = [];
  for (const element of elements) {
    if (element.name === 'builds' && element.children) {
      ids.push(element.id);
    }

    if (element.children) {
      ids.push(...findBuildsFolderIds(element.children));
    }
  }

  return ids;
}

// ============ WebAccess Directory State ============

type WebAccessDirectoryState = {
  directoryName: string | undefined;
  isConnected: boolean;
  /** Whether we need the user to re-grant permission (handle exists but expired) */
  needsPermission: boolean;
};

// ============ Backend Column Component ============

/**
 * A single column in the 3-column grid showing a backend's file tree.
 */
function BackendColumn({
  meta,
  isDefault,
  treeActionHandlers,
  fileTree,
  isLoading,
  onRefresh,
  onSetDefault,
  webAccessState,
  onConnectDirectory,
  onGrantAccess,
  onChangeDirectory,
}: {
  readonly meta: BackendColumnMeta;
  readonly isDefault: boolean;
  readonly treeActionHandlers: TreeActionHandlers;
  readonly fileTree: TreeViewElement[];
  readonly isLoading: boolean;
  readonly onRefresh: () => void;
  readonly onSetDefault: () => void;
  readonly webAccessState?: WebAccessDirectoryState;
  readonly onConnectDirectory?: () => void;
  readonly onGrantAccess?: () => void;
  readonly onChangeDirectory?: () => void;
}): React.JSX.Element {
  const Icon = meta.icon;
  const isDisabled = !meta.isSupported;

  return (
    <div className={cn('flex min-h-0 flex-col gap-3 rounded-lg border bg-card p-4', isDisabled && 'opacity-50')}>
      {/* Column Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{meta.label}</span>
              {countBuilds(fileTree) > 0 ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {countBuilds(fileTree)}
                </span>
              ) : undefined}
            </div>
            {meta.key === 'webaccess' && webAccessState?.directoryName ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                {webAccessState.directoryName} -{' '}
                <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={onChangeDirectory}>
                  Change Directory
                </Button>
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">{meta.description}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn('size-7', isDefault && 'text-primary')}
                disabled={isDisabled}
                onClick={onSetDefault}
              >
                <Star className={cn('size-3.5', isDefault && 'fill-primary')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isDefault ? 'Default storage' : 'Set as default storage'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                disabled={isLoading || isDisabled}
                onClick={onRefresh}
              >
                <RefreshCw className={cn('size-3.5', isLoading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* WebAccess directory management */}
      {meta.key === 'webaccess' && webAccessState ? (
        <WebAccessDirectoryPanel
          state={webAccessState}
          onConnect={onConnectDirectory!}
          onGrantAccess={onGrantAccess!}
        />
      ) : undefined}

      {/* Unsupported banner */}
      {isDisabled ? (
        <div className="flex flex-1 items-center justify-center rounded-md border border-dashed p-6 text-sm text-muted-foreground">
          Not supported in this browser
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          {isLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader className="size-6" />
            </div>
          ) : fileTree.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">No files found</div>
          ) : (
            <Tree elements={fileTree} initialExpandedItems={findBuildsFolderIds(fileTree)}>
              {renderTree(fileTree, treeActionHandlers)}
            </Tree>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * WebAccess directory management panel shown within the WebAccess column.
 */
function WebAccessDirectoryPanel({
  state,
  onConnect,
  onGrantAccess,
}: {
  readonly state: WebAccessDirectoryState;
  readonly onConnect: () => void;
  readonly onGrantAccess: () => void;
}): React.JSX.Element | undefined {
  if (state.directoryName === undefined) {
    return (
      <Button variant="outline" size="sm" className="gap-2" onClick={onConnect}>
        <FolderOpen className="size-4" />
        Connect Directory
      </Button>
    );
  }

  if (state.needsPermission) {
    return (
      <div className="border-amber-500/30 bg-amber-500/10 flex items-center justify-between gap-2 rounded-md border px-3 py-2">
        <div className="flex items-center gap-2">
          <FolderOpen className="text-amber-600 size-3.5 shrink-0" />
          <span className="text-xs">{state.directoryName}</span>
        </div>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onGrantAccess}>
          Grant Access
        </Button>
      </div>
    );
  }

  return undefined;
}

// ============ Main Route Component ============

export default function FilesRoute(): React.JSX.Element {
  const [backendCookie, setBackendCookie] = useCookie(cookieName.filesystemBackend, 'indexeddb' as FilesystemBackend);
  const { fileManagerRef, readFile, deleteFile, getZippedDirectory, readBackendFileTree } = useFileManager();
  const { builds } = useBuilds();

  // Per-column state
  const [columnTrees, setColumnTrees] = useState<Record<string, TreeViewElement[]>>({});
  const [columnLoading, setColumnLoading] = useState<Record<string, boolean>>({});
  // WebAccess directory state
  const [webAccessState, setWebAccessState] = useState<WebAccessDirectoryState>({
    directoryName: undefined,
    isConnected: false,
    needsPermission: false,
  });

  // Create a lookup map for builds by ID
  const buildsMap = useMemo(() => new Map(builds.map((build) => [build.id, build])), [builds]);

  // Check WebAccess handle status on mount
  useEffect(() => {
    const checkWebAccess = async (): Promise<void> => {
      try {
        const storedHandle = await getStoredDirectoryHandle();
        if (storedHandle) {
          const permission = await checkHandlePermission(storedHandle);
          setWebAccessState({
            directoryName: storedHandle.name,
            isConnected: permission === 'granted',
            needsPermission: permission !== 'granted',
          });
        }
      } catch {
        // Handle store might not be available
      }
    };

    void checkWebAccess();
  }, []);

  // Load a single backend's file tree
  const loadColumnTree = useCallback(
    async (backend: FilesystemBackend): Promise<void> => {
      setColumnLoading((previous) => ({ ...previous, [backend]: true }));
      try {
        const nodes = await readBackendFileTree(backend);
        const elements = toTreeViewElements(nodes);
        setColumnTrees((previous) => ({ ...previous, [backend]: elements }));
      } catch {
        setColumnTrees((previous) => ({ ...previous, [backend]: [] }));
      } finally {
        setColumnLoading((previous) => ({ ...previous, [backend]: false }));
      }
    },
    [readBackendFileTree],
  );

  // Load all column trees on mount
  useEffect(() => {
    for (const column of backendColumns) {
      if (column.isSupported) {
        // Skip webaccess if not connected
        if (column.key === 'webaccess' && !webAccessState.isConnected) {
          continue;
        }

        void loadColumnTree(column.key);
      }
    }
  }, [loadColumnTree, webAccessState.isConnected]);

  // ============ Action Handlers ============

  // Set default backend (just updates cookie, no directory picker prompt)
  const handleSetDefault = useCallback(
    (backend: FilesystemBackend) => {
      setBackendCookie(backend);
    },
    [setBackendCookie],
  );

  // Connect a new workspace directory for webaccess
  const handleConnectDirectory = useCallback(async () => {
    try {
      const newHandle = await globalThis.window.showDirectoryPicker({
        id: 'tau-workspace',
        mode: 'readwrite',
      });

      await storeDirectoryHandle(newHandle);
      setWebAccessState({
        directoryName: newHandle.name,
        isConnected: true,
        needsPermission: false,
      });
      // Reload webaccess tree with the new directory
      void loadColumnTree('webaccess');
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }

      throw error;
    }
  }, [loadColumnTree]);

  // Grant permission on existing workspace handle
  const handleGrantAccess = useCallback(async () => {
    const storedHandle = await getStoredDirectoryHandle();
    if (!storedHandle) {
      return;
    }

    const granted = await requestHandlePermission(storedHandle);
    if (granted) {
      setWebAccessState((previous) => ({
        ...previous,
        isConnected: true,
        needsPermission: false,
      }));
      void loadColumnTree('webaccess');
    }
  }, [loadColumnTree]);

  // Change workspace directory (opens picker for a new directory)
  const handleChangeDirectory = useCallback(async () => {
    await handleConnectDirectory();
  }, [handleConnectDirectory]);

  // Get rmdir function from the worker for recursive directory deletion
  const deleteDirectory = useCallback(
    async (path: string): Promise<void> => {
      const snapshot = fileManagerRef.getSnapshot();
      const worker = snapshot.context.wrappedWorker;
      if (!worker) {
        throw new Error('Worker not ready');
      }

      const deleteRecursive = async (dirPath: string): Promise<void> => {
        const entries = await worker.readdir(dirPath);
        for (const entry of entries) {
          const fullPath = `${dirPath}/${entry}`.replace('//', '/');
          // eslint-disable-next-line no-await-in-loop -- need sequential processing for correct deletion order
          const stats = await worker.stat(fullPath);
          // eslint-disable-next-line no-await-in-loop -- need sequential processing for correct deletion order
          await (stats.type === 'dir' ? deleteRecursive(fullPath) : worker.unlink(fullPath));
        }

        await worker.rmdir(dirPath);
      };

      await deleteRecursive(path);
    },
    [fileManagerRef],
  );

  // Handle file deletion (refreshes all trees since we don't know which backend)
  const handleDeleteFile = useCallback(
    async (path: string) => {
      await deleteFile(path, { source: 'user' });
      // Refresh all supported trees
      for (const column of backendColumns) {
        if (column.isSupported) {
          void loadColumnTree(column.key);
        }
      }
    },
    [deleteFile, loadColumnTree],
  );

  // Handle file download
  const handleDownloadFile = useCallback(
    async (path: string) => {
      const content = await readFile(path);
      const filename = path.split('/').pop() ?? 'file';
      const blob = new Blob([content]);
      downloadBlob(blob, filename);
    },
    [readFile],
  );

  // Handle folder deletion
  const handleDeleteFolder = useCallback(
    async (path: string) => {
      await deleteDirectory(path);
      for (const column of backendColumns) {
        if (column.isSupported) {
          void loadColumnTree(column.key);
        }
      }
    },
    [deleteDirectory, loadColumnTree],
  );

  // Handle folder download as ZIP
  const handleDownloadFolderZip = useCallback(
    async (path: string) => {
      const blob = await getZippedDirectory(path);
      const folderName = path.split('/').pop() ?? 'folder';
      downloadBlob(blob, `${folderName}.zip`);
    },
    [getZippedDirectory],
  );

  // Combine handlers for renderTree
  const treeActionHandlers: TreeActionHandlers = {
    onDeleteFile: handleDeleteFile,
    onDownloadFile: handleDownloadFile,
    onDeleteFolder: handleDeleteFolder,
    onDownloadFolderZip: handleDownloadFolderZip,
    buildsMap,
  };

  return (
    <div className="flex h-full flex-col gap-4 px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="shrink-0 text-3xl font-medium tracking-tight">Files</h1>
      </div>

      {/* 3-column grid */}
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[1fr] gap-4 overflow-hidden md:grid-cols-2">
        {backendColumns.map((column) => (
          <BackendColumn
            key={column.key}
            meta={column}
            isDefault={backendCookie === column.key}
            treeActionHandlers={treeActionHandlers}
            fileTree={columnTrees[column.key] ?? []}
            isLoading={columnLoading[column.key] ?? false}
            webAccessState={column.key === 'webaccess' ? webAccessState : undefined}
            onRefresh={() => {
              void loadColumnTree(column.key);
            }}
            onSetDefault={() => {
              handleSetDefault(column.key);
            }}
            onConnectDirectory={column.key === 'webaccess' ? handleConnectDirectory : undefined}
            onGrantAccess={column.key === 'webaccess' ? handleGrantAccess : undefined}
            onChangeDirectory={column.key === 'webaccess' ? handleChangeDirectory : undefined}
          />
        ))}
      </div>
    </div>
  );
}
