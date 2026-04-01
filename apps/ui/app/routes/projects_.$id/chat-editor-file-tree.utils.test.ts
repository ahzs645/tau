import { describe, it, expect } from 'vitest';
import type { FileItem } from '#types/editor.types.js';
import {
  getItemData,
  isPathFolder,
  sortChildrenFoldersFirst,
} from '#routes/projects_.$id/chat-editor-file-tree.utils.js';

// ===================================================================
// Factories
// ===================================================================

function createFileItem(path: string, options?: { isDirectory?: boolean }): FileItem {
  const name = path.split('/').pop() ?? path;
  return {
    id: path,
    name,
    path,
    content: new Uint8Array(),
    isDirectory: options?.isDirectory ?? false,
  };
}

const rootId = '';

// ===================================================================
// getItemData
// ===================================================================

describe('getItemData', () => {
  it('should return isFolder true for the root item', () => {
    const result = getItemData([], rootId, rootId);

    expect(result).toEqual(
      expect.objectContaining({
        path: rootId,
        name: 'Root',
        isFolder: true,
      }),
    );
  });

  it('should return isFolder true for explicit directory entries in fileTree', () => {
    const fileTree = [createFileItem('src', { isDirectory: true }), createFileItem('main.ts')];

    const result = getItemData(fileTree, rootId, 'src');

    expect(result.isFolder).toBe(true);
    expect(result.name).toBe('src');
  });

  it('should return isFolder false for explicit file entries in fileTree', () => {
    const fileTree = [createFileItem('src', { isDirectory: true }), createFileItem('main.ts')];

    const result = getItemData(fileTree, rootId, 'main.ts');

    expect(result.isFolder).toBe(false);
    expect(result.name).toBe('main.ts');
  });

  it('should return isFolder true for virtual folder paths not in fileTree', () => {
    const fileTree = [createFileItem('src/utils/math.ts')];

    const result = getItemData(fileTree, rootId, 'src');

    expect(result.isFolder).toBe(true);
    expect(result.name).toBe('src');
  });

  it('should preserve gitStatus from the fileTree entry', () => {
    const modified: FileItem['gitStatus'] = 'modified';
    const fileTree = [{ ...createFileItem('index.ts'), gitStatus: modified }];

    const result = getItemData(fileTree, rootId, 'index.ts');

    expect(result.gitStatus).toBe('modified');
  });
});

// ===================================================================
// isPathFolder
// ===================================================================

describe('isPathFolder', () => {
  it('should return true for explicit directory entries', () => {
    const fileTree = [createFileItem('lib', { isDirectory: true })];
    const allPaths = new Set(['lib']);

    expect(isPathFolder('lib', fileTree, allPaths)).toBe(true);
  });

  it('should return false for explicit file entries', () => {
    const fileTree = [createFileItem('readme.md')];
    const allPaths = new Set(['readme.md']);

    expect(isPathFolder('readme.md', fileTree, allPaths)).toBe(false);
  });

  it('should return true for virtual folders inferred from nested paths', () => {
    const fileTree: FileItem[] = [];
    const allPaths = new Set(['src', 'src/index.ts']);

    expect(isPathFolder('src', fileTree, allPaths)).toBe(true);
  });

  it('should return false for unknown paths not in fileTree or allPaths', () => {
    const fileTree: FileItem[] = [];
    const allPaths = new Set<string>();

    expect(isPathFolder('nonexistent', fileTree, allPaths)).toBe(false);
  });
});

// ===================================================================
// sortChildrenFoldersFirst
// ===================================================================

describe('sortChildrenFoldersFirst', () => {
  it('should sort directories before files', () => {
    const fileTree = [
      createFileItem('readme.md'),
      createFileItem('src', { isDirectory: true }),
      createFileItem('package.json'),
    ];
    const allPaths = new Set(['readme.md', 'src', 'package.json']);

    const sorted = sortChildrenFoldersFirst(['readme.md', 'src', 'package.json'], fileTree, allPaths);

    expect(sorted[0]).toBe('src');
    expect(sorted.indexOf('src')).toBeLessThan(sorted.indexOf('readme.md'));
    expect(sorted.indexOf('src')).toBeLessThan(sorted.indexOf('package.json'));
  });

  it('should sort directories before files when directories are explicit entries', () => {
    const fileTree = [
      createFileItem('.tau', { isDirectory: true }),
      createFileItem('public', { isDirectory: true }),
      createFileItem('src', { isDirectory: true }),
      createFileItem('main.ts'),
      createFileItem('README.md'),
    ];
    const allPaths = new Set(['.tau', 'public', 'src', 'main.ts', 'README.md']);

    const sorted = sortChildrenFoldersFirst(['main.ts', '.tau', 'README.md', 'public', 'src'], fileTree, allPaths);

    const firstFile = sorted.findIndex((p) => !isPathFolder(p, fileTree, allPaths));
    const lastFolder = sorted.findLastIndex((p) => isPathFolder(p, fileTree, allPaths));
    expect(lastFolder).toBeLessThan(firstFile);
  });

  it('should sort alphabetically within the same category', () => {
    const fileTree = [
      createFileItem('beta', { isDirectory: true }),
      createFileItem('alpha', { isDirectory: true }),
      createFileItem('zebra.ts'),
      createFileItem('apple.ts'),
    ];
    const allPaths = new Set(['alpha', 'beta', 'apple.ts', 'zebra.ts']);

    const sorted = sortChildrenFoldersFirst(['zebra.ts', 'beta', 'apple.ts', 'alpha'], fileTree, allPaths);

    expect(sorted).toEqual(['alpha', 'beta', 'apple.ts', 'zebra.ts']);
  });

  it('should handle mixed explicit and virtual folders', () => {
    const fileTree = [
      createFileItem('src', { isDirectory: true }),
      createFileItem('lib/utils/helper.ts'),
      createFileItem('index.ts'),
    ];
    const allPaths = new Set(['src', 'lib', 'lib/utils', 'lib/utils/helper.ts', 'index.ts']);

    const sorted = sortChildrenFoldersFirst(['index.ts', 'lib', 'src'], fileTree, allPaths);

    expect(sorted[0]).toBe('lib');
    expect(sorted[1]).toBe('src');
    expect(sorted[2]).toBe('index.ts');
  });
});
