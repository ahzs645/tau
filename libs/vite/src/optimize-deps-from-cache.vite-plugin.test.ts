import { describe, it, expect, vi, beforeEach } from 'vitest';
import { optimizeDepsFromCache } from '#optimize-deps-from-cache.vite-plugin.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const { existsSync, readFileSync } = await import('node:fs');
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

type ConfigHook = (
  config: { root?: string; cacheDir?: string },
  env: { command: string },
) => { optimizeDeps: { include: string[]; needsInterop?: string[] } } | undefined;

function callConfig(config: { root?: string; cacheDir?: string } = {}, command = 'serve') {
  const plugin = optimizeDepsFromCache();
  return (plugin.config as ConfigHook)(config, { command });
}

const metadata = {
  optimized: {
    react: { needsInterop: true },
    'lodash-es': { needsInterop: false },
    three: { needsInterop: false },
    jszip: { needsInterop: true },
  },
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('optimizeDepsFromCache', () => {
  it('should have correct metadata', () => {
    const plugin = optimizeDepsFromCache();
    expect(plugin.name).toBe('vite:optimize-deps-from-cache');
  });

  it('should return undefined for build command', () => {
    const result = callConfig({}, 'build');
    expect(result).toBeUndefined();
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it('should return undefined when metadata file does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = callConfig({ root: '/project', cacheDir: 'node_modules/.vite' });

    expect(result).toBeUndefined();
  });

  it('should return include and needsInterop from metadata', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(metadata));

    const result = callConfig({ root: '/project', cacheDir: 'node_modules/.vite' });

    expect(result).toEqual({
      optimizeDeps: {
        include: ['react', 'lodash-es', 'three', 'jszip'],
        needsInterop: ['react', 'jszip'],
      },
    });
  });

  it('should omit needsInterop when no deps need it', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        optimized: {
          react: { needsInterop: false },
          three: { needsInterop: false },
        },
      }),
    );

    const result = callConfig({ root: '/project', cacheDir: 'node_modules/.vite' });

    expect(result!.optimizeDeps.include).toEqual(['react', 'three']);
    expect(result!.optimizeDeps).not.toHaveProperty('needsInterop');
  });

  it('should return undefined when metadata has empty optimized map', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ optimized: {} }));

    const result = callConfig({ root: '/project', cacheDir: 'node_modules/.vite' });

    expect(result).toBeUndefined();
  });

  it('should return undefined when metadata JSON is invalid', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    const result = callConfig({ root: '/project', cacheDir: 'node_modules/.vite' });

    expect(result).toBeUndefined();
  });

  it('should use default cacheDir when not specified', () => {
    mockExistsSync.mockReturnValue(false);

    callConfig({ root: '/project' });

    expect(mockExistsSync).toHaveBeenCalledWith(expect.stringContaining('node_modules/.vite'));
  });

  it('should resolve cacheDir relative to root', () => {
    mockExistsSync.mockReturnValue(false);

    callConfig({ root: '/project', cacheDir: '../../node_modules/.vite/apps/ui' });

    expect(mockExistsSync).toHaveBeenCalledWith(expect.stringContaining('deps/_metadata.json'));
  });

  it('should use process.cwd() when root is not specified', () => {
    mockExistsSync.mockReturnValue(false);
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/cwd-root');

    try {
      callConfig({});

      expect(mockExistsSync).toHaveBeenCalledWith(expect.stringContaining('/cwd-root'));
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
