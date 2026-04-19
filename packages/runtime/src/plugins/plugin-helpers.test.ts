import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  createKernelPlugin,
  createMiddlewarePlugin,
  createBundlerPlugin,
  createTranscoderPlugin,
} from '#plugins/plugin-helpers.js';

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

  it('should merge options into the plugin object when optionsSchema is provided', () => {
    const factory = createKernelPlugin({
      id: 'wasm-kernel',
      moduleUrl: 'https://example.com/wasm.js',
      extensions: ['ts'],
      optionsSchema: z.object({ wasmUrl: z.string() }),
    });

    const plugin = factory({ wasmUrl: '/custom.wasm' });
    expect(plugin.id).toBe('wasm-kernel');
    expect(plugin.options).toEqual({ wasmUrl: '/custom.wasm' });
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

  it('should strip optionsSchema, exportSchemas, and renderSchema from returned plugin', () => {
    const factory = createKernelPlugin({
      id: 'strip-test',
      moduleUrl: 'https://example.com/strip.js',
      extensions: ['ts'],
      optionsSchema: z.object({ debug: z.boolean().default(false) }),
      exportSchemas: { stl: z.object({ binary: z.boolean().default(true) }) },
      renderSchema: z.object({ quality: z.number().default(1) }),
    });

    const plugin = factory();
    expect(plugin).not.toHaveProperty('optionsSchema');
    expect(plugin).not.toHaveProperty('exportSchemas');
    expect(plugin).not.toHaveProperty('renderSchema');
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

// ===================================================================
// createTranscoderPlugin
// ===================================================================

describe('createTranscoderPlugin', () => {
  it('should produce a plugin with correct shape from static config', () => {
    const factory = createTranscoderPlugin({
      id: 'test-transcoder',
      moduleUrl: 'https://example.com/transcoder.js',
    });

    const plugin = factory();
    expect(plugin).toEqual({
      id: 'test-transcoder',
      moduleUrl: 'https://example.com/transcoder.js',
      options: undefined,
    });
  });

  it('should merge options into the plugin object', () => {
    const factory = createTranscoderPlugin<{ apiKey: string }>({
      id: 'cloud-transcoder',
      moduleUrl: 'https://example.com/cloud.js',
    });

    const plugin = factory({ apiKey: 'abc123' });
    expect(plugin.id).toBe('cloud-transcoder');
    expect(plugin.options).toEqual({ apiKey: 'abc123' });
  });

  it('should call builder function with options when config is a function', () => {
    const builder = vi.fn().mockReturnValue({
      id: 'dynamic-transcoder',
      moduleUrl: 'https://example.com/dynamic-transcoder.js',
    });

    const factory = createTranscoderPlugin<{ endpoint: string }>(builder);
    factory({ endpoint: 'https://api.example.com' });

    expect(builder).toHaveBeenCalledWith({ endpoint: 'https://api.example.com' });
  });

  it('should call builder function with undefined when no options passed', () => {
    const builder = vi.fn().mockReturnValue({
      id: 'no-opts-transcoder',
      moduleUrl: 'https://example.com/no-opts.js',
    });

    const factory = createTranscoderPlugin(builder);
    factory();

    expect(builder).toHaveBeenCalledWith(undefined);
  });
});
