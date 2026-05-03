import { describe, it, expect } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { RpcFileSystem } from '#rpc/rpc-dependencies.js';
import { rpcClientErrorCode } from '#schemas/rpc.schema.js';
import { handleGrep } from '#rpc/handlers/handle-grep.js';

describe('handleGrep', () => {
  it('should return matches when pattern matches file contents', async () => {
    const fileSystem = mock<RpcFileSystem>();
    fileSystem.readdir.mockResolvedValue([{ name: 'app.ts', type: 'file', size: 20 }]);
    fileSystem.readFile.mockResolvedValue("const x = 'hello world'\n");

    const result = await handleGrep({ pattern: 'hello', path: '' }, fileSystem);

    expect(result).toMatchObject({
      success: true,
      totalMatches: 1,
      truncated: false,
    });
    expect(result.success && result.matches).toEqual([expect.objectContaining({ file: 'app.ts', line: 1 })]);
    expect(result.success && result.matches[0]?.content).toContain('hello');
  });

  it('should return FILE_NOT_FOUND when readdir fails with ENOENT', async () => {
    const fileSystem = mock<RpcFileSystem>();
    const error = new Error('ENOENT: no such file');
    (error as NodeJS.ErrnoException).code = 'ENOENT';
    fileSystem.readdir.mockRejectedValue(error);

    const result = await handleGrep({ pattern: 'foo', path: 'missing-dir' }, fileSystem);

    expect(result).toMatchObject({ success: false, errorCode: rpcClientErrorCode.fileNotFound });
  });
});
