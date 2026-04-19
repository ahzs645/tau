import { describe, it, expect } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { RpcFileSystem } from '#rpc/rpc-dependencies.js';
import { handleEditFile } from '#rpc/handlers/handle-edit-file.js';

describe('handleEditFile', () => {
  it('should replace a single occurrence and return count', async () => {
    const fileSystem = mock<RpcFileSystem>();
    fileSystem.editFile.mockResolvedValue({ occurrences: 1 });

    const result = await handleEditFile({ targetFile: 'main.ts', oldString: 'foo', newString: 'bar' }, fileSystem);

    expect(result).toEqual({
      success: true,
      message: 'Replaced 1 occurrence in main.ts',
      occurrences: 1,
    });
    expect(fileSystem.editFile).toHaveBeenCalledWith('main.ts', 'foo', 'bar', undefined);
  });

  it('should pass replaceAll flag to filesystem', async () => {
    const fileSystem = mock<RpcFileSystem>();
    fileSystem.editFile.mockResolvedValue({ occurrences: 3 });

    const result = await handleEditFile(
      { targetFile: 'main.ts', oldString: 'x', newString: 'y', replaceAll: true },
      fileSystem,
    );

    expect(result).toEqual({
      success: true,
      message: 'Replaced 3 occurrences in main.ts',
      occurrences: 3,
    });
    expect(fileSystem.editFile).toHaveBeenCalledWith('main.ts', 'x', 'y', true);
  });

  it('should return FILE_NOT_FOUND when file does not exist', async () => {
    const fileSystem = mock<RpcFileSystem>();
    const error = new Error('ENOENT: no such file');
    (error as NodeJS.ErrnoException).code = 'ENOENT';
    fileSystem.editFile.mockRejectedValue(error);

    const result = await handleEditFile({ targetFile: 'missing.ts', oldString: 'a', newString: 'b' }, fileSystem);

    expect(result).toMatchObject({ success: false, errorCode: 'FILE_NOT_FOUND' });
  });

  it('should return IO_ERROR for generic filesystem errors', async () => {
    const fileSystem = mock<RpcFileSystem>();
    fileSystem.editFile.mockRejectedValue(new Error('disk full'));

    const result = await handleEditFile({ targetFile: 'main.ts', oldString: 'a', newString: 'b' }, fileSystem);

    expect(result).toMatchObject({ success: false, errorCode: 'IO_ERROR' });
  });
});
