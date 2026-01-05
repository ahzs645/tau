/**
 * Utility functions for generating token-efficient filesystem snapshots for LLM consumption.
 */

type FileEntry = {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size: number;
};

type TreeNode = {
  name: string;
  type: 'file' | 'dir';
  size: number;
  children: Map<string, TreeNode>;
};

/**
 * Build a hierarchical tree structure from flat file entries.
 */
function buildTree(entries: FileEntry[]): TreeNode {
  const root: TreeNode = {
    name: '',
    type: 'dir',
    size: 0,
    children: new Map(),
  };

  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean);
    let current = root;

    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!part) {
        continue;
      }

      const isLast = index === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          type: isLast ? entry.type : 'dir',
          size: isLast ? entry.size : 0,
          children: new Map(),
        });
      }

      const child = current.children.get(part);
      if (child) {
        current = child;
      }
    }
  }

  return root;
}

/**
 * Render a tree node to a string representation.
 */
function renderTree(node: TreeNode, indent = ''): string {
  const lines: string[] = [];

  // Sort children: directories first, then files, alphabetically within each group
  const sortedChildren = [...node.children.entries()].sort((a, b) => {
    const aIsDir = a[1].type === 'dir';
    const bIsDir = b[1].type === 'dir';
    if (aIsDir !== bIsDir) {
      return aIsDir ? -1 : 1;
    }

    return a[0].localeCompare(b[0]);
  });

  for (const [, child] of sortedChildren) {
    if (child.type === 'dir') {
      lines.push(`${indent}- ${child.name}/`, renderTree(child, indent + '  '));
    } else {
      // Include file size for context
      const sizeInfo = child.size > 0 ? ` (${formatSize(child.size)})` : '';
      lines.push(`${indent}- ${child.name}${sizeInfo}`);
    }
  }

  return lines.filter(Boolean).join('\n');
}

/**
 * Format file size in a human-readable way.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)}KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Generate a token-efficient filesystem snapshot from file entries.
 *
 * @param entries - Array of file entries from the file manager
 * @param rootPath - Optional root path to display (defaults to "/project/")
 * @returns A string representation of the filesystem tree
 *
 * @example
 * ```
 * /project/
 *   - lib/
 *     - shapes.scad (2KB)
 *     - utils.scad (1KB)
 *   - main.scad (5KB)
 * ```
 */
export function generateFilesystemSnapshot(entries: FileEntry[], rootPath = '/project/'): string {
  if (entries.length === 0) {
    return `${rootPath}\n  (empty)`;
  }

  const tree = buildTree(entries);
  const treeContent = renderTree(tree);

  return `${rootPath}\n${treeContent}`;
}

/**
 * Generate a filesystem snapshot from a Map of file entries (as used in file manager).
 */
export function generateFilesystemSnapshotFromMap(fileTreeMap: Map<string, FileEntry>, rootPath = '/project/'): string {
  const entries = [...fileTreeMap.values()];
  return generateFilesystemSnapshot(entries, rootPath);
}
