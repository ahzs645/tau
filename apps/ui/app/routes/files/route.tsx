import { useState, useCallback, useEffect, useMemo } from 'react';
import { Link } from 'react-router';
import {
  Database,
  Download,
  FolderArchive,
  HardDrive,
  MemoryStick,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FilesystemBackend, Build } from '@taucad/types';
import { filesystemBackendMeta } from '@taucad/types/constants';
import { ExternalLink } from '#components/external-link.js';
import { Button } from '#components/ui/button.js';
import { ComboBoxResponsive } from '#components/ui/combobox-responsive.js';
import { Tree, Folder, File } from '#components/magicui/file-tree.js';
import type { TreeViewElement } from '#components/magicui/file-tree.js';
import { Loader } from '#components/ui/loader.js';
import { useCookie } from '#hooks/use-cookie.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { useBuilds } from '#hooks/use-builds.js';
import { cookieName } from '#constants/cookie.constants.js';
import { isOpfsSupported } from '#constants/browser.constants.js';
import type { Handle } from '#types/matches.types.js';
import { cn } from '#utils/ui.utils.js';

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
 * Backend option type for ComboBoxResponsive
 */
type BackendOption = {
  value: FilesystemBackend;
  label: string;
  description: string;
  icon: LucideIcon;
};

/**
 * Backend options with icons
 */
const backendOptions: BackendOption[] = [
  {
    value: 'indexeddb',
    ...filesystemBackendMeta.indexeddb,
    icon: Database,
  },
  {
    value: 'opfs',
    ...filesystemBackendMeta.opfs,
    icon: HardDrive,
  },
  {
    value: 'memory',
    ...filesystemBackendMeta.memory,
    icon: MemoryStick,
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
 * Build tree structure from filesystem
 */
async function buildFileTree(
  readdir: (path: string) => Promise<string[]>,
  stat: (path: string) => Promise<{ type: 'file' | 'dir' }>,
  path: string,
): Promise<TreeViewElement[]> {
  try {
    const entries = await readdir(path);
    const elements: TreeViewElement[] = [];

    for (const entry of entries) {
      const fullPath = `${path}/${entry}`.replace('//', '/');
      try {
        // eslint-disable-next-line no-await-in-loop -- need sequential processing for correct tree building
        const stats = await stat(fullPath);
        if (stats.type === 'dir') {
          elements.push({
            id: fullPath,
            name: entry,
            // eslint-disable-next-line no-await-in-loop -- need sequential processing for correct tree building
            children: await buildFileTree(readdir, stat, fullPath),
          });
        } else {
          elements.push({
            id: fullPath,
            name: entry,
          });
        }
      } catch {
        // Skip files that can't be stat'd
      }
    }

    // Sort: folders first, then alphabetically
    return elements.sort((a, b) => {
      const aIsFolder = a.children !== undefined;
      const bIsFolder = b.children !== undefined;
      if (aIsFolder && !bIsFolder) {
        return -1;
      }

      if (!aIsFolder && bIsFolder) {
        return 1;
      }

      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  } catch {
    return [];
  }
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

export default function FilesRoute(): React.JSX.Element {
  const [backendCookie, setBackendCookie] = useCookie(cookieName.filesystemBackend, 'indexeddb' as FilesystemBackend);
  const { fileManagerRef, reconfigureBackend, readdir, readFile, deleteFile, getZippedDirectory } = useFileManager();
  const { builds } = useBuilds();
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [fileTree, setFileTree] = useState<TreeViewElement[]>([]);

  // Create a lookup map for builds by ID
  const buildsMap = useMemo(() => new Map(builds.map((build) => [build.id, build])), [builds]);

  // Get stat function from the worker
  const getStat = useCallback(
    async (path: string): Promise<{ type: 'file' | 'dir' }> => {
      const snapshot = fileManagerRef.getSnapshot();
      const worker = snapshot.context.wrappedWorker;
      if (!worker) {
        throw new Error('Worker not ready');
      }

      const stats = await worker.stat(path);
      return { type: stats.type };
    },
    [fileManagerRef],
  );

  // Get rmdir function from the worker for recursive directory deletion
  const deleteDirectory = useCallback(
    async (path: string): Promise<void> => {
      const snapshot = fileManagerRef.getSnapshot();
      const worker = snapshot.context.wrappedWorker;
      if (!worker) {
        throw new Error('Worker not ready');
      }

      // Recursively delete directory contents first
      const deleteRecursive = async (dirPath: string): Promise<void> => {
        const entries = await worker.readdir(dirPath);
        for (const entry of entries) {
          const fullPath = `${dirPath}/${entry}`.replace('//', '/');
          // eslint-disable-next-line no-await-in-loop -- need sequential processing for correct deletion order
          const stats = await worker.stat(fullPath);
          // eslint-disable-next-line no-await-in-loop -- need sequential processing for correct deletion order
          await (stats.type === 'dir' ? deleteRecursive(fullPath) : worker.unlink(fullPath));
        }

        // Delete the now-empty directory
        await worker.rmdir(dirPath);
      };

      await deleteRecursive(path);
    },
    [fileManagerRef],
  );

  // Load file tree
  const loadFileTree = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const tree = await buildFileTree(async (path) => readdir(path), getStat, '/');
      setFileTree(tree);
    } finally {
      setIsRefreshing(false);
    }
  }, [readdir, getStat]);

  // Load file tree on mount
  useEffect(() => {
    void loadFileTree();
  }, [loadFileTree]);

  // Handle backend change
  const handleBackendChange = useCallback(
    async (value: string) => {
      const backend = value as FilesystemBackend;
      setBackendCookie(backend);
      setIsLoading(true);
      try {
        await reconfigureBackend(backend);
        await loadFileTree();
      } finally {
        setIsLoading(false);
      }
    },
    [reconfigureBackend, setBackendCookie, loadFileTree],
  );

  // Handle file deletion
  const handleDeleteFile = useCallback(
    async (path: string) => {
      await deleteFile(path, { source: 'user' });
      await loadFileTree();
    },
    [deleteFile, loadFileTree],
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
      await loadFileTree();
    },
    [deleteDirectory, loadFileTree],
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

  // Get current backend option
  const currentBackendOption = backendOptions.find((option) => option.value === backendCookie) ?? backendOptions[0]!;

  return (
    <div className="container mx-auto flex h-full max-w-4xl flex-col gap-4 px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="shrink-0 text-3xl font-medium tracking-tight">Files</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-2" disabled={isRefreshing} onClick={loadFileTree}>
            <RefreshCw className={cn('size-4', isRefreshing && 'animate-spin')} />
            Refresh
          </Button>
          <ComboBoxResponsive
            groupedItems={[{ name: 'Storage Backends', items: backendOptions }]}
            defaultValue={currentBackendOption}
            getValue={(item) => item.value}
            renderLabel={(item) => (
              <div className="flex items-center gap-2">
                <item.icon className="size-4" />
                <div className="flex flex-col items-start">
                  <span>{item.label}</span>
                  <span className="text-xs text-muted-foreground">{item.description}</span>
                </div>
              </div>
            )}
            popoverProperties={{ className: 'w-[320px]', align: 'end' }}
            isDisabled={(item) => item.value === 'opfs' && !isOpfsSupported}
            title="Select Storage Backend"
            description="Choose where to store files"
            isSearchEnabled={false}
            onSelect={handleBackendChange}
          >
            <Button variant="outline" className="gap-2" disabled={isLoading}>
              {isLoading ? <Loader className="size-4" /> : <currentBackendOption.icon className="size-4" />}
              {currentBackendOption.label}
            </Button>
          </ComboBoxResponsive>
        </div>
      </div>

      {/* File Tree */}
      <div className="flex-1 overflow-hidden rounded-md border">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader className="size-8" />
          </div>
        ) : fileTree.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">No files found</div>
        ) : (
          <Tree elements={fileTree}>{renderTree(fileTree, treeActionHandlers)}</Tree>
        )}
      </div>
    </div>
  );
}
