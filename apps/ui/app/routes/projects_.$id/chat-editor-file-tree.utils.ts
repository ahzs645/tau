import type { FileItem } from '#types/editor.types.js';
import { bundledTypesWorkspaceRootSegment } from '#lib/bundled-types-tree.constants.js';

/**
 * Tree item data returned by the headless-tree data loader.
 * @public
 */
export type TreeItemData = {
  path: string;
  name: string;
  isFolder: boolean;
  content?: Uint8Array<ArrayBuffer>;
};

/**
 * Resolve a tree item by ID. Checks the `fileTree` array first (returning
 * `isFolder` from the entry's `isDirectory` flag), then falls back to a
 * virtual folder for paths not found in `fileTree` (e.g., inferred parent
 * directories from nested file paths).
 *
 * When `bundledPaths` is provided and includes `itemId`, the row is treated as
 * part of the synthetic bundled-types subtree (FM global `/node_modules`).
 *
 * @param fileTree - Flat list of explicit file/directory entries.
 * @param rootId - The sentinel root ID.
 * @param itemId - The item to resolve.
 * @returns Tree item data with correct `isFolder` flag.
 * @public
 */
export const getItemData = (
  fileTree: FileItem[],
  rootId: string,
  itemId: string,
  bundledPaths?: ReadonlySet<string>,
): TreeItemData => {
  if (itemId === rootId) {
    return { path: rootId, name: 'Root', isFolder: true };
  }

  if (bundledPaths?.has(itemId) === true) {
    const hasChildInBundled = [...bundledPaths].some((path) => path !== itemId && path.startsWith(`${itemId}/`));
    const isFolder = itemId === bundledTypesWorkspaceRootSegment || hasChildInBundled;
    const name = itemId.split('/').pop() ?? itemId;
    return { path: itemId, name, isFolder };
  }

  const file = fileTree.find((f) => f.path === itemId);
  if (file) {
    return {
      path: file.path,
      name: file.name,
      isFolder: file.isDirectory ?? false,
      content: file.content,
    };
  }

  const name = itemId.split('/').pop() ?? itemId;
  return { path: itemId, name, isFolder: true };
};

/**
 * Determine whether a path represents a folder. Checks the explicit entry
 * first (via `isDirectory`), then bundled synthetic paths, then the `allPaths`
 * set for virtual folders inferred from nested file paths.
 *
 * @public
 */
export const isPathFolder = (
  path: string,
  fileTree: FileItem[],
  allPaths: Set<string>,
  bundledPaths?: ReadonlySet<string>,
): boolean => {
  const entry = fileTree.find((f) => f.path === path);
  if (entry) {
    return entry.isDirectory ?? false;
  }

  if (bundledPaths?.has(path)) {
    const hasChildInBundled = [...bundledPaths].some((child) => child !== path && child.startsWith(`${path}/`));
    return path === bundledTypesWorkspaceRootSegment || hasChildInBundled;
  }

  return allPaths.has(path);
};

/**
 * Sort comparator that orders folders before files, then alphabetically
 * (case-insensitive).
 *
 * @public
 */
export const sortChildrenFoldersFirst = (
  children: string[],
  fileTree: FileItem[],
  allPaths: Set<string>,
  bundledPaths?: ReadonlySet<string>,
): string[] =>
  [...children].sort((a, b) => {
    const aName = a.split('/').pop() ?? a;
    const bName = b.split('/').pop() ?? b;
    const aIsFolder = isPathFolder(a, fileTree, allPaths, bundledPaths);
    const bIsFolder = isPathFolder(b, fileTree, allPaths, bundledPaths);

    if (aIsFolder && !bIsFolder) {
      return -1;
    }

    if (!aIsFolder && bIsFolder) {
      return 1;
    }

    return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
  });
