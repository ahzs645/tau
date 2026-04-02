/**
 * Type-level tests for all generic inference APIs in @taucad/runtime.
 *
 * Covers: defineKernel, defineBundler, defineMiddleware,
 *         createKernelPlugin, createMiddlewarePlugin, createBundlerPlugin,
 *         and createKernelSuccess.
 *
 * These tests are statically analysed by the TypeScript compiler via
 * vitest --typecheck and are never executed at runtime.
 */

import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineKernel } from '#types/runtime-kernel.types.js';
import type { KernelDefinition } from '#types/runtime-kernel.types.js';
import { defineBundler } from '#types/runtime-bundler.types.js';
import { defineMiddleware } from '#middleware/runtime-middleware.js';
import type { KernelMiddleware } from '#middleware/runtime-middleware.js';
import { createKernelError, createKernelSuccess } from '#kernels/kernel-helpers.js';
import type { KernelSuccessResult } from '#types/runtime.types.js';
import { createKernelPlugin, createMiddlewarePlugin, createBundlerPlugin } from '#plugins/plugin-helpers.js';
import type { KernelPlugin, MiddlewarePlugin, BundlerPlugin } from '#plugins/plugin-types.js';

// =============================================================================
// KernelDefinition structural assignability
// =============================================================================

describe('KernelDefinition structural assignability', () => {
  it('should allow concrete KernelDefinition to be assigned to KernelDefinition (default generics)', () => {
    type ConcreteKernel = KernelDefinition<{ fontCache: Map<string, Uint8Array<ArrayBuffer>> }, string>;
    expectTypeOf<ConcreteKernel>().toExtend<KernelDefinition>();
  });

  it('should allow union NativeHandle to be assigned to KernelDefinition (default generics)', () => {
    type ManifoldKernel = KernelDefinition<Record<string, unknown>, { glb: ArrayBuffer } | undefined>;
    expectTypeOf<ManifoldKernel>().toExtend<KernelDefinition>();
  });

  it('should self-assign with default generic args', () => {
    expectTypeOf<KernelDefinition>().toExtend<KernelDefinition>();
  });
});

// =============================================================================
// defineKernel
// =============================================================================

describe('defineKernel type inference', () => {
  it('should infer Context from initialize and flow to all methods', () => {
    defineKernel({
      name: 'Test',
      version: '1.0.0',
      async initialize() {
        return { contextValue: 'hello', count: 42 };
      },
      async canHandle(_input, _runtime, context) {
        expectTypeOf(context).toEqualTypeOf<{
          contextValue: string;
          count: number;
        }>();
        return true;
      },
      async getDependencies(_input, _runtime, context) {
        expectTypeOf(context).toEqualTypeOf<{
          contextValue: string;
          count: number;
        }>();
        return { resolved: [], unresolved: [] };
      },
      async getParameters(_input, _runtime, context) {
        expectTypeOf(context).toEqualTypeOf<{
          contextValue: string;
          count: number;
        }>();
        return createKernelError([]);
      },
      async createGeometry(_input, _runtime, context) {
        expectTypeOf(context).toEqualTypeOf<{
          contextValue: string;
          count: number;
        }>();
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry(_input, _runtime, context) {
        expectTypeOf(context).toEqualTypeOf<{
          contextValue: string;
          count: number;
        }>();
        return createKernelError([]);
      },
      async cleanup(context) {
        expectTypeOf(context).toEqualTypeOf<{
          contextValue: string;
          count: number;
        }>();
      },
    });
  });

  it('should infer NativeHandle from createGeometry and flow to exportGeometry', () => {
    defineKernel({
      name: 'Test',
      version: '1.0.0',
      async initialize() {
        return {};
      },
      async getDependencies() {
        return { resolved: [], unresolved: [] };
      },
      async getParameters() {
        return createKernelError([]);
      },
      async createGeometry() {
        return { geometry: [], nativeHandle: new Uint8Array(0) };
      },
      async exportGeometry({ nativeHandle }) {
        expectTypeOf(nativeHandle).toEqualTypeOf<Uint8Array<ArrayBuffer>>();
        return createKernelError([]);
      },
    });
  });

  it('should infer complex NativeHandle types', () => {
    defineKernel({
      name: 'Test',
      version: '1.0.0',
      async initialize() {
        return {};
      },
      async getDependencies() {
        return { resolved: [], unresolved: [] };
      },
      async getParameters() {
        return createKernelError([]);
      },
      async createGeometry() {
        return {
          geometry: [],
          nativeHandle: { meshData: new Float32Array(0), id: 'test' as string },
        };
      },
      async exportGeometry({ nativeHandle }) {
        expectTypeOf(nativeHandle).toEqualTypeOf<{
          meshData: Float32Array<ArrayBuffer>;
          id: string;
        }>();
        return createKernelError([]);
      },
    });
  });

  it('should infer Options from optionsSchema', () => {
    const schema = z.object({
      baseUrl: z.string(),
      debug: z.boolean().default(false),
    });

    defineKernel({
      name: 'Test',
      version: '1.0.0',
      optionsSchema: schema,
      async initialize(options) {
        expectTypeOf(options).toEqualTypeOf<{
          baseUrl: string;
          debug: boolean;
        }>();
        return {};
      },
      async getDependencies() {
        return { resolved: [], unresolved: [] };
      },
      async getParameters() {
        return createKernelError([]);
      },
      async createGeometry() {
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry() {
        return createKernelError([]);
      },
    });
  });

  it('should default Options to Record<string, unknown> when no schema', () => {
    defineKernel({
      name: 'Test',
      version: '1.0.0',
      async initialize(options) {
        expectTypeOf(options).toEqualTypeOf<Record<string, unknown>>();
        return {};
      },
      async getDependencies() {
        return { resolved: [], unresolved: [] };
      },
      async getParameters() {
        return createKernelError([]);
      },
      async createGeometry() {
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry() {
        return createKernelError([]);
      },
    });
  });

  it('should infer all three type params simultaneously', () => {
    const schema = z.object({ wsUrl: z.string().default('wss://example.com') });

    defineKernel({
      name: 'Full',
      version: '1.0.0',
      optionsSchema: schema,
      async initialize(options) {
        expectTypeOf(options).toEqualTypeOf<{ wsUrl: string }>();
        return { url: options.wsUrl, ready: true as boolean };
      },
      async getDependencies(_input, _runtime, context) {
        expectTypeOf(context).toEqualTypeOf<{ url: string; ready: boolean }>();
        return { resolved: [], unresolved: [] };
      },
      async getParameters() {
        return createKernelError([]);
      },
      async createGeometry() {
        return { geometry: [], nativeHandle: new ArrayBuffer(0) };
      },
      async exportGeometry({ nativeHandle }) {
        expectTypeOf(nativeHandle).toEqualTypeOf<ArrayBuffer>();
        return createKernelError([]);
      },
    });
  });

  it('should preserve union types in inferred Context', () => {
    defineKernel({
      name: 'Test',
      version: '1.0.0',
      async initialize() {
        return {
          engine: undefined as string | undefined,
          cache: new Map<string, Uint8Array<ArrayBuffer>>(),
        };
      },
      async getDependencies(_input, _runtime, context) {
        expectTypeOf(context.engine).toEqualTypeOf<string | undefined>();
        expectTypeOf(context.cache).toEqualTypeOf<Map<string, Uint8Array<ArrayBuffer>>>();
        return { resolved: [], unresolved: [] };
      },
      async getParameters() {
        return createKernelError([]);
      },
      async createGeometry() {
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry() {
        return createKernelError([]);
      },
    });
  });
});

// =============================================================================
// defineBundler
// =============================================================================

describe('defineBundler type inference', () => {
  it('should infer Context from initialize and flow to all methods', () => {
    defineBundler({
      name: 'TestBundler',
      version: '1.0.0',
      extensions: ['ts', 'js'],
      async initialize() {
        return { bundlerInstance: 'esbuild' as string, projectPath: '/test' };
      },
      async detectImports(_input, context) {
        expectTypeOf(context).toEqualTypeOf<{
          bundlerInstance: string;
          projectPath: string;
        }>();
        return { detectedModules: [], dependencies: [] };
      },
      async bundle(_input, context) {
        expectTypeOf(context).toEqualTypeOf<{
          bundlerInstance: string;
          projectPath: string;
        }>();
        return { code: '', issues: [], success: true, dependencies: [], unresolvedPaths: [] };
      },
      async execute(_code, context) {
        expectTypeOf(context).toEqualTypeOf<{
          bundlerInstance: string;
          projectPath: string;
        }>();
        return { success: true, value: undefined };
      },
      registerModule(_name, _module, context) {
        expectTypeOf(context).toEqualTypeOf<{
          bundlerInstance: string;
          projectPath: string;
        }>();
      },
      async resolveDependencies(_input, context) {
        expectTypeOf(context).toEqualTypeOf<{
          bundlerInstance: string;
          projectPath: string;
        }>();
        return { resolved: [], unresolved: [] };
      },
      async cleanup(context) {
        expectTypeOf(context).toEqualTypeOf<{
          bundlerInstance: string;
          projectPath: string;
        }>();
      },
    });
  });

  it('should infer Options from optionsSchema', () => {
    const schema = z.object({ minify: z.boolean().default(false) });

    defineBundler({
      name: 'TestBundler',
      version: '1.0.0',
      extensions: ['ts'],
      optionsSchema: schema,
      async initialize(_initOptions, options) {
        expectTypeOf(options).toEqualTypeOf<{ minify: boolean }>();
        return {};
      },
      async detectImports() {
        return { detectedModules: [], dependencies: [] };
      },
      async bundle() {
        return { code: '', issues: [], success: true, dependencies: [], unresolvedPaths: [] };
      },
      async execute() {
        return { success: true, value: undefined };
      },
      registerModule() {
        // Noop
      },
    });
  });

  it('should default Options to Record<string, unknown> when no schema', () => {
    defineBundler({
      name: 'TestBundler',
      version: '1.0.0',
      extensions: ['ts'],
      async initialize(_initOptions, options) {
        expectTypeOf(options).toEqualTypeOf<Record<string, unknown>>();
        return {};
      },
      async detectImports() {
        return { detectedModules: [], dependencies: [] };
      },
      async bundle() {
        return { code: '', issues: [], success: true, dependencies: [], unresolvedPaths: [] };
      },
      async execute() {
        return { success: true, value: undefined };
      },
      registerModule() {
        // No-op
      },
    });
  });
});

// =============================================================================
// defineMiddleware
// =============================================================================

describe('defineMiddleware type inference', () => {
  it('should infer State from stateSchema in wrap hooks', () => {
    const stateSchema = z.object({
      cacheKey: z.string(),
      cacheHit: z.boolean(),
    });

    const middleware = defineMiddleware({
      name: 'TestMiddleware',
      stateSchema,
      async wrapCreateGeometry(input, handler, { state }) {
        expectTypeOf(state.value).toExtend<{
          cacheKey?: string;
          cacheHit?: boolean;
        }>();
        state.update({ cacheKey: 'key', cacheHit: true });
        return handler(input);
      },
    });

    expectTypeOf(middleware).toEqualTypeOf<KernelMiddleware<typeof stateSchema>>();
  });

  it('should infer Options from optionsSchema in wrap hooks', () => {
    const optionsSchema = z.object({ maxCacheSize: z.number().default(100) });

    defineMiddleware({
      name: 'TestMiddleware',
      optionsSchema,
      async wrapCreateGeometry(input, handler, { options }) {
        expectTypeOf(options).toEqualTypeOf<{ maxCacheSize: number }>();
        return handler(input);
      },
    });
  });

  it('should infer both State and Options together', () => {
    const stateSchema = z.object({ hits: z.number() });
    const optionsSchema = z.object({ ttl: z.number() });

    defineMiddleware({
      name: 'TestMiddleware',
      stateSchema,
      optionsSchema,
      async wrapCreateGeometry(input, handler, { state, options }) {
        expectTypeOf(state.value).toExtend<{ hits?: number }>();
        expectTypeOf(options).toEqualTypeOf<{ ttl: number }>();
        return handler(input);
      },
    });
  });

  it('should default State and Options to empty when no schemas', () => {
    const middleware = defineMiddleware({
      name: 'TestMiddleware',
    });

    expectTypeOf(middleware).toEqualTypeOf<KernelMiddleware>();
  });
});

// =============================================================================
// createKernelPlugin
// =============================================================================

describe('createKernelPlugin type inference', () => {
  const staticConfig = { id: 'test', moduleUrl: 'test.js', extensions: ['ts'] };

  describe('overload 1: no type param → zero-arg factory', () => {
    it('should return a zero-arg factory', () => {
      const factory = createKernelPlugin(staticConfig);
      expectTypeOf(factory).toBeFunction();
      // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- valid type test
      expectTypeOf(factory).parameters.toEqualTypeOf<[]>();
      expectTypeOf(factory).returns.toEqualTypeOf<KernelPlugin>();
    });

    it('should produce a valid KernelPlugin when called', () => {
      const factory = createKernelPlugin(staticConfig);
      const plugin = factory();
      expectTypeOf(plugin).toEqualTypeOf<KernelPlugin>();
    });

    it('should reject arguments passed to a zero-arg factory', () => {
      const factory = createKernelPlugin(staticConfig);
      // @ts-expect-error -- zero-arg factory accepts no arguments
      factory({ anything: true });
    });
  });

  describe('overload 2: all-optional options → optional-arg factory', () => {
    it('should return an optional-arg factory', () => {
      const factory = createKernelPlugin<{ debug?: boolean; mode?: string }>(staticConfig);
      expectTypeOf(factory).toBeFunction();
      expectTypeOf(factory).returns.toEqualTypeOf<KernelPlugin>();
    });

    it('should allow calling without arguments', () => {
      const factory = createKernelPlugin<{ debug?: boolean }>(staticConfig);
      const plugin = factory();
      expectTypeOf(plugin).toEqualTypeOf<KernelPlugin>();
    });

    it('should allow calling with options', () => {
      const factory = createKernelPlugin<{ debug?: boolean }>(staticConfig);
      const plugin = factory({ debug: true });
      expectTypeOf(plugin).toEqualTypeOf<KernelPlugin>();
    });

    it('should reject unknown option keys', () => {
      const factory = createKernelPlugin<{ debug?: boolean }>(staticConfig);
      // @ts-expect-error -- 'unknownKey' is not in the options type
      factory({ unknownKey: true });
    });
  });

  describe('overload 2: required options → required-arg factory', () => {
    it('should require the options argument', () => {
      const factory = createKernelPlugin<{ baseUrl: string }>(staticConfig);
      const plugin = factory({ baseUrl: 'wss://example.com' });
      expectTypeOf(plugin).toEqualTypeOf<KernelPlugin>();
    });

    it('should reject calling without required options', () => {
      const factory = createKernelPlugin<{ baseUrl: string }>(staticConfig);
      // @ts-expect-error -- required options must be provided
      factory();
    });

    it('should reject missing required keys', () => {
      const factory = createKernelPlugin<{ baseUrl: string; token: string }>(staticConfig);
      // @ts-expect-error -- 'token' is missing
      factory({ baseUrl: 'wss://example.com' });
    });

    it('should reject wrong option value types', () => {
      const factory = createKernelPlugin<{ baseUrl: string }>(staticConfig);
      // @ts-expect-error -- baseUrl must be a string, not a number
      factory({ baseUrl: 123 });
    });
  });

  describe('overload 2: mixed required and optional → required-arg factory', () => {
    it('should require options when at least one key is required', () => {
      const factory = createKernelPlugin<{ baseUrl: string; debug?: boolean }>(staticConfig);
      const plugin = factory({ baseUrl: 'wss://example.com' });
      expectTypeOf(plugin).toEqualTypeOf<KernelPlugin>();
    });

    it('should reject calling without options', () => {
      const factory = createKernelPlugin<{ baseUrl: string; debug?: boolean }>(staticConfig);
      // @ts-expect-error -- options are required because baseUrl is required
      factory();
    });
  });

  describe('config-as-function', () => {
    it('should accept a config builder function with optional options', () => {
      const factory = createKernelPlugin<{ extensions?: string[] }>((options) => ({
        id: 'test',
        moduleUrl: 'test.js',
        extensions: options?.extensions ?? ['ts', 'js'],
      }));
      const plugin = factory();
      expectTypeOf(plugin).toEqualTypeOf<KernelPlugin>();
    });

    it('should accept a config builder function with required options', () => {
      const factory = createKernelPlugin<{ apiKey: string }>((options) => ({
        id: 'test',
        moduleUrl: 'test.js',
        extensions: ['ts'],
        builtinModuleNames: [options?.apiKey ?? ''],
      }));

      // @ts-expect-error -- apiKey is required
      factory();

      const plugin = factory({ apiKey: 'abc' });
      expectTypeOf(plugin).toEqualTypeOf<KernelPlugin>();
    });
  });
});

// =============================================================================
// createMiddlewarePlugin
// =============================================================================

describe('createMiddlewarePlugin type inference', () => {
  const staticConfig = { id: 'test', moduleUrl: 'test.js' };

  it('should return a zero-arg factory for static config', () => {
    const factory = createMiddlewarePlugin(staticConfig);
    // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- valid type test
    expectTypeOf(factory).parameters.toEqualTypeOf<[]>();
    expectTypeOf(factory).returns.toEqualTypeOf<MiddlewarePlugin>();
  });

  it('should return an optional-arg factory for all-optional options', () => {
    const factory = createMiddlewarePlugin<{ ttl?: number }>(staticConfig);
    const noArguments = factory();
    const withArguments = factory({ ttl: 60 });
    expectTypeOf(noArguments).toEqualTypeOf<MiddlewarePlugin>();
    expectTypeOf(withArguments).toEqualTypeOf<MiddlewarePlugin>();
  });

  it('should return a required-arg factory for required options', () => {
    const factory = createMiddlewarePlugin<{ maxSize: number }>(staticConfig);
    // @ts-expect-error -- maxSize is required
    factory();
    const plugin = factory({ maxSize: 100 });
    expectTypeOf(plugin).toEqualTypeOf<MiddlewarePlugin>();
  });

  it('should reject arguments to a zero-arg factory', () => {
    const factory = createMiddlewarePlugin(staticConfig);
    // @ts-expect-error -- zero-arg factory accepts no arguments
    factory({ anything: true });
  });
});

// =============================================================================
// createBundlerPlugin
// =============================================================================

describe('createBundlerPlugin type inference', () => {
  const staticConfig = { id: 'test', moduleUrl: 'test.js', extensions: ['ts'] };

  it('should return a zero-arg factory for static config', () => {
    const factory = createBundlerPlugin(staticConfig);
    // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- valid type test
    expectTypeOf(factory).parameters.toEqualTypeOf<[]>();
    expectTypeOf(factory).returns.toEqualTypeOf<BundlerPlugin>();
  });

  it('should return an optional-arg factory for all-optional options', () => {
    const factory = createBundlerPlugin<{ minify?: boolean }>(staticConfig);
    const noArguments = factory();
    const withArguments = factory({ minify: true });
    expectTypeOf(noArguments).toEqualTypeOf<BundlerPlugin>();
    expectTypeOf(withArguments).toEqualTypeOf<BundlerPlugin>();
  });

  it('should return a required-arg factory for required options', () => {
    const factory = createBundlerPlugin<{ target: string }>(staticConfig);
    // @ts-expect-error -- target is required
    factory();
    const plugin = factory({ target: 'es2022' });
    expectTypeOf(plugin).toEqualTypeOf<BundlerPlugin>();
  });

  it('should accept config-as-function and preserve optionality', () => {
    const factory = createBundlerPlugin<{ extensions?: string[] }>((options) => ({
      id: 'test',
      moduleUrl: 'test.js',
      extensions: options?.extensions ?? ['ts', 'js'],
    }));
    const noArguments = factory();
    const withArguments = factory({ extensions: ['tsx'] });
    expectTypeOf(noArguments).toEqualTypeOf<BundlerPlugin>();
    expectTypeOf(withArguments).toEqualTypeOf<BundlerPlugin>();
  });

  it('should reject arguments to a zero-arg factory', () => {
    const factory = createBundlerPlugin(staticConfig);
    // @ts-expect-error -- zero-arg factory accepts no arguments
    factory({ anything: true });
  });
});

// =============================================================================
// createKernelSuccess
// =============================================================================

describe('createKernelSuccess type inference', () => {
  it('should infer T from a plain object', () => {
    const result = createKernelSuccess({ foo: 'bar', count: 42 });
    expectTypeOf(result).toEqualTypeOf<KernelSuccessResult<{ foo: string; count: number }>>();
    expectTypeOf(result.data).toEqualTypeOf<{ foo: string; count: number }>();
    expectTypeOf(result.success).toEqualTypeOf<true>();
  });

  it('should infer T from an array', () => {
    const result = createKernelSuccess([1, 2, 3]);
    expectTypeOf(result).toEqualTypeOf<KernelSuccessResult<number[]>>();
    expectTypeOf(result.data).toEqualTypeOf<number[]>();
  });

  it('should infer T from a string', () => {
    const result = createKernelSuccess('hello' as string);
    expectTypeOf(result).toEqualTypeOf<KernelSuccessResult<string>>();
  });

  it('should preserve complex nested types', () => {
    const defaultParameters: Record<string, unknown> = {};
    const result = createKernelSuccess({
      defaultParameters,
      jsonSchema: { type: 'object' } as unknown,
    });
    expectTypeOf(result.data).toEqualTypeOf<{
      defaultParameters: Record<string, unknown>;
      jsonSchema: unknown;
    }>();
  });

  it('should preserve array of objects', () => {
    const result = createKernelSuccess([
      {
        data: new Uint8Array(),
        name: 'model.stl',
        mimeType: 'model/stl',
      } as const,
    ]);
    expectTypeOf(result.data).toEqualTypeOf<
      Array<{
        readonly data: Uint8Array<ArrayBuffer>;
        readonly name: 'model.stl';
        readonly mimeType: 'model/stl';
      }>
    >();
  });

  it('should always include issues array', () => {
    const result = createKernelSuccess('data');
    expectTypeOf(result.issues).toBeArray();
  });
});
