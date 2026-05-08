import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBundledTypesTree } from '#hooks/use-bundled-types-tree.js';
import type { FileSystemClient } from '@taucad/fs-client/file-system-client';
import { bundledTypesWorkspaceRootSegment } from '#lib/bundled-types-tree.constants.js';

describe('useBundledTypesTree', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call readdir until ensureRootListed runs', () => {
    const readdir = vi.fn<FileSystemClient['readdir']>().mockResolvedValue(['replicad']);
    const proxy = { readdir } as Pick<FileSystemClient, 'readdir'>;
    const { result } = renderHook(() => useBundledTypesTree(proxy as FileSystemClient));

    expect(readdir).not.toHaveBeenCalled();
    expect(result.current.bundledPaths.has(bundledTypesWorkspaceRootSegment)).toBe(true);
    expect([...result.current.bundledPaths]).toEqual([bundledTypesWorkspaceRootSegment]);
  });

  it('fans out exactly one root readdir then one per expanded package', async () => {
    const readdir = vi.fn<FileSystemClient['readdir']>().mockImplementation(async (path: string) => {
      if (path === `/${bundledTypesWorkspaceRootSegment}`) {
        return ['replicad'];
      }

      if (path === `/${bundledTypesWorkspaceRootSegment}/replicad`) {
        return ['index.d.ts', 'package.json'];
      }

      throw new Error(`unexpected readdir: ${path}`);
    });
    const proxy = { readdir } as Pick<FileSystemClient, 'readdir'>;
    const { result } = renderHook(() => useBundledTypesTree(proxy as FileSystemClient));

    await act(async () => {
      await result.current.ensureRootListed();
    });

    expect(readdir).toHaveBeenCalledTimes(1);
    expect(readdir).toHaveBeenCalledWith(`/${bundledTypesWorkspaceRootSegment}`);

    await act(async () => {
      await result.current.ensurePkgListed('replicad');
    });

    expect(readdir).toHaveBeenCalledTimes(2);
    expect(readdir).toHaveBeenLastCalledWith(`/${bundledTypesWorkspaceRootSegment}/replicad`);

    expect(result.current.bundledPaths.has(`${bundledTypesWorkspaceRootSegment}/replicad/index.d.ts`)).toBe(true);
  });

  it('is idempotent when ensureRootListed / ensurePkgListed repeat', async () => {
    const readdir = vi
      .fn<FileSystemClient['readdir']>()
      .mockResolvedValueOnce(['a'])
      .mockResolvedValueOnce(['index.d.ts']);
    const proxy = { readdir } as Pick<FileSystemClient, 'readdir'>;
    const { result } = renderHook(() => useBundledTypesTree(proxy as FileSystemClient));

    await act(async () => {
      await result.current.ensureRootListed();
      await result.current.ensureRootListed();
    });

    await act(async () => {
      await result.current.ensurePkgListed('a');
      await result.current.ensurePkgListed('a');
    });

    expect(readdir).toHaveBeenCalledTimes(2);
  });
});
