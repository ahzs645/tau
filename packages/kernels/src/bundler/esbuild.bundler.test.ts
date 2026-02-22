/**
 * ESBuild Bundler – HTTP URL handler tests
 *
 * Validates the safeguards on the `http-url` onLoad handler:
 * - Fetch timeout via AbortSignal
 * - Response size limit enforcement
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// eslint-disable-next-line import-x/order -- must mock esbuild-wasm before importing the bundler
import type { KernelFilesystem } from '@taucad/types';

import type { PluginBuild } from 'esbuild-wasm';
import { createZenFsPlugin, httpFetchMaxSizeBytes } from '#bundler/esbuild-core.js';
import { ModuleManager } from '#bundler/module-manager.js';

// Mock esbuild-wasm to prevent its environment invariant check from failing in jsdom
vi.mock('esbuild-wasm', () => ({
  initialize: vi.fn(),
  build: vi.fn(),
}));

// =============================================================================
// Mock Filesystem
// =============================================================================

type MockFilesystem = {
  [K in keyof KernelFilesystem]: ReturnType<typeof vi.fn>;
};

function createMockFilesystem(): MockFilesystem {
  return {
    readFile: vi.fn<KernelFilesystem['readFile']>().mockRejectedValue(new Error('File not found')),
    readFiles: vi.fn<KernelFilesystem['readFiles']>().mockResolvedValue({}),
    exists: vi.fn<KernelFilesystem['exists']>().mockResolvedValue(false),
    readdir: vi.fn<KernelFilesystem['readdir']>().mockResolvedValue([]),
    writeFile: vi.fn<KernelFilesystem['writeFile']>().mockResolvedValue(undefined),
    mkdir: vi.fn<KernelFilesystem['mkdir']>().mockResolvedValue(undefined),
    unlink: vi.fn<KernelFilesystem['unlink']>().mockResolvedValue(undefined),
    ensureDirectoryExists: vi.fn<KernelFilesystem['ensureDirectoryExists']>().mockResolvedValue(undefined),
    getDirectoryContents: vi.fn<KernelFilesystem['getDirectoryContents']>().mockResolvedValue({}),
    getDirectoryStat: vi.fn<KernelFilesystem['getDirectoryStat']>().mockResolvedValue([]),
  };
}

// =============================================================================
// Mock Fetch Helpers
// =============================================================================

const mockFetch = vi.fn<typeof fetch>();

function createSuccessResponse(body: string, headers?: Record<string, string>): Response {
  const headerMap = new Headers(headers);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: headerMap,
    text: vi.fn<() => Promise<string>>().mockResolvedValue(body),
    json: vi.fn<() => Promise<unknown>>().mockResolvedValue({}),
    clone: vi.fn<() => Response>(),
    body: undefined,
    bodyUsed: false,
    arrayBuffer: vi.fn<() => Promise<ArrayBuffer>>(),
    blob: vi.fn<() => Promise<Blob>>(),
    formData: vi.fn<() => Promise<FormData>>(),
    bytes: vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>(),
    redirected: false,
    type: 'basic' as ResponseType,
    url: '',
  } as unknown as Response;
}

// =============================================================================
// Plugin Handler Capture Utility
// =============================================================================

type OnLoadArgs = {
  path: string;
  namespace: string;
  suffix: string;
  pluginData: unknown;
  with: Record<string, string>;
};

type CapturedHandler = (args: OnLoadArgs) => Promise<unknown>;

/**
 * Create the ZenFS plugin with mocks and capture the `http-url` onLoad handler
 * so it can be invoked directly in tests without requiring esbuild-wasm.
 */
function captureHttpUrlOnLoadHandler(filesystem: MockFilesystem): CapturedHandler {
  let httpUrlOnLoad: CapturedHandler | undefined;

  const mockBuild = {
    onResolve: vi.fn(),
    onLoad: vi.fn().mockImplementation((options: { namespace?: string }, callback: CapturedHandler) => {
      if (options.namespace === 'http-url') {
        httpUrlOnLoad = callback;
      }
    }),
    onStart: vi.fn(),
    onEnd: vi.fn(),
    onDispose: vi.fn(),
    resolve: vi.fn(),
    esbuild: {},
    initialOptions: {},
  };

  const plugin = createZenFsPlugin({
    filesystem: filesystem as unknown as KernelFilesystem,
    moduleManager: new ModuleManager(filesystem as unknown as KernelFilesystem),
    builtinModules: new Map(),
    projectPath: '/project',
    entryPath: '/project/main.ts',
    autoExportNames: ['main'],
  });

  void plugin.setup(mockBuild as unknown as PluginBuild);

  if (!httpUrlOnLoad) {
    throw new Error('http-url onLoad handler was not registered');
  }

  return httpUrlOnLoad;
}

// =============================================================================
// Test Suite
// =============================================================================

describe('ESBuild Bundler – http-url onLoad handler', () => {
  let filesystem: MockFilesystem;
  let handler: CapturedHandler;

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    filesystem = createMockFilesystem();
    handler = captureHttpUrlOnLoadHandler(filesystem);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Timeout Signal
  // ===========================================================================

  describe('timeout signal', () => {
    it('should pass an AbortSignal to fetch', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse('export default 42;'));

      await handler({
        path: 'https://esm.sh/lodash',
        namespace: 'http-url',
        suffix: '',
        pluginData: undefined,
        with: {},
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, fetchOptions] = mockFetch.mock.calls[0]!;
      expect(fetchOptions).toBeDefined();
      expect(fetchOptions!.signal).toBeInstanceOf(AbortSignal);
    });

    it('should return an error when fetch times out', async () => {
      const timeoutError = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      mockFetch.mockRejectedValue(timeoutError);

      const result = (await handler({
        path: 'https://esm.sh/slow-package',
        namespace: 'http-url',
        suffix: '',
        pluginData: undefined,
        with: {},
      })) as { errors: Array<{ text: string }> };

      expect(result.errors).toBeDefined();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.text).toContain('slow-package');
      expect(result.errors[0]!.text).toContain('aborted');
    });
  });

  // ===========================================================================
  // Response Size Limit
  // ===========================================================================

  describe('response size limit', () => {
    it('should reject responses when content-length exceeds the limit', async () => {
      const oversizedLength = String(httpFetchMaxSizeBytes + 1);
      mockFetch.mockResolvedValue(createSuccessResponse('export default 42;', { 'Content-Length': oversizedLength }));

      const result = (await handler({
        path: 'https://esm.sh/huge-package',
        namespace: 'http-url',
        suffix: '',
        pluginData: undefined,
        with: {},
      })) as { errors: Array<{ text: string }> };

      expect(result.errors).toBeDefined();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.text).toContain('exceeds maximum size');
      expect(result.errors[0]!.text).toContain('huge-package');
    });

    it('should reject responses when actual body exceeds the limit', async () => {
      // No content-length header, but the body itself is too large
      const oversizedBody = 'x'.repeat(httpFetchMaxSizeBytes + 1);
      mockFetch.mockResolvedValue(createSuccessResponse(oversizedBody));

      const result = (await handler({
        path: 'https://esm.sh/sneaky-large-package',
        namespace: 'http-url',
        suffix: '',
        pluginData: undefined,
        with: {},
      })) as { errors: Array<{ text: string }> };

      expect(result.errors).toBeDefined();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.text).toContain('exceeds maximum size');
      expect(result.errors[0]!.text).toContain('sneaky-large-package');
    });

    it('should allow responses within the size limit', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse('export default 42;'));

      const result = (await handler({
        path: 'https://esm.sh/small-package/index.js',
        namespace: 'http-url',
        suffix: '',
        pluginData: undefined,
        with: {},
      })) as { contents: string; loader: string };

      expect(result.contents).toBe('export default 42;');
      expect(result.loader).toBe('js');
    });
  });
});
