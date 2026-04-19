import type { UIMessage } from 'ai';
import type { ChatSnapshot } from '@taucad/chat';
import type { FileTreeEntry } from '@taucad/types';

type TreeNode = {
  name: string;
  type: 'file' | 'dir';
  size: number;
  children: Map<string, TreeNode>;
};

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
 * Build a hierarchical tree structure from flat file entries.
 */
function buildTree(entries: FileTreeEntry[]): TreeNode {
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
    // oxlint-disable-next-line unicorn-js/prevent-abbreviations -- short name used in sort comparator
    const aIsDir = a[1].type === 'dir';
    // oxlint-disable-next-line unicorn-js/prevent-abbreviations -- short name used in sort comparator
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
 * Generate a token-efficient filesystem snapshot from file entries.
 *
 * @param entries - Array of file entries from the file tree
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
function generateFileSystemSnapshot(entries: FileTreeEntry[], rootPath = '/project/'): string {
  if (entries.length === 0) {
    return `${rootPath}\n  (empty)`;
  }

  const tree = buildTree(entries);
  const treeContent = renderTree(tree);

  return `${rootPath}\n${treeContent}`;
}

/**
 * Injects editor context snapshot into the last user message's text content.
 * This prepends context blocks to help the AI understand:
 * - The current project's file structure
 * - Which file is currently active (being rendered by CAD)
 * - Which files are open in editor tabs
 *
 * @param messages - The array of UI messages to process
 * @param snapshot - The editor context snapshot to inject
 * @returns A new array of messages with the context injected
 */
export function injectSnapshotContext<T extends UIMessage>(messages: T[], snapshot: ChatSnapshot): T[] {
  // Find the last user message and prepend the context
  const lastUserMessageIndex = messages.findLastIndex((message) => message.role === 'user');

  if (lastUserMessageIndex === -1) {
    return messages;
  }

  const lastUserMessage = messages[lastUserMessageIndex];

  if (!lastUserMessage) {
    return messages;
  }

  // Build context string from snapshot components
  const contextParts: string[] = [];

  // Add active file context
  if (snapshot.activeFile) {
    contextParts.push(`<active_file>
The file currently being rendered by the CAD engine: ${snapshot.activeFile.path}
</active_file>`);
  }

  // Add open files context
  if (snapshot.openFiles && snapshot.openFiles.length > 0) {
    const fileList = snapshot.openFiles.map((file) => file.path).join(', ');
    contextParts.push(`<open_files>
Files currently open in the editor tabs: ${fileList}
</open_files>`);
  }

  // Add filesystem context - generate tree from file entries
  if (snapshot.fileTree && snapshot.fileTree.length > 0) {
    const filesystemSnapshot = generateFileSystemSnapshot(snapshot.fileTree);
    contextParts.push(`<project_layout>
Below is a snapshot of the current project's file structure:

${filesystemSnapshot}
</project_layout>`);
  }

  // If no context to add, return original messages
  if (contextParts.length === 0) {
    return messages;
  }

  const editorContext = `<system-reminder>
${contextParts.join('\n\n')}
</system-reminder>

`;

  // Prepend a new text part with the editor context at the beginning
  const contextPart = { type: 'text', text: editorContext };
  const updatedParts = [contextPart, ...lastUserMessage.parts];

  return [
    ...messages.slice(0, lastUserMessageIndex),
    { ...lastUserMessage, parts: updatedParts },
    ...messages.slice(lastUserMessageIndex + 1),
  ] as T[];
}
