import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { FileTreeService } from '#file-tree-service.js';
import type { FileSystemClient } from '#file-system-client.js';
import { WorkerChangeChannel } from '#worker-change-channel.js';
import { WorkspacePathEscapeError, WorkspacePathResolver } from '#workspace-path-resolver.js';
import { headlessVisibilityProvider } from '#visibility-provider.js';

const workspaceRoot = '/projects/abc';

function createTreeHarness(overrides?: { proxy?: FileSystemClient; workspaceRoot?: string }): {
  tree: FileTreeService;
  proxy: FileSystemClient;
  disposeChannel: () => void;
} {
  const listen = vi.fn().mockReturnValue(vi.fn());
  const root = overrides?.workspaceRoot ?? workspaceRoot;
  const paths = new WorkspacePathResolver(root);
  const channel = new WorkerChangeChannel({ transport: { listen }, paths });
  const proxy =
    overrides?.proxy ??
    mock<FileSystemClient>({
      readDirectory: vi.fn().mockResolvedValue([]),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({ type: 'file', size: 0, mtimeMs: 0 }),
      getDirectoryStat: vi.fn().mockResolvedValue([]),
    });
  const tree = new FileTreeService({
    proxy,
    paths,
    channel,
    visibility: headlessVisibilityProvider,
  });
  return {
    tree,
    proxy,
    disposeChannel: () => {
      channel.dispose();
    },
  };
}

describe('FileTreeService workspace path canonicalization', () => {
  let harness: ReturnType<typeof createTreeHarness>;

  beforeEach(() => {
    harness = createTreeHarness();
  });

  afterEach(() => {
    harness.disposeChannel();
  });

  describe('readDirectoryEntriesWithStats', () => {
    it('should call readDirectory with the workspace root for every root alias', async () => {
      const aliases = ['', '.', '/', './', '/projects/abc', '/projects/abc/'];
      await Promise.all(
        aliases.map(async (alias) => {
          vi.mocked(harness.proxy.readDirectory).mockClear();
          await harness.tree.readDirectoryEntriesWithStats(alias);
          expect(harness.proxy.readDirectory).toHaveBeenCalledWith('/projects/abc');
        }),
      );
    });

    it('should resolve ./src and /src to the same absolute path under root', async () => {
      await harness.tree.readDirectoryEntriesWithStats('./src');
      expect(harness.proxy.readDirectory).toHaveBeenLastCalledWith('/projects/abc/src');
      vi.mocked(harness.proxy.readDirectory).mockClear();
      await harness.tree.readDirectoryEntriesWithStats('/src');
      expect(harness.proxy.readDirectory).toHaveBeenLastCalledWith('/projects/abc/src');
    });

    it('should throw before calling the proxy when the path escapes the workspace', async () => {
      vi.mocked(harness.proxy.readDirectory).mockClear();
      await expect(harness.tree.readDirectoryEntriesWithStats('/projects/other/deep')).rejects.toThrow(
        WorkspacePathEscapeError,
      );
      expect(harness.proxy.readDirectory).not.toHaveBeenCalled();
    });
  });

  describe('readDirectoryEntries', () => {
    it('should call readDirectory with the workspace root for root aliases', async () => {
      await harness.tree.readDirectoryEntries('.');
      expect(harness.proxy.readDirectory).toHaveBeenCalledWith('/projects/abc');
    });

    it('should resolve /src under the workspace root', async () => {
      await harness.tree.readDirectoryEntries('/src');
      expect(harness.proxy.readDirectory).toHaveBeenCalledWith('/projects/abc/src');
    });
  });

  describe('stat', () => {
    it('should call stat with the resolved absolute path for /src', async () => {
      await harness.tree.stat('/src');
      expect(harness.proxy.stat).toHaveBeenCalledWith('/projects/abc/src');
    });
  });

  describe('getDirectoryStat', () => {
    it('should call getDirectoryStat with the workspace root for "."', async () => {
      await harness.tree.getDirectoryStat('.');
      expect(harness.proxy.getDirectoryStat).toHaveBeenCalledWith('/projects/abc');
    });
  });

  describe('exists', () => {
    it('should stat the workspace root when checking "."', async () => {
      await harness.tree.exists('.');
      expect(harness.proxy.stat).toHaveBeenCalledWith('/projects/abc');
    });
  });
});
