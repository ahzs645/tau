import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { Project } from '@taucad/types';

// ── Mock fns ──────────────────────────────────────────────────────────────────

const mockWriteFiles = vi.fn<(files: Record<string, { content: Uint8Array<ArrayBuffer> }>) => Promise<void>>();
const mockReconfigureBackend = vi.fn<(backend: string) => Promise<void>>();
let mockBackendType = 'indexeddb';

vi.mock('#hooks/use-file-manager.js', () => ({
  useFileManager: () => ({
    backendType: mockBackendType,
    writeFiles: mockWriteFiles,
    reconfigureBackend: mockReconfigureBackend,
    copyDirectory: vi.fn(),
    fileManagerRef: { getSnapshot: () => ({ matches: () => true }) },
  }),
}));

const mockSetBuildFileSystemConfig = vi.fn<(projectId: string, backend: string) => Promise<void>>();
const mockGetStoredDirectoryHandle = vi.fn<() => Promise<undefined>>();
const mockCheckHandlePermission = vi.fn<() => Promise<string>>();

vi.mock('#filesystem/handle-store.js', () => ({
  setBuildFileSystemConfig: async (...args: unknown[]) => mockSetBuildFileSystemConfig(...(args as [string, string])),
  getStoredDirectoryHandle: async () => mockGetStoredDirectoryHandle(),
  checkHandlePermission: async () => mockCheckHandlePermission(),
}));

const mainFile = 'main.ts';

const stubProjectData = {
  name: 'Test',
  description: '',
  author: { name: '', avatar: '' },
  tags: [] as string[],
  thumbnail: '',
  assets: {},
} as const;

const fakeProject: Project = {
  id: 'test-project-id',
  name: 'Test Project',
  description: '',
  author: { name: '', avatar: '' },
  tags: [],
  thumbnail: '',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  assets: {},
};

const mockCreateProjectWithResources = vi.fn().mockResolvedValue({ project: fakeProject });

vi.mock('#hooks/project-manager.machine.js', async () => {
  const xstate = await import('xstate');
  const machine = xstate.setup({}).createMachine({
    id: 'projectManager',
    initial: 'ready',
    context: {
      worker: undefined as Worker | undefined,
      wrappedWorker: undefined as unknown,
      error: undefined as Error | undefined,
    },
    states: {
      ready: {},
    },
  });

  return {
    projectManagerMachine: machine,
  };
});

vi.mock('xstate', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    waitFor: vi.fn().mockResolvedValue({
      matches: (state: string) => state === 'ready',
      context: {
        wrappedWorker: {
          createProjectWithResources: mockCreateProjectWithResources,
        },
      },
    }),
  };
});

vi.mock('#hooks/use-cookie.js', () => ({
  useCookie: (_name: string, defaultValue: string) => [defaultValue, vi.fn()],
}));

vi.mock('#constants/project.constants.js', () => ({
  createInitialProject: () => ({
    projectData: { name: 'Test Project' },
    files: { [mainFile]: { content: new Uint8Array([1, 2, 3]) } },
  }),
}));

vi.mock('#utils/kernel.utils.js', () => ({
  getMainFile: () => mainFile,
  getEmptyCode: () => 'export default {};',
}));

vi.mock('#utils/filesystem.utils.js', () => ({
  encodeTextFile: (text: string) => new TextEncoder().encode(text),
}));

vi.mock('#utils/chat.utils.js', () => ({
  createMessage: (options: Record<string, unknown>) => ({ id: 'msg-1', ...options }),
}));

vi.mock('#constants/project-names.js', () => ({
  defaultProjectName: 'Untitled Project',
}));

// eslint-disable-next-line @typescript-eslint/naming-convention -- React component export
const { ProjectManagerProvider, useProjectManager } = await import('#hooks/use-project-manager.js');

// ── Test wrapper ──────────────────────────────────────────────────────────────

function createWrapper() {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- React component
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(ProjectManagerProvider, undefined, children);
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFiles(entries: Record<string, number[]>): Record<string, { content: Uint8Array<ArrayBuffer> }> {
  const result: Record<string, { content: Uint8Array<ArrayBuffer> }> = {};
  for (const [key, bytes] of Object.entries(entries)) {
    result[key] = { content: new Uint8Array(bytes) };
  }
  return result;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useProjectManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBackendType = 'indexeddb';
    mockWriteFiles.mockResolvedValue(undefined);
    mockReconfigureBackend.mockResolvedValue(undefined);
    mockSetBuildFileSystemConfig.mockResolvedValue(undefined);
    mockGetStoredDirectoryHandle.mockResolvedValue(undefined);
  });

  describe('createProject backend wiring', () => {
    it('should not reconfigure when resolved backend matches current backend', async () => {
      mockBackendType = 'indexeddb';

      const { result } = renderHook(() => useProjectManager(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.createProject({
          project: stubProjectData,
          files: makeFiles({ [mainFile]: [1] }),
        });
      });

      expect(mockReconfigureBackend).not.toHaveBeenCalled();
      expect(mockWriteFiles).toHaveBeenCalledOnce();
    });

    it('should reconfigure to opfs before writing and restore to indexeddb after', async () => {
      mockBackendType = 'indexeddb';
      const callOrder: string[] = [];

      mockReconfigureBackend.mockImplementation(async (backend) => {
        callOrder.push(`reconfigure:${backend}`);
      });
      mockWriteFiles.mockImplementation(async () => {
        callOrder.push('writeFiles');
      });

      const { result } = renderHook(() => useProjectManager(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.createProject({
          project: stubProjectData,
          files: makeFiles({ [mainFile]: [1] }),
          backend: 'opfs',
        });
      });

      expect(callOrder).toEqual(['reconfigure:opfs', 'writeFiles', 'reconfigure:indexeddb']);
    });

    it('should restore previous backend even when writeFiles throws', async () => {
      mockBackendType = 'indexeddb';
      mockWriteFiles.mockRejectedValueOnce(new Error('write failed'));

      const { result } = renderHook(() => useProjectManager(), { wrapper: createWrapper() });

      await expect(
        act(async () => {
          await result.current.createProject({
            project: stubProjectData,
            files: makeFiles({ [mainFile]: [1] }),
            backend: 'opfs',
          });
        }),
      ).rejects.toThrow('write failed');

      expect(mockReconfigureBackend).toHaveBeenCalledWith('opfs');
      expect(mockReconfigureBackend).toHaveBeenCalledWith('indexeddb');
      expect(mockReconfigureBackend).toHaveBeenCalledTimes(2);
    });

    it('should store the resolved backend in per-project config', async () => {
      mockBackendType = 'indexeddb';

      const { result } = renderHook(() => useProjectManager(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.createProject({
          project: stubProjectData,
          files: makeFiles({ [mainFile]: [1] }),
          backend: 'opfs',
        });
      });

      expect(mockSetBuildFileSystemConfig).toHaveBeenCalledWith(fakeProject.id, 'opfs');
    });

    it('should fall back to indexeddb when webaccess has no stored handle', async () => {
      mockBackendType = 'indexeddb';
      mockGetStoredDirectoryHandle.mockResolvedValue(undefined);

      const { result } = renderHook(() => useProjectManager(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.createProject({
          project: stubProjectData,
          files: makeFiles({ [mainFile]: [1] }),
          backend: 'webaccess',
        });
      });

      expect(mockSetBuildFileSystemConfig).toHaveBeenCalledWith(fakeProject.id, 'indexeddb');
      expect(mockReconfigureBackend).not.toHaveBeenCalled();
    });

    it('should not reconfigure when already on the target backend', async () => {
      mockBackendType = 'opfs';

      const { result } = renderHook(() => useProjectManager(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.createProject({
          project: stubProjectData,
          files: makeFiles({ [mainFile]: [1] }),
          backend: 'opfs',
        });
      });

      expect(mockReconfigureBackend).not.toHaveBeenCalled();
      expect(mockWriteFiles).toHaveBeenCalledOnce();
    });

    it('should write files with correct project paths', async () => {
      mockBackendType = 'indexeddb';
      const sourceFile = 'src/main.ts';
      const packageFile = 'package.json';

      const { result } = renderHook(() => useProjectManager(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.createProject({
          project: stubProjectData,
          files: makeFiles({ [sourceFile]: [1], [packageFile]: [2] }),
        });
      });

      const writtenFiles = mockWriteFiles.mock.calls[0]![0];
      const paths = Object.keys(writtenFiles);
      expect(paths).toContain(`/projects/${fakeProject.id}/${sourceFile}`);
      expect(paths).toContain(`/projects/${fakeProject.id}/${packageFile}`);
    });
  });
});
