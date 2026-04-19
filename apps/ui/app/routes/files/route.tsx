import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router';
import {
  Database,
  Download,
  FolderArchive,
  FolderOpen,
  HardDrive,
  MoreHorizontal,
  RefreshCw,
  Star,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FileSystemBackend, Project } from '@taucad/types';
import { ExternalLink } from '#components/external-link.js';
import { Button } from '#components/ui/button.js';
import { ComboBoxResponsive } from '#components/ui/combobox-responsive.js';
import { Loader } from '#components/ui/loader.js';
import { Tree, Folder, File } from '#components/magicui/file-tree.js';
import type { TreeViewElement } from '#components/magicui/file-tree.js';
import { useCookie } from '#hooks/use-cookie.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { useProjects } from '#hooks/use-projects.js';
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
import type { FileTreeNode } from '@taucad/filesystem';
import { joinPath, parentDirectory } from '@taucad/utils/path';

export const handle: Handle = {
  breadcrumb() {
    return (
      <Button asChild variant='ghost'>
        <Link to='/files'>Files</Link>
      </Button>
    );
  },
};

/**
 * Backend column metadata.
 */
type BackendColumnMeta = {
  key: FileSystemBackend;
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
  {
    key: 'opfs',
    label: 'OPFS',
    icon: HardDrive,
    description: 'Origin Private File System',
    isSupported: typeof navigator !== 'undefined' && 'storage' in navigator,
  },
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
  {
    value: 'delete',
    label: 'Delete Directory',
    icon: Trash2,
    variant: 'destructive',
  },
];

/**
 * Extract project ID from a path that is exactly "/projects/proj_xxx" (not subfolders)
 */
function extractProjectId(path: string): string | undefined {
  const match = /^\/projects\/([^/]+)$/.exec(path);
  return match?.[1];
}

/**
 * Link to a project page that opens in a new tab
 */
function ProjectLink({
  projectId,
  projectName,
}: {
  readonly projectId: string;
  readonly projectName: string;
}): React.JSX.Element {
  return (
    <span
      role='presentation'
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      <ExternalLink
        withArrow
        isArrowOnHoverOnly
        href={`/projects/${projectId}`}
        className='text-xs text-muted-foreground max-md:hidden'
        arrowSize='xs'
      >
        {projectName}
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
          <item.icon className='size-4' />
          <span>{item.label}</span>
        </div>
      )}
      title='File Actions'
      description='Choose an action for this file'
      isSearchEnabled={false}
      onSelect={handleAction}
    >
      <Button
        variant='ghost'
        size='icon'
        className='size-6 shrink-0'
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <MoreHorizontal className='size-4' />
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
          <item.icon className='size-4' />
          <span>{item.label}</span>
        </div>
      )}
      title='Folder Actions'
      description='Choose an action for this folder'
      isSearchEnabled={false}
      onSelect={handleAction}
    >
      <Button
        variant='ghost'
        size='icon'
        className='size-6 shrink-0'
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <MoreHorizontal className='size-4' />
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
  projectsMap: Map<string, Project>;
};

/**
 * Compose folder label with optional project link
 */
function FolderLabel({ name, project }: { readonly name: string; readonly project?: Project }): React.JSX.Element {
  return (
    <span className='inline-flex items-center gap-2'>
      <span>{name}</span>
      {project ? <ProjectLink projectId={project.id} projectName={project.name} /> : undefined}
    </span>
  );
}

/**
 * Render tree elements recursively
 */
function renderTree(elements: TreeViewElement[], handlers: TreeActionHandlers): React.ReactNode {
  return elements.map((element) => {
    if (element.children) {
      // Check if this folder corresponds to a project
      const projectId = extractProjectId(element.id);
      const project = projectId ? handlers.projectsMap.get(projectId) : undefined;

      return (
        <Folder
          key={element.id}
          element={<FolderLabel name={element.name} project={project} />}
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
 * Recursively count entries whose name starts with `proj_` (project directories).
 */
function countProjects(elements: TreeViewElement[]): number {
  let count = 0;
  for (const element of elements) {
    if (element.name.startsWith('proj_')) {
      count += 1;
    }

    if (element.children) {
      count += countProjects(element.children);
    }
  }

  return count;
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
  onExpand,
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
  readonly onExpand?: (id: string) => void;
}): React.JSX.Element {
  const Icon = meta.icon;
  const isDisabled = !meta.isSupported;

  return (
    <div className={cn('flex min-h-0 flex-col gap-3 rounded-lg border bg-card p-4', isDisabled && 'opacity-50')}>
      {/* Column Header */}
      <div className='flex items-start justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <Icon className='size-4 shrink-0 text-muted-foreground' />
          <div className='flex flex-col gap-0.5'>
            <div className='flex items-center gap-2'>
              <span className='text-sm font-medium'>{meta.label}</span>
              {countProjects(fileTree) > 0 ? (
                <span className='rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground'>
                  {countProjects(fileTree)}
                </span>
              ) : undefined}
            </div>
            {meta.key === 'webaccess' && webAccessState?.directoryName ? (
              <span className='inline-flex items-center gap-1 text-xs text-muted-foreground'>
                {webAccessState.directoryName} -{' '}
                <Button variant='link' size='xs' className='h-auto p-0 text-xs' onClick={onChangeDirectory}>
                  Change Directory
                </Button>
              </span>
            ) : (
              <span className='text-xs text-muted-foreground'>{meta.description}</span>
            )}
          </div>
        </div>
        <div className='flex items-center gap-1'>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant='ghost'
                size='icon'
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
                variant='ghost'
                size='icon'
                className='size-7'
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
        <div className='flex flex-1 items-center justify-center rounded-md border border-dashed p-6 text-sm text-muted-foreground'>
          Not supported in this browser
        </div>
      ) : (
        <div className='min-h-0 flex-1 overflow-auto rounded-md border'>
          {isLoading ? (
            <div className='flex h-32 items-center justify-center'>
              <Loader className='size-6' />
            </div>
          ) : fileTree.length === 0 ? (
            <div className='flex h-32 items-center justify-center text-sm text-muted-foreground'>No files found</div>
          ) : (
            <Tree elements={fileTree} onExpand={onExpand}>
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
      <Button variant='outline' size='sm' className='gap-2' onClick={onConnect}>
        <FolderOpen className='size-4' />
        Connect Directory
      </Button>
    );
  }

  if (state.needsPermission) {
    return (
      <div className='border-amber-500/30 bg-amber-500/10 flex items-center justify-between gap-2 rounded-md border px-3 py-2'>
        <div className='flex items-center gap-2'>
          <FolderOpen className='text-amber-600 size-3.5 shrink-0' />
          <span className='text-xs'>{state.directoryName}</span>
        </div>
        <Button size='sm' variant='outline' className='h-7 text-xs' onClick={onGrantAccess}>
          Grant Access
        </Button>
      </div>
    );
  }

  return undefined;
}

// ============ Main Route Component ============

export default function FilesRoute(): React.JSX.Element {
  const [backendCookie, setBackendCookie] = useCookie(cookieName.filesystemBackend, 'indexeddb' as FileSystemBackend);
  const { fileManagerRef, readFile, deleteFile, getZippedDirectory, readShallowDirectory } = useFileManager();
  const { projects } = useProjects();

  // Loaded directories per backend: backend → (directoryPath → FileTreeNode[])
  const [loadedDirectories, setLoadedDirectories] = useState<Record<string, Map<string, FileTreeNode[]>>>({});
  const [rootLoading, setRootLoading] = useState<Record<string, boolean>>({});
  const inflightRef = useRef<Set<string>>(new Set());
  // WebAccess directory state
  const [webAccessState, setWebAccessState] = useState<WebAccessDirectoryState>({
    directoryName: undefined,
    isConnected: false,
    needsPermission: false,
  });

  // Create a lookup map for projects by ID
  const projectsMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

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

  // Load a directory lazily
  const loadDirectory = useCallback(
    async (backend: FileSystemBackend, directoryPath: string): Promise<void> => {
      const inflightKey = `${backend}:${directoryPath}`;
      if (inflightRef.current.has(inflightKey)) {
        return;
      }
      inflightRef.current.add(inflightKey);

      try {
        const nodes = await readShallowDirectory(directoryPath, backend);
        setLoadedDirectories((previous) => {
          const backendDirectories = new Map(previous[backend] ?? []);
          backendDirectories.set(directoryPath, nodes);
          return { ...previous, [backend]: backendDirectories };
        });
      } catch {
        setLoadedDirectories((previous) => {
          const backendDirectories = new Map(previous[backend] ?? []);
          backendDirectories.set(directoryPath, []);
          return { ...previous, [backend]: backendDirectories };
        });
      } finally {
        inflightRef.current.delete(inflightKey);
      }
    },
    [readShallowDirectory],
  );

  // Build a tree from loaded directories
  const projectTreeFromDirectories = useCallback(
    (backend: FileSystemBackend): TreeViewElement[] => {
      const directories = loadedDirectories[backend];
      if (!directories) {
        return [];
      }

      const buildSubtree = (nodes: FileTreeNode[]): TreeViewElement[] =>
        nodes.map((node) => {
          if (node.children !== undefined) {
            const childEntries = directories.get(node.id);
            return {
              id: node.id,
              name: node.name,
              children: childEntries ? buildSubtree(childEntries) : [],
            };
          }
          return { id: node.id, name: node.name };
        });

      const rootEntries = directories.get('/');
      if (!rootEntries) {
        return [];
      }
      return buildSubtree(rootEntries);
    },
    [loadedDirectories],
  );

  // Handle folder expansion for lazy loading
  const handleExpand = useCallback(
    (id: string, backend: FileSystemBackend) => {
      const directories = loadedDirectories[backend];
      if (directories?.has(id)) {
        return;
      }
      void loadDirectory(backend, id);
    },
    [loadedDirectories, loadDirectory],
  );

  // Load root trees on mount
  const loadColumnTree = useCallback(
    async (backend: FileSystemBackend): Promise<void> => {
      setRootLoading((previous) => ({ ...previous, [backend]: true }));
      await loadDirectory(backend, '/');
      setRootLoading((previous) => ({ ...previous, [backend]: false }));
    },
    [loadDirectory],
  );

  // Handle refresh: clear inflight tracking and re-fetch all loaded paths
  const handleRefresh = useCallback(
    (backend: FileSystemBackend) => {
      // Clear inflight keys for this backend so they can be re-fetched
      for (const key of inflightRef.current) {
        if (key.startsWith(`${backend}:`)) {
          inflightRef.current.delete(key);
        }
      }
      const directories = loadedDirectories[backend];
      if (!directories || directories.size === 0) {
        void loadColumnTree(backend);
        return;
      }
      for (const directoryPath of directories.keys()) {
        void loadDirectory(backend, directoryPath);
      }
    },
    [loadedDirectories, loadDirectory, loadColumnTree],
  );

  // Load all column trees on mount
  useEffect(() => {
    for (const column of backendColumns) {
      if (column.isSupported) {
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
    (backend: FileSystemBackend) => {
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
      // Reload webaccess tree
      setLoadedDirectories((previous) => ({ ...previous, webaccess: new Map() }));
      void loadColumnTree('webaccess');
    } catch (error) {
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
      setLoadedDirectories((previous) => ({ ...previous, webaccess: new Map() }));
      void loadColumnTree('webaccess');
    }
  }, [loadColumnTree]);

  // Change workspace directory (opens picker for a new directory)
  const handleChangeDirectory = useCallback(async () => {
    await handleConnectDirectory();
  }, [handleConnectDirectory]);

  const deleteDirectory = useCallback(
    async (path: string): Promise<void> => {
      const snapshot = fileManagerRef.getSnapshot();
      const { proxy } = snapshot.context;
      if (!proxy) {
        throw new Error('Worker not ready');
      }

      const deleteRecursive = async (directoryPath: string): Promise<void> => {
        const entries = await proxy.readdir(directoryPath);
        for (const entry of entries) {
          const fullPath = joinPath(directoryPath, entry);
          // oxlint-disable-next-line no-await-in-loop -- need sequential processing for correct deletion order
          const stats = await proxy.stat(fullPath);
          // oxlint-disable-next-line no-await-in-loop -- need sequential processing for correct deletion order
          await (stats.type === 'dir' ? deleteRecursive(fullPath) : proxy.unlink(fullPath));
        }

        await proxy.rmdir(directoryPath);
      };

      await deleteRecursive(path);
    },
    [fileManagerRef],
  );

  // Handle file deletion — invalidate parent directory in all backends
  const handleDeleteFile = useCallback(
    async (path: string) => {
      await deleteFile(path, { source: 'user' });
      const parentPath = parentDirectory(path);
      for (const column of backendColumns) {
        if (column.isSupported) {
          void loadDirectory(column.key, parentPath);
        }
      }
    },
    [deleteFile, loadDirectory],
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

  // Handle folder deletion — invalidate parent directory
  const handleDeleteFolder = useCallback(
    async (path: string) => {
      await deleteDirectory(path);
      const parentPath = parentDirectory(path);
      for (const column of backendColumns) {
        if (column.isSupported) {
          void loadDirectory(column.key, parentPath);
        }
      }
    },
    [deleteDirectory, loadDirectory],
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
    projectsMap,
  };

  return (
    <div className='flex h-full flex-col gap-4 px-6 py-8'>
      {/* Header */}
      <div className='flex items-center justify-between gap-4'>
        <h1 className='shrink-0 text-3xl font-medium tracking-tight'>Files</h1>
      </div>

      {/* 3-column grid */}
      <div className='grid min-h-0 flex-1 grid-cols-1 grid-rows-[1fr] gap-4 overflow-hidden md:grid-cols-3'>
        {backendColumns.map((column) => (
          <BackendColumn
            key={column.key}
            meta={column}
            isDefault={backendCookie === column.key}
            treeActionHandlers={treeActionHandlers}
            fileTree={projectTreeFromDirectories(column.key)}
            isLoading={rootLoading[column.key] ?? false}
            webAccessState={column.key === 'webaccess' ? webAccessState : undefined}
            onRefresh={() => {
              handleRefresh(column.key);
            }}
            onSetDefault={() => {
              handleSetDefault(column.key);
            }}
            onConnectDirectory={column.key === 'webaccess' ? handleConnectDirectory : undefined}
            onGrantAccess={column.key === 'webaccess' ? handleGrantAccess : undefined}
            onChangeDirectory={column.key === 'webaccess' ? handleChangeDirectory : undefined}
            onExpand={(id) => {
              handleExpand(id, column.key);
            }}
          />
        ))}
      </div>
    </div>
  );
}
