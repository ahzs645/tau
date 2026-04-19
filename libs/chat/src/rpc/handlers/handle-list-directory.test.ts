import { describe, it, expect } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { RpcFileSystem } from '#rpc/rpc-dependencies.js';
import { handleListDirectory } from '#rpc/handlers/handle-list-directory.js';

describe('handleListDirectory', () => {
  it('should return directory entries with modifiedAt when available', async () => {
    const fileSystem = mock<RpcFileSystem>();
    fileSystem.readdir.mockResolvedValue([
      { name: 'index.ts', type: 'file', size: 200, modifiedAt: '2026-01-10T08:00:00.000Z' },
      { name: 'utils', type: 'directory', size: 0, modifiedAt: '2026-02-01T12:00:00.000Z' },
    ]);

    const result = await handleListDirectory({ path: 'src' }, fileSystem);

    expect(result).toEqual({
      success: true,
      path: 'src',
      entries: [
        { name: 'index.ts', type: 'file', size: 200, modifiedAt: '2026-01-10T08:00:00.000Z' },
        { name: 'utils', type: 'dir', size: 0, modifiedAt: '2026-02-01T12:00:00.000Z' },
      ],
    });
  });

  it('should omit modifiedAt when not provided', async () => {
    const fileSystem = mock<RpcFileSystem>();
    fileSystem.readdir.mockResolvedValue([{ name: 'readme.md', type: 'file', size: 500 }]);

    const result = await handleListDirectory({ path: '' }, fileSystem);

    expect(result).toEqual({
      success: true,
      path: '/',
      entries: [{ name: 'readme.md', type: 'file', size: 500 }],
    });
  });

  it('should return error on readdir failure', async () => {
    const fileSystem = mock<RpcFileSystem>();
    fileSystem.readdir.mockRejectedValue(new Error('disk full'));

    const result = await handleListDirectory({ path: 'restricted' }, fileSystem);

    expect(result).toMatchObject({ success: false, errorCode: 'IO_ERROR' });
  });
});
