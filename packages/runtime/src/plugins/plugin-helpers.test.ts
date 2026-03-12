import { describe, it, expect, vi } from 'vitest';
import { createKernelPlugin, createMiddlewarePlugin, createBundlerPlugin } from '#plugins/plugin-helpers.js';

// ===================================================================
// createKernelPlugin
// ===================================================================

describe('createKernelPlugin', () => {
  it('should produce a plugin with correct shape from static config', () => {
    const factory = createKernelPlugin({
      id: 'test-kernel',
      moduleUrl: 'https://example.com/kernel.js',
      extensions: ['ts', 'js'],
    });

    const plugin = factory();
    expect(plugin).toEqual({
      id: 'test-kernel',
      moduleUrl: 'https://example.com/kernel.js',
      extensions: ['ts', 'js'],
      options: undefined,
    });
  });

  it('should merge options into the plugin object', () => {
    const factory = createKernelPlugin<{ wasmUrl: string }>({
      id: 'wasm-kernel',
      moduleUrl: 'https://example.com/wasm.js',
      extensions: ['ts'],
    });

    const plugin = factory({ wasmUrl: '/custom.wasm' });
    expect(plugin.id).toBe('wasm-kernel');
    expect(plugin.options).toEqual({ wasmUrl: '/custom.wasm' });
  });

  it('should call builder function with options when config is a function', () => {
    const builder = vi.fn().mockReturnValue({
      id: 'dynamic-kernel',
      moduleUrl: 'https://example.com/dynamic.js',
      extensions: ['tsx'],
    });

    const factory = createKernelPlugin<{ mode: string }>(builder);
    const plugin = factory({ mode: 'fast' });

    expect(builder).toHaveBeenCalledWith({ mode: 'fast' });
    expect(plugin.id).toBe('dynamic-kernel');
    expect(plugin.options).toEqual({ mode: 'fast' });
  });

  it('should call builder function with undefined when no options passed', () => {
    const builder = vi.fn().mockReturnValue({
      id: 'no-opts',
      moduleUrl: 'https://example.com/no-opts.js',
      extensions: ['js'],
    });

    const factory = createKernelPlugin(builder);
    factory();

    expect(builder).toHaveBeenCalledWith(undefined);
  });

  it('should preserve detectImport and builtinModuleNames from config', () => {
    const factory = createKernelPlugin({
      id: 'rich-kernel',
      moduleUrl: 'https://example.com/rich.js',
      extensions: ['ts', 'js'],
      detectImport: /import.*from\s+["']my-lib["']/s,
      builtinModuleNames: ['my-lib'],
    });

    const plugin = factory();
    expect(plugin.detectImport).toBeInstanceOf(RegExp);
    expect(plugin.builtinModuleNames).toEqual(['my-lib']);
  });
});

// ===================================================================
// createMiddlewarePlugin
// ===================================================================

describe('createMiddlewarePlugin', () => {
  it('should produce a plugin with correct shape from static config', () => {
    const factory = createMiddlewarePlugin({
      id: 'test-middleware',
      moduleUrl: 'https://example.com/middleware.js',
    });

    const plugin = factory();
    expect(plugin).toEqual({
      id: 'test-middleware',
      moduleUrl: 'https://example.com/middleware.js',
      options: undefined,
    });
  });

  it('should merge options into the plugin object', () => {
    const factory = createMiddlewarePlugin<{ cacheSize: number }>({
      id: 'cache-middleware',
      moduleUrl: 'https://example.com/cache.js',
    });

    const plugin = factory({ cacheSize: 100 });
    expect(plugin.id).toBe('cache-middleware');
    expect(plugin.options).toEqual({ cacheSize: 100 });
  });

  it('should call builder function with options when config is a function', () => {
    const builder = vi.fn().mockReturnValue({
      id: 'dynamic-mw',
      moduleUrl: 'https://example.com/dynamic-mw.js',
    });

    const factory = createMiddlewarePlugin<{ threshold: number }>(builder);
    factory({ threshold: 50 });

    expect(builder).toHaveBeenCalledWith({ threshold: 50 });
  });
});

// ===================================================================
// createBundlerPlugin
// ===================================================================

describe('createBundlerPlugin', () => {
  it('should produce a plugin with correct shape from static config', () => {
    const factory = createBundlerPlugin({
      id: 'test-bundler',
      moduleUrl: 'https://example.com/bundler.js',
      extensions: ['ts', 'js', 'tsx', 'jsx'],
    });

    const plugin = factory();
    expect(plugin).toEqual({
      id: 'test-bundler',
      moduleUrl: 'https://example.com/bundler.js',
      extensions: ['ts', 'js', 'tsx', 'jsx'],
      options: undefined,
    });
  });

  it('should merge options into the plugin object', () => {
    const factory = createBundlerPlugin<{ minify: boolean }>({
      id: 'minify-bundler',
      moduleUrl: 'https://example.com/minify.js',
      extensions: ['ts'],
    });

    const plugin = factory({ minify: true });
    expect(plugin.id).toBe('minify-bundler');
    expect(plugin.options).toEqual({ minify: true });
  });

  it('should call builder function with options when config is a function', () => {
    const builder = vi.fn((options: { extensions?: string[] } | undefined) => ({
      id: 'esbuild',
      moduleUrl: 'https://example.com/esbuild.js',
      extensions: options?.extensions ?? ['ts', 'js'],
    }));

    const factory = createBundlerPlugin<{ extensions?: string[] }>(builder);
    const plugin = factory({ extensions: ['ts', 'tsx'] });

    expect(builder).toHaveBeenCalledWith({ extensions: ['ts', 'tsx'] });
    expect(plugin.extensions).toEqual(['ts', 'tsx']);
    expect(plugin.options).toEqual({ extensions: ['ts', 'tsx'] });
  });

  it('should use default extensions when builder receives undefined options', () => {
    const builder = vi.fn((options: { extensions?: string[] } | undefined) => ({
      id: 'esbuild',
      moduleUrl: 'https://example.com/esbuild.js',
      extensions: options?.extensions ?? ['ts', 'js', 'tsx', 'jsx'],
    }));

    const factory = createBundlerPlugin(builder);
    const plugin = factory();

    expect(builder).toHaveBeenCalledWith(undefined);
    expect(plugin.extensions).toEqual(['ts', 'js', 'tsx', 'jsx']);
  });
});
