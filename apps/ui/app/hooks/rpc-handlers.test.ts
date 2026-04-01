import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RpcDependencies, RpcFileSystem } from '@taucad/chat/rpc';
import type { FileEntry } from '@taucad/types';
import type { RpcHandlerDependencies } from '#hooks/rpc-handlers.js';

// ===================================================================
// Module mocks
// ===================================================================

let capturedDeps: RpcDependencies | undefined;

vi.mock('@taucad/chat/rpc', () => ({
  createRpcDispatcher: (deps: RpcDependencies) => {
    capturedDeps = deps;
    return { dispatch: vi.fn() };
  },
}));

const mockWaitFor = vi.fn();
vi.mock('xstate', async () => {
  const actual = await vi.importActual('xstate');
  return {
    ...(actual as Record<string, unknown>),
    // oxlint-disable-next-line no-unsafe-return -- mock factory returns untyped
    waitFor: (...args: unknown[]) => mockWaitFor(...args) as unknown,
  };
});

const { createRpcHandlers } = await import('#hooks/rpc-handlers.js');

// ===================================================================
// Factories
// ===================================================================

type FileEntryOptions = {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size?: number;
};

function createFileEntry(options: FileEntryOptions): FileEntry {
  return {
    path: options.path,
    name: options.name,
    type: options.type,
    size: options.size ?? 100,
    mtimeMs: 0,
    isLoaded: false,
  };
}

type FileManagerWriteCall = [string, Uint8Array<ArrayBuffer>, { source: string }];

function createMockFileManager() {
  return {
    readFile: vi.fn<(path: string) => Promise<Uint8Array<ArrayBuffer>>>(),
    writeFile: vi
      .fn<(path: string, data: Uint8Array<ArrayBuffer>, options: { source: string }) => Promise<void>>()
      .mockResolvedValue(undefined),
    deleteFile: vi.fn<(path: string, options: { source: string }) => Promise<void>>().mockResolvedValue(undefined),
    stat: vi
      .fn<(path: string) => Promise<{ type: 'file' | 'dir'; size: number; mtimeMs: number }>>()
      .mockResolvedValue({ type: 'file', size: 0, mtimeMs: Date.now() }),
  };
}

function createMockBuildRef(options?: { compilationUnits?: Map<string, unknown>; mainEntryFile?: string }) {
  return {
    getSnapshot: vi.fn().mockReturnValue({
      context: {
        compilationUnits: options?.compilationUnits ?? new Map<string, unknown>(),
        mainEntryFile: options?.mainEntryFile ?? 'main.scad',
      },
    }),
    send: vi.fn(),
    on: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
    subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
    getPersistedSnapshot: vi.fn(),
    [Symbol.observable]: vi.fn(),
    id: 'mock-build',
    sessionId: 'mock-session',
    start: vi.fn(),
    stop: vi.fn(),
    system: {},
    src: undefined,
  };
}

function createMockCadUnit(options?: {
  geometries?: Array<{ format: string; content: Uint8Array<ArrayBuffer>; hash: string }>;
  kernelIssues?: Map<string, Array<{ message: string; type: string; severity: string }>>;
  value?: string;
}) {
  return {
    getSnapshot: vi.fn().mockReturnValue({
      value: options?.value ?? 'idle',
      context: {
        geometries: options?.geometries ?? [],
        kernelIssues:
          options?.kernelIssues ?? new Map<string, Array<{ message: string; type: string; severity: string }>>(),
      },
    }),
    on: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
    subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
    id: 'mock-cad',
    sessionId: 'mock-cad-session',
    start: vi.fn(),
    stop: vi.fn(),
    system: {},
    src: undefined,
  };
}

function createMockTreeService(tree?: Map<string, FileEntry>): RpcHandlerDependencies['treeService'] {
  const _tree = tree ?? new Map<string, FileEntry>();
  return {
    getTreeSnapshot: () => _tree,
    exists: vi.fn(async (path: string) => _tree.has(path)),
    readDirectoryEntries: vi.fn(async () => []),
  };
}

let lastTreeService: ReturnType<typeof createMockTreeService> | undefined;

function buildDeps(overrides?: {
  fileManager?: ReturnType<typeof createMockFileManager>;
  fileTree?: Map<string, FileEntry>;
  projectRef?: ReturnType<typeof createMockBuildRef>;
  graphicsRef?: unknown;
  screenshotQuality?: number;
  treeService?: ReturnType<typeof createMockTreeService>;
}): RpcDependencies {
  capturedDeps = undefined;

  const ts = overrides?.treeService ?? createMockTreeService(overrides?.fileTree);
  lastTreeService = ts;

  createRpcHandlers({
    fileManager: (overrides?.fileManager ?? createMockFileManager()) as RpcHandlerDependencies['fileManager'],
    projectRef: (overrides?.projectRef ?? createMockBuildRef()) as unknown as RpcHandlerDependencies['projectRef'],
    graphicsRef: (overrides?.graphicsRef ?? undefined) as RpcHandlerDependencies['graphicsRef'],
    treeService: ts,
    screenshotQuality: overrides?.screenshotQuality ?? 0.8,
  });

  return capturedDeps!;
}

/** Extracts typed write args from the mock's call history. */
function getWriteCall(mockFm: ReturnType<typeof createMockFileManager>, index = 0): FileManagerWriteCall {
  return mockFm.writeFile.mock.calls[index]! as FileManagerWriteCall;
}

// ===================================================================
// Tests
// ===================================================================

describe('rpc-handlers', () => {
  beforeEach(() => {
    capturedDeps = undefined;
    mockWaitFor.mockReset();
  });

  // ===============================================================
  // createBrowserRpcFileSystem
  // ===============================================================

  describe('createBrowserRpcFileSystem', () => {
    let fileSystem: RpcFileSystem;
    let mockFm: ReturnType<typeof createMockFileManager>;
    let fileTree: Map<string, FileEntry>;

    beforeEach(() => {
      mockFm = createMockFileManager();
      fileTree = new Map<string, FileEntry>();
      const deps = buildDeps({ fileManager: mockFm, fileTree });
      fileSystem = deps.fileSystem;
    });

    // ----- readFile -----

    describe('readFile', () => {
      it('should decode binary data to UTF-8 text', async () => {
        const encoded = new TextEncoder().encode('hello world');
        mockFm.readFile.mockResolvedValue(encoded);

        const result = await fileSystem.readFile('test.txt');

        expect(result).toBe('hello world');
        expect(mockFm.readFile).toHaveBeenCalledWith('test.txt');
      });

      it('should handle multi-byte UTF-8 characters', async () => {
        const text = '日本語テスト 🚀';
        const encoded = new TextEncoder().encode(text);
        mockFm.readFile.mockResolvedValue(encoded);

        const result = await fileSystem.readFile('unicode.txt');

        expect(result).toBe(text);
      });

      it('should propagate errors from fileManager', async () => {
        mockFm.readFile.mockRejectedValue(new Error('ENOENT'));

        await expect(fileSystem.readFile('missing.txt')).rejects.toThrow('ENOENT');
      });
    });

    // ----- writeFile -----

    describe('writeFile', () => {
      it('should encode text to binary and write with machine source', async () => {
        await fileSystem.writeFile('output.txt', 'file content');

        expect(mockFm.writeFile).toHaveBeenCalledOnce();
        const [path, data, options] = getWriteCall(mockFm);
        expect(path).toBe('output.txt');
        expect(new TextDecoder().decode(data)).toBe('file content');
        expect(options).toEqual({ source: 'machine' });
      });

      it('should handle empty content', async () => {
        await fileSystem.writeFile('empty.txt', '');

        const [, data] = getWriteCall(mockFm);
        expect(data.byteLength).toBe(0);
      });
    });

    // ----- writeBinaryFile -----

    describe('writeBinaryFile', () => {
      it('should write a copy that does not share the original ArrayBuffer', async () => {
        const original = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

        await fileSystem.writeBinaryFile('model.glb', original);

        expect(mockFm.writeFile).toHaveBeenCalledOnce();
        const [path, written, options] = getWriteCall(mockFm);
        expect(path).toBe('model.glb');
        expect(options).toEqual({ source: 'machine' });
        expect(written.buffer).not.toBe(original.buffer);
        expect(written).toEqual(original);
      });

      it('should not corrupt the original Uint8Array after write', async () => {
        const original = new Uint8Array([1, 2, 3, 4, 5]);
        const snapshot = new Uint8Array(original);

        await fileSystem.writeBinaryFile('data.bin', original);

        expect(original).toEqual(snapshot);
        expect(original.byteLength).toBe(5);
        expect(original.buffer.byteLength).toBe(5);
      });

      it('should correctly copy a view with non-zero byteOffset', async () => {
        const pool = new ArrayBuffer(16);
        const view = new Uint8Array(pool, 4, 4);
        view.set([0x67, 0x6c, 0x54, 0x46]);

        await fileSystem.writeBinaryFile('offset.glb', view);

        const [, written] = getWriteCall(mockFm);
        expect(written.byteLength).toBe(4);
        expect(written).toEqual(new Uint8Array([0x67, 0x6c, 0x54, 0x46]));
        expect(written.byteOffset).toBe(0);
      });

      it('should handle empty data', async () => {
        const empty = new Uint8Array(0);

        await fileSystem.writeBinaryFile('empty.bin', empty);

        const [, written] = getWriteCall(mockFm);
        expect(written.byteLength).toBe(0);
      });
    });

    // ----- deleteFile -----

    describe('deleteFile', () => {
      it('should delete with machine source', async () => {
        await fileSystem.deleteFile('obsolete.txt');

        expect(mockFm.deleteFile).toHaveBeenCalledWith('obsolete.txt', { source: 'machine' });
      });
    });

    // ----- readdir -----

    describe('readdir', () => {
      it('should delegate to treeService.readDirectoryEntries without stat calls', async () => {
        vi.mocked(lastTreeService!.readDirectoryEntries).mockResolvedValueOnce([
          { id: 'main.ts', name: 'main.ts' },
          { id: 'utils.ts', name: 'utils.ts' },
          { id: 'lib', name: 'lib', children: [] },
        ]);

        const entries = await fileSystem.readdir('src');

        expect(entries).toHaveLength(3);
        expect(lastTreeService!.readDirectoryEntries).toHaveBeenCalledWith('src');
        expect(mockFm.stat).not.toHaveBeenCalled();
      });

      it('should return empty array when no entries exist', async () => {
        vi.mocked(lastTreeService!.readDirectoryEntries).mockResolvedValueOnce([]);

        const entries = await fileSystem.readdir('lib');

        expect(entries).toEqual([]);
      });

      it('should map entries with children to directory type', async () => {
        vi.mocked(lastTreeService!.readDirectoryEntries).mockResolvedValueOnce([
          { id: 'components', name: 'components', children: [] },
        ]);

        const entries = await fileSystem.readdir('src');

        expect(entries).toEqual([expect.objectContaining({ name: 'components', type: 'directory' })]);
      });

      it('should map entries without children to file type', async () => {
        vi.mocked(lastTreeService!.readDirectoryEntries).mockResolvedValueOnce([{ id: 'main.ts', name: 'main.ts' }]);

        const entries = await fileSystem.readdir('src');

        expect(entries).toEqual([expect.objectContaining({ name: 'main.ts', type: 'file' })]);
      });
    });

    // ----- exists -----

    describe('exists', () => {
      it('should return true when path exists in fileTree', async () => {
        fileTree.set('main.scad', createFileEntry({ path: 'main.scad', name: 'main.scad', type: 'file' }));

        expect(await fileSystem.exists('main.scad')).toBe(true);
      });

      it('should return false when path does not exist', async () => {
        expect(await fileSystem.exists('missing.txt')).toBe(false);
      });
    });
  });

  // ===============================================================
  // createBrowserGraphicsClient
  // ===============================================================

  describe('createBrowserGraphicsClient', () => {
    describe('fetchGeometry', () => {
      it('should return GLB content from the main compilation unit', async () => {
        const glbContent = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);
        const cadUnit = createMockCadUnit({
          geometries: [{ format: 'gltf', content: glbContent, hash: 'abc123' }],
        });
        const compilationUnits = new Map<string, unknown>([['main.scad', cadUnit]]);
        const projectRef = createMockBuildRef({ compilationUnits, mainEntryFile: 'main.scad' });
        const deps = buildDeps({ projectRef, graphicsRef: projectRef });
        const graphics = deps.graphics!;

        const result = await graphics.fetchGeometry();

        expect(result.success).toBe(true);
        expect(result).toEqual(
          expect.objectContaining({
            success: true,
            glb: glbContent,
          }),
        );
      });

      it('should return error when no compilation unit exists for main entry', async () => {
        const projectRef = createMockBuildRef({
          compilationUnits: new Map<string, unknown>(),
          mainEntryFile: 'main.scad',
        });
        const deps = buildDeps({ projectRef, graphicsRef: projectRef });
        const graphics = deps.graphics!;

        const result = await graphics.fetchGeometry();

        expect(result).toEqual({
          success: false,
          errorCode: 'UNKNOWN',
          message: 'No compilation unit found for main entry file',
        });
      });

      it('should return error when no GLTF geometry is available', async () => {
        const cadUnit = createMockCadUnit({ geometries: [] });
        const compilationUnits = new Map<string, unknown>([['main.scad', cadUnit]]);
        const projectRef = createMockBuildRef({ compilationUnits, mainEntryFile: 'main.scad' });
        const deps = buildDeps({ projectRef, graphicsRef: projectRef });
        const graphics = deps.graphics!;

        const result = await graphics.fetchGeometry();

        expect(result).toEqual({
          success: false,
          errorCode: 'UNKNOWN',
          message: 'No GLTF geometry available',
        });
      });

      it('should find the gltf geometry among multiple formats', async () => {
        const glbContent = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
        const cadUnit = createMockCadUnit({
          geometries: [
            { format: 'svg', content: new Uint8Array(), hash: 'svg1' },
            { format: 'gltf', content: glbContent, hash: 'glb1' },
          ],
        });
        const compilationUnits = new Map<string, unknown>([['main.scad', cadUnit]]);
        const projectRef = createMockBuildRef({ compilationUnits, mainEntryFile: 'main.scad' });
        const deps = buildDeps({ projectRef, graphicsRef: projectRef });
        const graphics = deps.graphics!;

        const result = await graphics.fetchGeometry();

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.glb).toBe(glbContent);
        }
      });

      it('should return a direct reference to geometry.content', async () => {
        const glbContent = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
        const cadUnit = createMockCadUnit({
          geometries: [{ format: 'gltf', content: glbContent, hash: 'abc' }],
        });
        const compilationUnits = new Map<string, unknown>([['main.scad', cadUnit]]);
        const projectRef = createMockBuildRef({ compilationUnits, mainEntryFile: 'main.scad' });
        const deps = buildDeps({ projectRef, graphicsRef: projectRef });
        const graphics = deps.graphics!;

        const result = await graphics.fetchGeometry();

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.glb).toBe(glbContent);
        }
      });

      it('should handle getSnapshot throwing by returning error', async () => {
        const projectRef = createMockBuildRef();
        projectRef.getSnapshot.mockImplementation(() => {
          throw new Error('Actor not running');
        });
        const deps = buildDeps({ projectRef, graphicsRef: projectRef });
        const graphics = deps.graphics!;

        const result = await graphics.fetchGeometry();

        expect(result).toEqual({
          success: false,
          errorCode: 'UNKNOWN',
          message: 'Actor not running',
        });
      });
    });
  });

  // ===============================================================
  // createBrowserRuntimeClient
  // ===============================================================

  describe('createBrowserRuntimeClient', () => {
    describe('getKernelResult', () => {
      it('should return ready status when cad unit is idle with no errors', async () => {
        const cadUnit = createMockCadUnit({ value: 'idle' });
        const compilationUnits = new Map<string, unknown>([['main.scad', cadUnit]]);
        const projectRef = createMockBuildRef({ compilationUnits });
        mockWaitFor.mockResolvedValue({
          value: 'idle',
          context: { kernelIssues: new Map<string, unknown[]>() },
        });

        const deps = buildDeps({ projectRef });
        const result = await deps.kernelClient.getKernelResult('main.scad');

        expect(result).toEqual({
          success: true,
          status: 'ready',
          kernelIssues: [],
        });
      });

      it('should return error status when kernel issues contain errors', async () => {
        const issues = [{ message: 'Syntax error', type: 'compile', severity: 'error' }];
        const kernelIssues = new Map([['main.scad', issues]]);
        const cadUnit = createMockCadUnit({ value: 'idle', kernelIssues });
        const compilationUnits = new Map<string, unknown>([['main.scad', cadUnit]]);
        const projectRef = createMockBuildRef({ compilationUnits });
        mockWaitFor.mockResolvedValue({
          value: 'idle',
          context: { kernelIssues },
        });

        const deps = buildDeps({ projectRef });
        const result = await deps.kernelClient.getKernelResult('main.scad');

        expect(result).toEqual({
          success: true,
          status: 'error',
          kernelIssues: issues,
        });
      });

      it('should return error status when cad unit machine is in error state', async () => {
        const cadUnit = createMockCadUnit({ value: 'error' });
        const compilationUnits = new Map<string, unknown>([['main.scad', cadUnit]]);
        const projectRef = createMockBuildRef({ compilationUnits });
        mockWaitFor.mockResolvedValue({
          value: 'error',
          context: { kernelIssues: new Map<string, unknown[]>() },
        });

        const deps = buildDeps({ projectRef });
        const result = await deps.kernelClient.getKernelResult('main.scad');

        expect(result).toEqual({
          success: true,
          status: 'error',
          kernelIssues: [],
        });
      });

      it('should return ready when warnings exist but no errors', async () => {
        const issues = [{ message: 'Deprecated API', type: 'runtime', severity: 'warning' }];
        const kernelIssues = new Map([['main.scad', issues]]);
        const cadUnit = createMockCadUnit({ value: 'idle', kernelIssues });
        const compilationUnits = new Map<string, unknown>([['main.scad', cadUnit]]);
        const projectRef = createMockBuildRef({ compilationUnits });
        mockWaitFor.mockResolvedValue({
          value: 'idle',
          context: { kernelIssues },
        });

        const deps = buildDeps({ projectRef });
        const result = await deps.kernelClient.getKernelResult('main.scad');

        expect(result).toEqual({
          success: true,
          status: 'ready',
          kernelIssues: issues,
        });
      });

      it('should send createCompilationUnit when unit does not exist', async () => {
        const cadUnit = createMockCadUnit({ value: 'idle' });
        const emptyUnits = new Map<string, unknown>();
        const populatedUnits = new Map<string, unknown>([['new-file.scad', cadUnit]]);
        const projectRef = createMockBuildRef({ compilationUnits: emptyUnits });
        projectRef.getSnapshot
          .mockReturnValueOnce({ context: { compilationUnits: emptyUnits, mainEntryFile: 'main.scad' } })
          .mockReturnValue({ context: { compilationUnits: populatedUnits, mainEntryFile: 'main.scad' } });
        mockWaitFor.mockResolvedValue({
          value: 'idle',
          context: { kernelIssues: new Map<string, unknown[]>() },
        });

        const deps = buildDeps({ projectRef });
        const result = await deps.kernelClient.getKernelResult('new-file.scad');

        expect(projectRef.send).toHaveBeenCalledWith({
          type: 'createCompilationUnit',
          entryFile: 'new-file.scad',
        });
        expect(result.success).toBe(true);
      });

      it('should return error when compilation unit cannot be created', async () => {
        const projectRef = createMockBuildRef({ compilationUnits: new Map<string, unknown>() });

        const deps = buildDeps({ projectRef });
        const result = await deps.kernelClient.getKernelResult('impossible.scad');

        expect(result).toEqual({
          success: false,
          errorCode: 'UNKNOWN',
          message: 'Failed to create compilation unit',
        });
      });

      it('should return error when waitFor rejects', async () => {
        const cadUnit = createMockCadUnit();
        const compilationUnits = new Map<string, unknown>([['main.scad', cadUnit]]);
        const projectRef = createMockBuildRef({ compilationUnits });
        mockWaitFor.mockRejectedValue(new Error('Actor stopped'));

        const deps = buildDeps({ projectRef });
        const result = await deps.kernelClient.getKernelResult('main.scad');

        expect(result).toEqual({
          success: false,
          errorCode: 'UNKNOWN',
          message: 'Actor stopped',
        });
      });
    });
  });

  // ===============================================================
  // createRpcHandlers (factory)
  // ===============================================================

  describe('createRpcHandlers', () => {
    it('should set graphics to undefined when graphicsRef is undefined', () => {
      const deps = buildDeps({ graphicsRef: undefined });

      expect(deps.graphics).toBeUndefined();
    });

    it('should provide graphics when graphicsRef is defined', () => {
      const projectRef = createMockBuildRef();
      const deps = buildDeps({ projectRef, graphicsRef: projectRef });

      expect(deps.graphics).toBeDefined();
    });

    it('should return an object with executeRpcCall method', () => {
      const handlers = createRpcHandlers({
        fileManager: createMockFileManager() as RpcHandlerDependencies['fileManager'],
        projectRef: createMockBuildRef() as unknown as RpcHandlerDependencies['projectRef'],
        graphicsRef: undefined as RpcHandlerDependencies['graphicsRef'],
        treeService: createMockTreeService(),
        screenshotQuality: 0.8,
      });

      expect(handlers).toHaveProperty('executeRpcCall');
      expect(typeof handlers.executeRpcCall).toBe('function');
    });
  });
});
