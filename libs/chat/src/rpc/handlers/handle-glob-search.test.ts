import { describe, it, expect } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { RpcFileSystem } from '#rpc/rpc-dependencies.js';
import { handleGlobSearch } from '#rpc/handlers/handle-glob-search.js';

describe('handleGlobSearch', () => {
  it('should return matching files with metadata entries', async () => {
    const fileSystem = mock<RpcFileSystem>();
    fileSystem.readdir.mockResolvedValue([
      { name: 'index.ts', type: 'file', size: 100, modifiedAt: '2026-01-15T10:00:00.000Z' },
      { name: 'utils.ts', type: 'file', size: 200, modifiedAt: '2026-02-20T14:00:00.000Z' },
      { name: 'readme.md', type: 'file', size: 50 },
    ]);

    const result = await handleGlobSearch({ pattern: '*.ts' }, fileSystem);

    expect(result).toMatchObject({
      success: true,
      totalFiles: 2,
      files: ['index.ts', 'utils.ts'],
    });
    expect(result.success && result.entries).toEqual([
      { path: 'index.ts', isDirectory: false, size: 100, modifiedAt: '2026-01-15T10:00:00.000Z' },
      { path: 'utils.ts', isDirectory: false, size: 200, modifiedAt: '2026-02-20T14:00:00.000Z' },
    ]);
  });

  it('should return empty results for no matches', async () => {
    const fileSystem = mock<RpcFileSystem>();
    fileSystem.readdir.mockResolvedValue([{ name: 'readme.md', type: 'file', size: 50 }]);

    const result = await handleGlobSearch({ pattern: '*.py' }, fileSystem);

    expect(result).toMatchObject({
      success: true,
      files: [],
      entries: [],
      totalFiles: 0,
    });
  });

  it('should recursively search subdirectories', async () => {
    const fileSystem = mock<RpcFileSystem>();
    fileSystem.readdir
      .mockResolvedValueOnce([
        { name: 'src', type: 'directory', size: 0 },
        { name: 'package.json', type: 'file', size: 300 },
      ])
      .mockResolvedValueOnce([{ name: 'app.ts', type: 'file', size: 150, modifiedAt: '2026-03-01T00:00:00.000Z' }]);

    const result = await handleGlobSearch({ pattern: '**/*.ts' }, fileSystem);

    expect(result).toMatchObject({
      success: true,
      files: ['src/app.ts'],
      totalFiles: 1,
    });
  });

  it('should return IO_ERROR on readdir failure', async () => {
    const fileSystem = mock<RpcFileSystem>();
    fileSystem.readdir.mockRejectedValue(new Error('disk error'));

    const result = await handleGlobSearch({ pattern: '*.ts' }, fileSystem);

    expect(result).toMatchObject({ success: false, errorCode: 'IO_ERROR' });
  });
});
