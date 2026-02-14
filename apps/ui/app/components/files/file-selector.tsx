import type { ReactNode } from 'react';
import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import { useIsMobile } from '#hooks/use-mobile.js';
import { useHorizontalScroll } from '#hooks/use-horizontal-scroll.js';
import { Command, CommandInput, CommandItem, CommandList } from '#components/ui/command.js';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle, DrawerTrigger } from '#components/ui/drawer.js';
import { Popover, PopoverContent, PopoverTrigger } from '#components/ui/popover.js';
import { Button } from '#components/ui/button.js';
import { FileExtensionIcon } from '#components/icons/file-extension-icon.js';
import { cn } from '#utils/ui.utils.js';
import { menuItemLayoutClass } from '#components/ui/menu.variants.js';
import { Loader } from '#components/ui/loader.js';

type FileItem = {
  path: string;
  size?: number;
};

type FileSelectorProps = {
  readonly popoverProperties?: React.ComponentProps<typeof PopoverContent>;
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
  /** Directory path to show when opened. If not provided, navigates to parent of selectedFile. */
  readonly initialPath?: string;
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
 * Recursively search tree for files matching the query
 */
function searchFilesRecursively(node: TreeNode, query: string): TreeNode[] {
  const results: TreeNode[] = [];
  const lowerQuery = query.toLowerCase();

  function traverse(current: TreeNode): void {
    for (const child of current.children.values()) {
      if (child.isFolder) {
        traverse(child);
      } else if (child.name.toLowerCase().includes(lowerQuery)) {
        results.push(child);
      }
    }
  }

  traverse(node);
  return results.sort(sortNodes);
}

/**
 * Get a relative directory hint for a file path from a base path
 */
function getDirectoryHint(filePath: string, basePath: string): string {
  const parts = filePath.split('/');
  parts.pop();
  const directory = parts.join('/');

  if (!directory) {
    return '';
  }

  if (!basePath) {
    return directory;
  }

  if (directory === basePath) {
    return '';
  }

  if (directory.startsWith(basePath + '/')) {
    return directory.slice(basePath.length + 1);
  }

  return directory;
}

/**
 * Format bytes to human-readable size.
 * Supports sizes up to Quettabytes (QB, ~10^30 bytes).
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }

  const k = 1024;
  // SI byte units: B, KB, MB, GB, TB, PB, EB, ZB, YB, RB, QB
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB', 'RB', 'QB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);

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
 * Keeps "Files" root fixed, makes the rest scrollable with auto-scroll to current level
 */
function BreadcrumbNav({
  currentPath,
  onNavigate,
}: {
  readonly currentPath: string;
  readonly onNavigate: (path: string) => void;
}): React.JSX.Element {
  const crumbs = getBreadcrumbs(currentPath);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const currentCrumbRef = useRef<HTMLButtonElement>(null);

  // Auto-scroll to show the current (last) breadcrumb when path changes
  useEffect(() => {
    if (currentCrumbRef.current && scrollContainerRef.current) {
      currentCrumbRef.current.scrollIntoView({ behavior: 'instant', inline: 'end', block: 'nearest' });
    }
  }, [currentPath]);

  // Enable horizontal scrolling with mouse wheel
  useHorizontalScroll(scrollContainerRef);

  return (
    <div className="flex items-center border-b text-sm">
      <div
        ref={scrollContainerRef}
        className="mx-2 flex flex-1 snap-x snap-mandatory items-center gap-0.5 overflow-x-auto overscroll-x-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {/* "Files" root button - inside scrollable area */}
        <button
          type="button"
          className={cn(
            'my-1.5 shrink-0 snap-start rounded-xs px-1 py-0.5 hover:bg-muted',
            currentPath === '' && 'font-medium text-foreground',
            currentPath !== '' && 'text-muted-foreground',
          )}
          onClick={() => {
            onNavigate('');
          }}
        >
          Files
        </button>
        {/* Path segments */}
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <div key={crumb.path} className="my-1.5 flex shrink-0 snap-start items-center gap-0.5">
              <ChevronRight className="size-3 text-muted-foreground" />
              <button
                ref={isLast ? currentCrumbRef : undefined}
                type="button"
                className={cn(
                  'max-w-32 shrink-0 truncate rounded-xs px-1 py-0.5 hover:bg-muted',
                  isLast && 'font-medium text-foreground',
                  !isLast && 'text-muted-foreground',
                )}
                onClick={() => {
                  onNavigate(crumb.path);
                }}
              >
                {crumb.name}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Render a single file/folder item
 * Both files and folders use CommandItem to ensure unified hover state management
 */
function FileSelectorItem({
  item,
  isSelected,
  directoryHint,
  onDrillDown,
  onSelect,
}: {
  readonly item: TreeNode;
  readonly isSelected: boolean;
  readonly directoryHint?: string;
  readonly onDrillDown: (path: string) => void;
  readonly onSelect: (path: string) => void;
}): React.JSX.Element {
  if (item.isFolder) {
    return (
      <CommandItem
        value={item.path}
        className="flex items-center justify-between gap-2"
        onSelect={() => {
          onDrillDown(item.path);
        }}
      >
        <div className={cn(menuItemLayoutClass, 'min-w-0 flex-1')}>
          <Folder className="shrink-0 text-muted-foreground" />
          <span className="truncate">{item.name}</span>
        </div>
        <ChevronRight className="shrink-0 text-muted-foreground" />
      </CommandItem>
    );
  }

  return (
    <CommandItem
      value={item.path}
      className="flex items-center justify-between gap-2"
      onSelect={() => {
        onSelect(item.path);
      }}
    >
      <div className={cn(menuItemLayoutClass, 'min-w-0 flex-1')}>
        <FileExtensionIcon filename={item.name} className="shrink-0" />
        <span className={cn(directoryHint ? 'shrink-0' : 'truncate', isSelected && 'font-medium')}>{item.name}</span>
        {directoryHint ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{directoryHint}</span>
        ) : undefined}
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
  rootNode,
  currentPath,
  selectedFile,
  searchQuery,
  virtualizationThreshold,
  emptyMessage,
  onDrillDown,
  onSelect,
}: {
  readonly items: TreeNode[];
  readonly rootNode: TreeNode;
  readonly currentPath: string;
  readonly selectedFile: string | undefined;
  readonly searchQuery: string;
  readonly virtualizationThreshold: number;
  readonly emptyMessage: string;
  readonly onDrillDown: (path: string) => void;
  readonly onSelect: (path: string) => void;
}): React.JSX.Element {
  const isSearching = searchQuery.length > 0;

  // When searching, recursively find matching files from the root of the tree; otherwise show current level items
  const filteredItems = useMemo(() => {
    if (!searchQuery) {
      return items;
    }

    return searchFilesRecursively(rootNode, searchQuery);
  }, [items, searchQuery, rootNode]);

  const renderItem = useCallback(
    (index: number) => {
      const item = filteredItems[index];
      if (!item) {
        return undefined;
      }

      const hint = isSearching ? getDirectoryHint(item.path, currentPath) : undefined;

      return (
        <FileSelectorItem
          key={item.path}
          item={item}
          isSelected={selectedFile === item.path}
          directoryHint={hint ?? undefined}
          onDrillDown={onDrillDown}
          onSelect={onSelect}
        />
      );
    },
    [filteredItems, selectedFile, isSearching, currentPath, onDrillDown, onSelect],
  );

  // Show empty message when no items match
  if (filteredItems.length === 0) {
    return <div className="p-1 py-6 text-center text-sm text-muted-foreground">{emptyMessage}</div>;
  }

  if (filteredItems.length > virtualizationThreshold) {
    return (
      <Virtuoso
        style={{ height: '300px' }}
        totalCount={filteredItems.length}
        itemContent={renderItem}
        // Virtuoso's List component doesn't handle vertical padding correctly due to
        // absolute positioning used for virtualization. Use Header/Footer for vertical
        // spacing and px-1 on List for horizontal padding.
        components={{
          List: (properties) => <div {...properties} className="px-1" />,
          Header: () => <div className="h-1" />,
          Footer: () => <div className="h-1" />,
        }}
      />
    );
  }

  return (
    <div className="p-1">
      {filteredItems.map((item) => {
        const hint = isSearching ? getDirectoryHint(item.path, currentPath) : undefined;
        return (
          <FileSelectorItem
            key={item.path}
            item={item}
            isSelected={selectedFile === item.path}
            directoryHint={hint ?? undefined}
            onDrillDown={onDrillDown}
            onSelect={onSelect}
          />
        );
      })}
    </div>
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
  popoverProperties,
  initialPath,
}: FileSelectorProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const isMobile = useIsMobile();

  // Build tree from files
  const tree = useMemo(() => buildTree(files), [files]);

  // Get items at current path
  const currentItems = useMemo(() => getItemsAtPath(tree, currentPath), [tree, currentPath]);

  // Open at the same level as the selected file (or initialPath if provided)
  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      setOpen(isOpen);
      if (isOpen) {
        // Use initialPath if provided, otherwise navigate to parent of selectedFile
        if (initialPath !== undefined) {
          setCurrentPath(initialPath);
        } else if (selectedFile) {
          const parts = selectedFile.split('/');
          // Remove the filename to get the directory path
          parts.pop();
          setCurrentPath(parts.join('/'));
        } else {
          setCurrentPath('');
        }

        setSearchQuery('');
      }
    },
    [initialPath, selectedFile],
  );

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
          <Loader className="size-4" />
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
      <CommandList className="max-h-[300px]">
        <FileSelectorList
          items={currentItems}
          rootNode={tree}
          currentPath={currentPath}
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
      <PopoverContent {...popoverProperties} className={cn('w-[300px] p-0', popoverProperties?.className)}>
        {content}
      </PopoverContent>
    </Popover>
  );
}
