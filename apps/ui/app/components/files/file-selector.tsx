import type { ReactNode } from 'react';
import { useState, useMemo, useCallback } from 'react';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import { useIsMobile } from '#hooks/use-mobile.js';
import { Command, CommandInput, CommandItem, CommandList } from '#components/ui/command.js';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle, DrawerTrigger } from '#components/ui/drawer.js';
import { Popover, PopoverContent, PopoverTrigger } from '#components/ui/popover.js';
import { Button } from '#components/ui/button.js';
import { FileExtensionIcon } from '#components/icons/file-extension-icon.js';
import { cn } from '#utils/ui.utils.js';
import { LoadingSpinner } from '#components/ui/loading-spinner.js';

type FileItem = {
  path: string;
  size?: number;
};

type FileSelectorProps = {
  readonly files: FileItem[];
  readonly selectedFile: string | undefined;
  readonly onSelect: (file: string) => void;
  readonly placeholder?: string;
  readonly isLoading?: boolean;
  readonly isDisabled?: boolean;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly title?: string;
  readonly description?: string;
  readonly searchPlaceholder?: string;
  readonly emptyMessage?: string;
  readonly virtualizationThreshold?: number;
};

type TreeNode = {
  name: string;
  path: string;
  isFolder: boolean;
  size?: number;
  children: Map<string, TreeNode>;
};

/**
 * Build tree structure from flat file paths
 */
function buildTree(files: FileItem[]): TreeNode {
  const root: TreeNode = {
    name: '',
    path: '',
    isFolder: true,
    children: new Map(),
  };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!part) {
        continue;
      }

      const isLastPart = index === parts.length - 1;
      const currentPath = parts.slice(0, index + 1).join('/');

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: currentPath,
          isFolder: !isLastPart,
          size: isLastPart ? file.size : undefined,
          children: new Map(),
        });
      }

      const node = current.children.get(part);
      if (node) {
        current = node;
      }
    }
  }

  return root;
}

/**
 * Get items at a specific path level
 */
function getItemsAtPath(root: TreeNode, currentPath: string): TreeNode[] {
  if (!currentPath) {
    return [...root.children.values()].sort(sortNodes);
  }

  const parts = currentPath.split('/');
  let current = root;

  for (const part of parts) {
    const child = current.children.get(part);
    if (!child) {
      return [];
    }

    current = child;
  }

  return [...current.children.values()].sort(sortNodes);
}

/**
 * Sort nodes: folders first, then alphabetically
 */
function sortNodes(a: TreeNode, b: TreeNode): number {
  if (a.isFolder && !b.isFolder) {
    return -1;
  }

  if (!a.isFolder && b.isFolder) {
    return 1;
  }

  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/**
 * Format bytes to human-readable size
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

/**
 * Get breadcrumb segments from a path
 */
function getBreadcrumbs(path: string): Array<{ name: string; path: string }> {
  if (!path) {
    return [];
  }

  const parts = path.split('/');
  const crumbs: Array<{ name: string; path: string }> = [];

  for (let i = 0; i < parts.length; i++) {
    crumbs.push({
      name: parts[i] ?? '',
      path: parts.slice(0, i + 1).join('/'),
    });
  }

  return crumbs;
}

/**
 * Breadcrumb navigation component
 */
function BreadcrumbNav({
  currentPath,
  onNavigate,
}: {
  readonly currentPath: string;
  readonly onNavigate: (path: string) => void;
}): React.JSX.Element {
  const crumbs = getBreadcrumbs(currentPath);

  return (
    <div className="flex items-center gap-1 border-b px-2 py-1.5 text-sm">
      <button
        type="button"
        className={cn(
          'rounded px-1.5 py-0.5 hover:bg-muted',
          currentPath === '' && 'font-medium text-foreground',
          currentPath !== '' && 'text-muted-foreground',
        )}
        onClick={() => {
          onNavigate('');
        }}
      >
        Files
      </button>
      {crumbs.map((crumb, index) => (
        <div key={crumb.path} className="flex items-center gap-1">
          <ChevronRight className="size-3 text-muted-foreground" />
          <button
            type="button"
            className={cn(
              'max-w-32 truncate rounded px-1.5 py-0.5 hover:bg-muted',
              index === crumbs.length - 1 && 'font-medium text-foreground',
              index !== crumbs.length - 1 && 'text-muted-foreground',
            )}
            onClick={() => {
              onNavigate(crumb.path);
            }}
          >
            {crumb.name}
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Render a single file/folder item
 */
function FileSelectorItem({
  item,
  isSelected,
  onDrillDown,
  onSelect,
}: {
  readonly item: TreeNode;
  readonly isSelected: boolean;
  readonly onDrillDown: (path: string) => void;
  readonly onSelect: (path: string) => void;
}): React.JSX.Element {
  // For folders, use a button that doesn't trigger CommandItem's close behavior
  if (item.isFolder) {
    return (
      <button
        type="button"
        className="hover:text-accent-foreground flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent"
        onClick={() => {
          onDrillDown(item.path);
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Folder className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{item.name}</span>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </button>
    );
  }

  // For files, use CommandItem which will close the popover on selection
  return (
    <CommandItem
      value={item.path}
      className="flex items-center justify-between gap-2"
      onSelect={() => {
        onSelect(item.path);
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <FileExtensionIcon filename={item.name} className="size-4 shrink-0" />
        <span className={cn('truncate', isSelected && 'font-medium')}>{item.name}</span>
      </div>
      {item.size === undefined ? undefined : (
        <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(item.size)}</span>
      )}
    </CommandItem>
  );
}

/**
 * File selector item list
 */
function FileSelectorList({
  items,
  selectedFile,
  searchQuery,
  virtualizationThreshold,
  emptyMessage,
  onDrillDown,
  onSelect,
}: {
  readonly items: TreeNode[];
  readonly selectedFile: string | undefined;
  readonly searchQuery: string;
  readonly virtualizationThreshold: number;
  readonly emptyMessage: string;
  readonly onDrillDown: (path: string) => void;
  readonly onSelect: (path: string) => void;
}): React.JSX.Element {
  // Filter items based on search query
  const filteredItems = useMemo(() => {
    if (!searchQuery) {
      return items;
    }

    const query = searchQuery.toLowerCase();
    return items.filter((item) => item.name.toLowerCase().includes(query));
  }, [items, searchQuery]);

  const renderItem = useCallback(
    (index: number) => {
      const item = filteredItems[index];
      if (!item) {
        return undefined;
      }

      return (
        <FileSelectorItem
          key={item.path}
          item={item}
          isSelected={selectedFile === item.path}
          onDrillDown={onDrillDown}
          onSelect={onSelect}
        />
      );
    },
    [filteredItems, selectedFile, onDrillDown, onSelect],
  );

  // Show empty message when no items match
  if (filteredItems.length === 0) {
    return <div className="py-6 text-center text-sm text-muted-foreground">{emptyMessage}</div>;
  }

  if (filteredItems.length > virtualizationThreshold) {
    return (
      <Virtuoso
        style={{ height: '300px' }}
        totalCount={filteredItems.length}
        itemContent={renderItem}
        className="overflow-y-auto"
      />
    );
  }

  return (
    <>
      {filteredItems.map((item) => (
        <FileSelectorItem
          key={item.path}
          item={item}
          isSelected={selectedFile === item.path}
          onDrillDown={onDrillDown}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export function FileSelector({
  files,
  selectedFile,
  onSelect,
  placeholder = 'Select file...',
  isLoading = false,
  isDisabled = false,
  children,
  className,
  title = 'Select File',
  description = 'Choose a file from the list',
  searchPlaceholder = 'Search files...',
  emptyMessage = 'No files found.',
  virtualizationThreshold = 50,
}: FileSelectorProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const isMobile = useIsMobile();

  // Build tree from files
  const tree = useMemo(() => buildTree(files), [files]);

  // Get items at current path
  const currentItems = useMemo(() => getItemsAtPath(tree, currentPath), [tree, currentPath]);

  // Reset path when opening
  const handleOpenChange = useCallback((isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) {
      setCurrentPath('');
      setSearchQuery('');
    }
  }, []);

  // Handle file selection
  const handleSelect = useCallback(
    (path: string) => {
      onSelect(path);
      setOpen(false);
    },
    [onSelect],
  );

  // Handle folder drill-down
  const handleDrillDown = useCallback((path: string) => {
    setCurrentPath(path);
    setSearchQuery('');
  }, []);

  // Handle breadcrumb navigation
  const handleNavigate = useCallback((path: string) => {
    setCurrentPath(path);
    setSearchQuery('');
  }, []);

  // Get selected file display name
  const selectedFileName = selectedFile?.split('/').pop();

  // Default trigger button
  const triggerButton = children ?? (
    <Button variant="outline" className={cn('w-full justify-between', className)} disabled={isDisabled || isLoading}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {isLoading ? (
          <LoadingSpinner className="size-4" />
        ) : selectedFile ? (
          <FileExtensionIcon filename={selectedFile} className="size-4 shrink-0" />
        ) : undefined}
        <span className={cn('truncate', !selectedFile && 'text-muted-foreground')}>
          {selectedFileName ?? placeholder}
        </span>
      </div>
      <ChevronDown className="size-4 shrink-0" />
    </Button>
  );

  const content = (
    <Command shouldFilter={false} className="flex flex-col">
      <BreadcrumbNav currentPath={currentPath} onNavigate={handleNavigate} />
      <CommandInput placeholder={searchPlaceholder} value={searchQuery} onValueChange={setSearchQuery} />
      <CommandList className="max-h-[300px] p-1">
        <FileSelectorList
          items={currentItems}
          selectedFile={selectedFile}
          searchQuery={searchQuery}
          virtualizationThreshold={virtualizationThreshold}
          emptyMessage={emptyMessage}
          onDrillDown={handleDrillDown}
          onSelect={handleSelect}
        />
      </CommandList>
    </Command>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={handleOpenChange}>
        <DrawerTrigger asChild>{triggerButton}</DrawerTrigger>
        <DrawerContent aria-labelledby="drawer-title" aria-describedby="drawer-description">
          <DrawerTitle className="sr-only" id="drawer-title">
            {title}
          </DrawerTitle>
          <DrawerDescription className="sr-only" id="drawer-description">
            {description}
          </DrawerDescription>
          {content}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
      <PopoverContent className={cn('w-[300px] p-0', className)}>{content}</PopoverContent>
    </Popover>
  );
}
