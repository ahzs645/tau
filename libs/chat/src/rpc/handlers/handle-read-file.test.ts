import { describe, it, expect } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { RpcFileSystem } from '#rpc/rpc-dependencies.js';
import { handleReadFile } from '#rpc/handlers/handle-read-file.js';

describe('handleReadFile', () => {
  it('should return file content with line info', async () => {
    const fileSystem = mock<RpcFileSystem>();
    fileSystem.readFile.mockResolvedValue('line1\nline2\nline3');
    fileSystem.stat.mockResolvedValue({
      size: 18,
      isDirectory: false,
      createdAt: '2026-01-15T10:00:00.000Z',
      modifiedAt: '2026-01-20T14:30:00.000Z',
    });

    const result = await handleReadFile({ targetFile: 'test.txt' }, fileSystem);

    expect(result).toEqual({
      success: true,
      content: 'line1\nline2\nline3',
      totalLines: 3,
      startLine: 1,
      createdAt: '2026-01-15T10:00:00.000Z',
      modifiedAt: '2026-01-20T14:30:00.000Z',
    });
  });

  it('should include timestamps from stat', async () => {
    const fileSystem = mock<RpcFileSystem>();
    fileSystem.readFile.mockResolvedValue('data');
    fileSystem.stat.mockResolvedValue({
      size: 4,
      isDirectory: false,
      createdAt: '2026-03-01T00:00:00.000Z',
      modifiedAt: '2026-03-24T12:00:00.000Z',
    });

    const result = await handleReadFile({ targetFile: 'test.txt' }, fileSystem);

    expect(result).toMatchObject({
      success: true,
      createdAt: '2026-03-01T00:00:00.000Z',
      modifiedAt: '2026-03-24T12:00:00.000Z',
    });
  });

  it('should gracefully handle stat failure', async () => {
    const fileSystem = mock<RpcFileSystem>();
    fileSystem.readFile.mockResolvedValue('content');
    fileSystem.stat.mockRejectedValue(new Error('stat not supported'));

    const result = await handleReadFile({ targetFile: 'test.txt' }, fileSystem);

    expect(result).toMatchObject({
      success: true,
      content: 'content',
      createdAt: undefined,
      modifiedAt: undefined,
    });
  });

  it('should apply offset and limit', async () => {
    const fileSystem = mock<RpcFileSystem>();
    fileSystem.readFile.mockResolvedValue('a\nb\nc\nd\ne');
    fileSystem.stat.mockRejectedValue(new Error('unavailable'));

    const result = await handleReadFile({ targetFile: 'test.txt', offset: 2, limit: 2 }, fileSystem);

    expect(result).toMatchObject({
      success: true,
      content: 'b\nc',
      totalLines: 5,
      startLine: 2,
    });
  });

  it('should return FILE_NOT_FOUND when file does not exist', async () => {
    const fileSystem = mock<RpcFileSystem>();
    const error = new Error('ENOENT: no such file');
    (error as NodeJS.ErrnoException).code = 'ENOENT';
    fileSystem.readFile.mockRejectedValue(error);

    const result = await handleReadFile({ targetFile: 'missing.txt' }, fileSystem);

    expect(result).toMatchObject({ success: false, errorCode: 'FILE_NOT_FOUND' });
  });
});
