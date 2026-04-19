/* eslint-disable @typescript-eslint/naming-convention -- file names include extensions */
/* oxlint-disable max-lines, no-empty-function -- comprehensive type-level test suite covering many APIs; cleanup() bodies are intentionally empty to satisfy the contract */
/* oxlint-disable @typescript-eslint/no-unnecessary-condition -- type-level tests deliberately compare literal values to verify discriminated-union narrowing */
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
import type { FileExtension } from '@taucad/types';
import { defineKernel } from '#types/runtime-kernel.types.js';
import type { KernelDefinition, ExportGeometryInput } from '#types/runtime-kernel.types.js';
import { coordinateSystemSchema } from '#types/export-option-schemas.js';
import { defineBundler } from '#types/runtime-bundler.types.js';
import { defineTranscoder } from '#types/runtime-transcoder.types.js';
import type { TranscoderDefinition, TranscodeInput } from '#types/runtime-transcoder.types.js';
import { defineMiddleware } from '#middleware/runtime-middleware.js';
import type { KernelMiddleware } from '#middleware/runtime-middleware.js';
import { createKernelError, createKernelSuccess } from '#kernels/kernel-helpers.js';
import {
  createKernelPlugin,
  createTranscoderPlugin,
  createMiddlewarePlugin,
  createBundlerPlugin,
} from '#plugins/plugin-helpers.js';
import type {
  KernelPlugin,
  MiddlewarePlugin,
  BundlerPlugin,
  TranscoderPlugin,
  CollectFormatMap,
  CollectExportFormats,
  CollectKernelIds,
  CollectRenderOptions,
  CollectTranscodeMap,
  CollectTranscoderTargets,
  KnownSourceFormats,
  KnownTargetFormats,
  KnownTranscoderIds,
  MergeExportMap,
  RenderOptionsFor,
} from '#plugins/plugin-types.js';
import { createRuntimeClient } from '#client/runtime-client.js';
import { createRuntimeClientOptions } from '#client/runtime-client-options.js';
import type { RuntimeClient } from '#client/runtime-client.js';
import type {
  CapabilitiesManifest,
  ExportRoute,
  KernelRenderSchema,
  KernelSuccessResult,
} from '#types/runtime.types.js';
import { replicad } from '#kernels/replicad/replicad.plugin.js';
import { converterTranscoder } from '#transcoders/converter/converter.plugin.js';
import { presets } from '#plugins/presets.js';

const tessellationSchema = z.object({
  tessellation: z
    .object({
      linearTolerance: z.number().positive().default(0.1),
      angularTolerance: z.number().positive().default(15),
    })
    .default({ linearTolerance: 0.1, angularTolerance: 15 }),
});

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

  it('should infer ExportSchemas and narrow options in exportGeometry', () => {
    const stlSchema = z.object({
      binary: z.boolean().default(true),
    });
    const stepSchema = z.object({
      assemblyMode: z.enum(['single', 'assembly']).default('single'),
    });

    defineKernel({
      name: 'Test',
      version: '1.0.0',
      exportSchemas: { stl: stlSchema, step: stepSchema },
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
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry(input) {
        if (input.format === 'stl') {
          expectTypeOf(input.options).toEqualTypeOf<{ binary: boolean }>();
        }
        if (input.format === 'step') {
          expectTypeOf(input.options).toEqualTypeOf<{ assemblyMode: 'single' | 'assembly' }>();
        }
        return createKernelError([]);
      },
    });
  });

  it('should include tessellation and coordinateSystem in mesh format options (R2 composed schemas)', () => {
    const meshSchema = tessellationSchema.extend(coordinateSystemSchema.shape).extend({
      binary: z.boolean().default(true),
    });

    defineKernel({
      name: 'MeshKernel',
      version: '1.0.0',
      exportSchemas: { stl: meshSchema },
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
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry(input) {
        if (input.format === 'stl') {
          expectTypeOf(input.options).toEqualTypeOf<{
            tessellation: { linearTolerance: number; angularTolerance: number };
            coordinateSystem: 'y-up' | 'z-up';
            binary: boolean;
          }>();
        }
        return createKernelError([]);
      },
    });
  });

  it('should exclude tessellation from BRep format options (R1 STEP has no tessellation)', () => {
    const stepSchema = z.object({
      assemblyMode: z.enum(['single', 'assembly']).default('single'),
    });

    defineKernel({
      name: 'BRepKernel',
      version: '1.0.0',
      exportSchemas: { step: stepSchema },
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
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry(input) {
        if (input.format === 'step') {
          expectTypeOf(input.options).toEqualTypeOf<{ assemblyMode: 'single' | 'assembly' }>();
        }
        return createKernelError([]);
      },
    });
  });

  it('should produce empty options for empty schemas (R7)', () => {
    const emptySchema = z.object({});

    defineKernel({
      name: 'EmptySchemaKernel',
      version: '1.0.0',
      exportSchemas: { glb: emptySchema },
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
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry(input) {
        if (input.format === 'glb') {
          expectTypeOf(input.options).toEqualTypeOf<Record<string, never>>();
        }
        return createKernelError([]);
      },
    });
  });

  it('should default to Record<string, unknown> options when no exportSchemas', () => {
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
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry(input) {
        expectTypeOf(input.format).toEqualTypeOf<FileExtension>();
        expectTypeOf(input.options).toEqualTypeOf<Record<string, unknown>>();
        return createKernelError([]);
      },
    });
  });

  it('should infer all five type params simultaneously', () => {
    const optionsSchema = z.object({ wsUrl: z.string().default('wss://example.com') });
    const stlSchema = z.object({ binary: z.boolean().default(true) });
    const renderSchema = z.object({ quality: z.number().default(1) });

    defineKernel({
      name: 'Full',
      version: '1.0.0',
      optionsSchema,
      exportSchemas: { stl: stlSchema },
      renderSchema,
      async initialize(options) {
        expectTypeOf(options).toEqualTypeOf<{ wsUrl: string }>();
        return { ready: true as boolean };
      },
      async getDependencies(_input, _runtime, context) {
        expectTypeOf(context).toEqualTypeOf<{ ready: boolean }>();
        return { resolved: [], unresolved: [] };
      },
      async getParameters() {
        return createKernelError([]);
      },
      async createGeometry(input) {
        expectTypeOf(input.options).toEqualTypeOf<{ quality: number }>();
        return { geometry: [], nativeHandle: new ArrayBuffer(0) };
      },
      async exportGeometry(input) {
        expectTypeOf(input.nativeHandle).toEqualTypeOf<ArrayBuffer>();
        if (input.format === 'stl') {
          expectTypeOf(input.options).toEqualTypeOf<{ binary: boolean }>();
        }
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
// renderSchema inference
// =============================================================================

describe('renderSchema type inference', () => {
  it('should infer options type from renderSchema', () => {
    const renderSchema = z.object({
      tessellation: z
        .object({
          linearTolerance: z.number().positive().default(0.1),
          angularTolerance: z.number().positive().default(30),
        })
        .default({ linearTolerance: 0.1, angularTolerance: 30 }),
    });

    defineKernel({
      name: 'TypedRender',
      version: '1.0.0',
      renderSchema,
      async initialize() {
        return {};
      },
      async getDependencies() {
        return { resolved: [], unresolved: [] };
      },
      async getParameters() {
        return createKernelError([]);
      },
      async createGeometry(input) {
        expectTypeOf(input.options).toEqualTypeOf<{
          tessellation: { linearTolerance: number; angularTolerance: number };
        }>();
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry() {
        return createKernelError([]);
      },
    });
  });

  it('should default options to required untyped when no renderSchema', () => {
    defineKernel({
      name: 'UntypedRender',
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
      async createGeometry(input) {
        expectTypeOf(input.options).toEqualTypeOf<Record<string, unknown>>();
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry() {
        return createKernelError([]);
      },
    });
  });

  it('should make options required (not optional) when schema is provided', () => {
    const renderSchema = z.object({ quality: z.number().default(1) });

    defineKernel({
      name: 'RequiredRender',
      version: '1.0.0',
      renderSchema,
      async initialize() {
        return {};
      },
      async getDependencies() {
        return { resolved: [], unresolved: [] };
      },
      async getParameters() {
        return createKernelError([]);
      },
      async createGeometry(input) {
        expectTypeOf(input.options).not.toBeNullable();
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

  describe('overload 1: no optionsSchema → zero-arg factory', () => {
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

  describe('overload 2: all-optional optionsSchema → optional-arg factory', () => {
    it('should return an optional-arg factory', () => {
      const factory = createKernelPlugin({
        ...staticConfig,
        optionsSchema: z.object({ debug: z.boolean().default(false), mode: z.string().default('fast') }),
      });
      expectTypeOf(factory).toBeFunction();
      expectTypeOf(factory).returns.toEqualTypeOf<KernelPlugin>();
    });

    it('should allow calling without arguments', () => {
      const factory = createKernelPlugin({
        ...staticConfig,
        optionsSchema: z.object({ debug: z.boolean().default(false) }),
      });
      const plugin = factory();
      expectTypeOf(plugin).toEqualTypeOf<KernelPlugin>();
    });

    it('should allow calling with options', () => {
      const factory = createKernelPlugin({
        ...staticConfig,
        optionsSchema: z.object({ debug: z.boolean().default(false) }),
      });
      const plugin = factory({ debug: true });
      expectTypeOf(plugin).toEqualTypeOf<KernelPlugin>();
    });

    it('should reject unknown option keys', () => {
      const factory = createKernelPlugin({
        ...staticConfig,
        optionsSchema: z.object({ debug: z.boolean().default(false) }),
      });
      // @ts-expect-error -- 'unknownKey' is not in the options type
      factory({ unknownKey: true });
    });
  });

  describe('overload 2: required optionsSchema → required-arg factory', () => {
    it('should require the options argument', () => {
      const factory = createKernelPlugin({
        ...staticConfig,
        optionsSchema: z.object({ baseUrl: z.string() }),
      });
      const plugin = factory({ baseUrl: 'wss://example.com' });
      expectTypeOf(plugin).toEqualTypeOf<KernelPlugin>();
    });

    it('should reject calling without required options', () => {
      const factory = createKernelPlugin({
        ...staticConfig,
        optionsSchema: z.object({ baseUrl: z.string() }),
      });
      // @ts-expect-error -- required options must be provided
      factory();
    });

    it('should reject missing required keys', () => {
      const factory = createKernelPlugin({
        ...staticConfig,
        optionsSchema: z.object({ baseUrl: z.string(), token: z.string() }),
      });
      // @ts-expect-error -- 'token' is missing
      factory({ baseUrl: 'wss://example.com' });
    });

    it('should reject wrong option value types', () => {
      const factory = createKernelPlugin({
        ...staticConfig,
        optionsSchema: z.object({ baseUrl: z.string() }),
      });
      // @ts-expect-error -- baseUrl must be a string, not a number
      factory({ baseUrl: 123 });
    });
  });

  describe('overload 2: mixed required and optional → required-arg factory', () => {
    it('should require options when at least one key is required', () => {
      const factory = createKernelPlugin({
        ...staticConfig,
        optionsSchema: z.object({ baseUrl: z.string(), debug: z.boolean().default(false) }),
      });
      const plugin = factory({ baseUrl: 'wss://example.com' });
      expectTypeOf(plugin).toEqualTypeOf<KernelPlugin>();
    });

    it('should reject calling without options', () => {
      const factory = createKernelPlugin({
        ...staticConfig,
        optionsSchema: z.object({ baseUrl: z.string(), debug: z.boolean().default(false) }),
      });
      // @ts-expect-error -- options are required because baseUrl is required
      factory();
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
// RuntimeClient.export() type safety (R15)
// =============================================================================

describe('RuntimeClient.export() type safety', () => {
  const stlSchema = z.object({ binary: z.boolean().default(true) });

  const factory = createKernelPlugin({
    id: 'test-kernel',
    moduleUrl: 'mock://kernel',
    extensions: ['ts'],
    exportSchemas: { stl: stlSchema },
  });

  const client = createRuntimeClient({
    kernels: [factory()],
  });

  it('should carry format map through createRuntimeClient', () => {
    // Typed overload accepts correct options
    void client.export('stl', { binary: false });
  });

  it('should NOT accept invalid option types for known formats', () => {
    // @ts-expect-error -- invalid option type
    void client.export('stl', { binary: 'yes' });
  });

  it('should NOT accept invalid formats', () => {
    // @ts-expect-error -- invalid format
    void client.export('invalid-format', { arbitrary: true });
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

// =============================================================================
// ExportGeometryInput discriminated union
// =============================================================================

describe('ExportGeometryInput discriminated union', () => {
  const stlSchema = z.object({ binary: z.boolean().default(true) });
  const stepSchema = z.object({
    assemblyMode: z.enum(['single', 'assembly']).default('single'),
  });
  const glbSchema = tessellationSchema.extend(coordinateSystemSchema.shape);

  type Schemas = { stl: typeof stlSchema; step: typeof stepSchema; glb: typeof glbSchema };
  type Input = ExportGeometryInput<Uint8Array<ArrayBuffer>, Schemas>;

  it('should produce a union of format string literals', () => {
    expectTypeOf<Input['format']>().toEqualTypeOf<'stl' | 'step' | 'glb'>();
  });

  it('should not widen format to string when schemas are declared', () => {
    expectTypeOf<Input['format']>().not.toEqualTypeOf<string>();
  });

  it('should narrow options via format discriminant', () => {
    const check = (input: Input) => {
      if (input.format === 'stl') {
        expectTypeOf(input.options).toEqualTypeOf<{ binary: boolean }>();
      }
      if (input.format === 'step') {
        expectTypeOf(input.options).toEqualTypeOf<{ assemblyMode: 'single' | 'assembly' }>();
      }
      if (input.format === 'glb') {
        expectTypeOf(input.options).toEqualTypeOf<{
          tessellation: { linearTolerance: number; angularTolerance: number };
          coordinateSystem: 'y-up' | 'z-up';
        }>();
      }
    };
    void check;
  });

  it('should carry the NativeHandle type into all union members', () => {
    expectTypeOf<Input['nativeHandle']>().toEqualTypeOf<Uint8Array<ArrayBuffer>>();
  });

  it('should fall back to FileExtension format and untyped options when no schemas declared', () => {
    type FallbackInput = ExportGeometryInput<ArrayBuffer>;
    expectTypeOf<FallbackInput['format']>().toEqualTypeOf<FileExtension>();
    expectTypeOf<FallbackInput['options']>().toEqualTypeOf<Record<string, unknown>>();
  });

  it('should narrow destructured format to never after exhaustive switch', () => {
    const check = (input: Input) => {
      const { format } = input;
      switch (format) {
        case 'stl': {
          break;
        }
        case 'step': {
          break;
        }
        case 'glb': {
          break;
        }
        default: {
          expectTypeOf(format).toEqualTypeOf<never>();
        }
      }
    };
    void check;
  });

  it('should not narrow to never when a case is missing', () => {
    const check = (input: Input) => {
      const { format } = input;
      switch (format) {
        case 'stl': {
          break;
        }
        case 'step': {
          break;
        }
        default: {
          expectTypeOf(format).toEqualTypeOf<'glb'>();
        }
      }
    };
    void check;
  });

  it('should support single-format schemas (e.g., Manifold glb-only)', () => {
    type SingleFormat = ExportGeometryInput<ArrayBuffer, { glb: typeof glbSchema }>;
    expectTypeOf<SingleFormat['format']>().toEqualTypeOf<'glb'>();
  });
});

// =============================================================================
// createKernelPlugin export schema phantom type inference
// =============================================================================

describe('createKernelPlugin export schema inference', () => {
  it('should infer FormatMap from exportSchemas Zod types', () => {
    const stlSchema = z.object({ binary: z.boolean().default(true) });
    const stepSchema = z.object({
      assemblyMode: z.enum(['single', 'assembly']).default('single'),
    });

    const factory = createKernelPlugin({
      id: 'test',
      moduleUrl: 'test.js',
      extensions: ['ts'],
      exportSchemas: { stl: stlSchema, step: stepSchema },
    });

    const plugin = factory();
    expectTypeOf(plugin).toEqualTypeOf<
      KernelPlugin<
        {
          stl: { binary?: boolean };
          step: { assemblyMode?: 'single' | 'assembly' };
        },
        Record<string, unknown>,
        'test'
      >
    >();
  });

  it('should produce empty FormatMap when no exportSchemas', () => {
    const factory = createKernelPlugin({
      id: 'test',
      moduleUrl: 'test.js',
      extensions: ['ts'],
    });

    const plugin = factory();
    // oxlint-disable-next-line @typescript-eslint/no-empty-object-type -- intentional: matches ResolveFormatMap empty case
    expectTypeOf(plugin).toEqualTypeOf<KernelPlugin<{}, Record<string, unknown>, 'test'>>();
  });

  it('should infer composed schemas (tessellation + coordinateSystem)', () => {
    const glbSchema = tessellationSchema.extend(coordinateSystemSchema.shape);

    const factory = createKernelPlugin({
      id: 'test',
      moduleUrl: 'test.js',
      extensions: ['ts'],
      exportSchemas: { glb: glbSchema },
    });

    const plugin = factory();
    expectTypeOf(plugin).toEqualTypeOf<
      KernelPlugin<
        {
          glb: {
            tessellation?: { linearTolerance?: number; angularTolerance?: number };
            coordinateSystem?: 'y-up' | 'z-up';
          };
        },
        Record<string, unknown>,
        'test'
      >
    >();
  });

  it('should infer BOTH Options AND FormatMap simultaneously via optionsSchema — zero explicit type params', () => {
    const optionsSchema = z.object({
      wasm: z.union([z.literal('single'), z.literal('custom')]).default('single'),
    });
    const stlSchema = z.object({ binary: z.boolean().default(true) });
    const stepSchema = z.object({ coordinateSystem: z.enum(['y-up', 'z-up']).default('y-up') });

    const factory = createKernelPlugin({
      id: 'test',
      moduleUrl: 'test.js',
      extensions: ['ts'],
      optionsSchema,
      exportSchemas: { stl: stlSchema, step: stepSchema },
    });

    expectTypeOf(factory).toBeCallableWith({ wasm: 'custom' });

    const plugin = factory();
    expectTypeOf(plugin).toEqualTypeOf<
      KernelPlugin<
        { stl: { binary?: boolean }; step: { coordinateSystem?: 'y-up' | 'z-up' } },
        Record<string, unknown>,
        'test'
      >
    >();
  });

  it('should NOT lose FormatMap when optionsSchema is present (fixes TS partial-inference)', () => {
    const optionsSchema = z.object({ debug: z.boolean().default(false) });
    const stlSchema = z.object({ binary: z.boolean().default(true) });

    const factory = createKernelPlugin({
      id: 'test',
      moduleUrl: 'test.js',
      extensions: ['ts'],
      optionsSchema,
      exportSchemas: { stl: stlSchema },
    });

    const plugin = factory();
    expectTypeOf(plugin).toEqualTypeOf<KernelPlugin<{ stl: { binary?: boolean } }, Record<string, unknown>, 'test'>>();
  });

  it('should make options optional when all optionsSchema fields have defaults', () => {
    const optionsSchema = z.object({ debug: z.boolean().default(false) });
    const factory = createKernelPlugin({
      id: 'test',
      moduleUrl: 'test.js',
      extensions: ['ts'],
      optionsSchema,
    });
    expectTypeOf(factory).toBeCallableWith();
    expectTypeOf(factory).toBeCallableWith({ debug: true });
  });

  it('should require options when optionsSchema has required fields', () => {
    const optionsSchema = z.object({ apiKey: z.string() });
    const factory = createKernelPlugin({
      id: 'test',
      moduleUrl: 'test.js',
      extensions: ['ts'],
      optionsSchema,
    });
    expectTypeOf(factory).parameter(0).not.toBeUndefined();
    expectTypeOf(factory).toBeCallableWith({ apiKey: 'key' });
  });

  it('should strip optionsSchema and exportSchemas from returned plugin object', () => {
    const optionsSchema = z.object({ debug: z.boolean().default(false) });
    const stlSchema = z.object({ binary: z.boolean().default(true) });

    const factory = createKernelPlugin({
      id: 'test',
      moduleUrl: 'test.js',
      extensions: ['ts'],
      optionsSchema,
      exportSchemas: { stl: stlSchema },
    });

    const plugin = factory();
    expectTypeOf(plugin).not.toHaveProperty('optionsSchema');
    expectTypeOf(plugin).not.toHaveProperty('exportSchemas');
    expectTypeOf(plugin).not.toHaveProperty('renderSchema');
  });
});

// =============================================================================
// CollectFormatMap and CollectExportFormats
// =============================================================================

describe('CollectFormatMap type inference', () => {
  it('should merge disjoint format maps from multiple plugins', () => {
    const stlSchema = z.object({ binary: z.boolean().default(true) });
    const glbSchema = tessellationSchema.extend(coordinateSystemSchema.shape);

    type PluginA = KernelPlugin<{ stl: z.infer<typeof stlSchema> }>;
    type PluginB = KernelPlugin<{ glb: z.infer<typeof glbSchema> }>;

    type Merged = CollectFormatMap<[PluginA, PluginB]>;
    expectTypeOf<Merged>().toEqualTypeOf<{
      stl: { binary: boolean };
      glb: {
        tessellation: { linearTolerance: number; angularTolerance: number };
        coordinateSystem: 'y-up' | 'z-up';
      };
    }>();
  });

  it('should intersect overlapping format options from multiple plugins', () => {
    type PluginA = KernelPlugin<{ stl: { binary: boolean } }>;
    type PluginB = KernelPlugin<{ stl: { quality: number } }>;

    type Merged = CollectFormatMap<[PluginA, PluginB]>;
    expectTypeOf<Merged>().toEqualTypeOf<{ stl: { binary: boolean } & { quality: number } }>();
  });

  it('should produce empty map from plugins without export schemas', () => {
    type Merged = CollectFormatMap<[KernelPlugin, KernelPlugin]>;
    // oxlint-disable-next-line @typescript-eslint/no-empty-object-type -- verifying empty result
    expectTypeOf<Merged>().toEqualTypeOf<{}>();
  });

  it('should drop Record<string, never> contributors from the intersection', () => {
    type PluginA = KernelPlugin<{ glb: { tessellation: { linearTolerance: number } } }>;
    type PluginB = KernelPlugin<{ glb: Record<string, never> }>;
    type Merged = CollectFormatMap<[PluginA, PluginB]>;
    expectTypeOf<Merged>().toEqualTypeOf<{ glb: { tessellation: { linearTolerance: number } } }>();
  });

  it('should fall back to unknown only when every contributor is Record<string, never>', () => {
    type PluginA = KernelPlugin<{ glb: Record<string, never> }>;
    type PluginB = KernelPlugin<{ glb: Record<string, never> }>;
    type Merged = CollectFormatMap<[PluginA, PluginB]>;
    expectTypeOf<Merged>().toEqualTypeOf<{ glb: unknown }>();
  });

  it('should drop the placeholder and intersect the remaining real schemas', () => {
    type PluginA = KernelPlugin<{ glb: { coordinateSystem: 'y-up' | 'z-up' } }>;
    type PluginB = KernelPlugin<{ glb: Record<string, never> }>;
    type PluginC = KernelPlugin<{ glb: { tessellation: { segments: number } } }>;
    type Merged = CollectFormatMap<[PluginA, PluginB, PluginC]>;
    expectTypeOf<Merged>().toEqualTypeOf<{
      glb: { coordinateSystem: 'y-up' | 'z-up' } & { tessellation: { segments: number } };
    }>();
  });
});

describe('CollectExportFormats type inference', () => {
  it('should collect format literals from plugin FormatMap keys', () => {
    type PluginA = KernelPlugin<{ stl: unknown; step: unknown }>;
    type PluginB = KernelPlugin<{ glb: unknown; gltf: unknown }>;

    type Formats = CollectExportFormats<[PluginA, PluginB]>;
    expectTypeOf<Formats>().toEqualTypeOf<'stl' | 'step' | 'glb' | 'gltf'>();
  });

  it('should deduplicate overlapping formats', () => {
    type PluginA = KernelPlugin<{ stl: unknown; glb: unknown }>;
    type PluginB = KernelPlugin<{ glb: unknown; gltf: unknown }>;

    type Formats = CollectExportFormats<[PluginA, PluginB]>;
    expectTypeOf<Formats>().toEqualTypeOf<'stl' | 'glb' | 'gltf'>();
  });

  it('should fall back to FileExtension when no exportSchemas declared', () => {
    type Formats = CollectExportFormats<[KernelPlugin]>;
    expectTypeOf<Formats>().toEqualTypeOf<FileExtension>();
  });
});

// =============================================================================
// RuntimeClient.export() expanded type safety
// =============================================================================

describe('RuntimeClient.export() expanded type safety', () => {
  const stlSchema = z.object({ binary: z.boolean().default(true) });
  const stepSchema = z.object({
    assemblyMode: z.enum(['single', 'assembly']).default('single'),
  });
  const glbSchema = tessellationSchema.extend(coordinateSystemSchema.shape);

  it('should type-check options for each declared format', () => {
    const factory = createKernelPlugin({
      id: 'k1',
      moduleUrl: 'k1.js',
      extensions: ['ts'],
      exportSchemas: { stl: stlSchema, step: stepSchema, glb: glbSchema },
    });

    const client = createRuntimeClient({ kernels: [factory()] });

    void client.export('stl', { binary: true });
    void client.export('step', { assemblyMode: 'assembly' });
    void client.export('glb', {
      tessellation: { linearTolerance: 0.05, angularTolerance: 10 },
      coordinateSystem: 'z-up',
    });
  });

  it('should NOT accept wrong option types', () => {
    const factory = createKernelPlugin({
      id: 'k1',
      moduleUrl: 'k1.js',
      extensions: ['ts'],
      exportSchemas: { stl: stlSchema },
    });

    const client = createRuntimeClient({ kernels: [factory()] });

    // @ts-expect-error -- invalid option type
    void client.export('stl', { binary: 'yes' });
  });

  it('should NOT accept undeclared formats', () => {
    const factory = createKernelPlugin({
      id: 'k1',
      moduleUrl: 'k1.js',
      extensions: ['ts'],
      exportSchemas: { stl: stlSchema },
    });

    const client = createRuntimeClient({ kernels: [factory()] });
    // @ts-expect-error -- invalid format
    void client.export('invalid-format', { anyOption: 42 });
  });

  it('should merge format maps from multiple kernel plugins', () => {
    const kernelA = createKernelPlugin({
      id: 'ka',
      moduleUrl: 'ka.js',
      extensions: ['ts'],
      exportSchemas: { stl: stlSchema },
    });

    const kernelB = createKernelPlugin({
      id: 'kb',
      moduleUrl: 'kb.js',
      extensions: ['scad'],
      exportSchemas: { glb: glbSchema },
    });

    const client = createRuntimeClient({ kernels: [kernelA(), kernelB()] });

    void client.export('stl', { binary: false });
    void client.export('glb', {
      tessellation: { linearTolerance: 0.1, angularTolerance: 15 },
      coordinateSystem: 'y-up',
    });
    // @ts-expect-error -- invalid format
    void client.export('invalid-format', { arbitrary: true });
  });

  it('should allow calling export without options for declared formats', () => {
    const factory = createKernelPlugin({
      id: 'k1',
      moduleUrl: 'k1.js',
      extensions: ['ts'],
      exportSchemas: { stl: stlSchema },
    });

    const client = createRuntimeClient({ kernels: [factory()] });
    void client.export('stl');
  });

  it('should project the kernel FormatMap onto RuntimeClient via the Kernels bag', () => {
    /* oxlint-disable @typescript-eslint/no-empty-object-type -- matches plugin defaults */
    type MyKernel = KernelPlugin<{ stl: { binary: boolean }; step: { assemblyMode: 'single' | 'assembly' } }>;
    type MyClient = RuntimeClient<readonly [MyKernel]>;
    /* oxlint-enable @typescript-eslint/no-empty-object-type */

    const check = (client: MyClient) => {
      void client.export('stl', { binary: true });
      void client.export('step', { assemblyMode: 'assembly' });
    };
    void check;
  });
});

// =============================================================================
// Exhaustive switch on format (kernel-like patterns)
// =============================================================================

describe('exhaustive switch on format', () => {
  it('should narrow format to never when all declared cases are covered', () => {
    const stlSchema = z.object({ binary: z.boolean().default(true) });
    const glbSchema = tessellationSchema.extend(coordinateSystemSchema.shape);

    defineKernel({
      name: 'ExhaustiveTest',
      version: '1.0.0',
      exportSchemas: { stl: stlSchema, glb: glbSchema },
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
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry(input) {
        const { format } = input;
        switch (format) {
          case 'stl': {
            break;
          }
          case 'glb': {
            break;
          }
          default: {
            expectTypeOf(format).toEqualTypeOf<never>();
          }
        }
        return createKernelError([]);
      },
    });
  });

  it('should narrow to remaining formats when some cases are missing', () => {
    const stlSchema = z.object({ binary: z.boolean().default(true) });
    const stepSchema = z.object({
      assemblyMode: z.enum(['single', 'assembly']).default('single'),
    });
    const glbSchema = tessellationSchema.extend(coordinateSystemSchema.shape);

    defineKernel({
      name: 'PartialTest',
      version: '1.0.0',
      exportSchemas: { stl: stlSchema, step: stepSchema, glb: glbSchema },
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
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry(input) {
        const { format } = input;
        switch (format) {
          case 'stl': {
            break;
          }
          default: {
            expectTypeOf(format).toEqualTypeOf<'step' | 'glb'>();
          }
        }
        return createKernelError([]);
      },
    });
  });

  it('should narrow single-format kernel to never after the one case', () => {
    const glbSchema = z.object({});

    defineKernel({
      name: 'SingleFormatTest',
      version: '1.0.0',
      exportSchemas: { glb: glbSchema },
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
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry(input) {
        const { format } = input;
        switch (format) {
          // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- verifying single-literal exhaustive switch
          case 'glb': {
            break;
          }
          default: {
            expectTypeOf(format).toEqualTypeOf<never>();
          }
        }
        return createKernelError([]);
      },
    });
  });

  it('should narrow format to never with fall-through cases (glb + gltf)', () => {
    const glbSchema = tessellationSchema.extend(coordinateSystemSchema.shape);

    defineKernel({
      name: 'FallThroughTest',
      version: '1.0.0',
      exportSchemas: { glb: glbSchema, gltf: glbSchema },
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
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry(input) {
        const { format } = input;
        switch (format) {
          case 'glb': {
            break;
          }
          case 'gltf': {
            break;
          }
          default: {
            expectTypeOf(format).toEqualTypeOf<never>();
          }
        }
        return createKernelError([]);
      },
    });
  });

  it('should preserve options type narrowing within switch cases using input.format', () => {
    const stlSchema = z.object({ binary: z.boolean().default(true) });
    const stepSchema = z.object({
      assemblyMode: z.enum(['single', 'assembly']).default('single'),
    });

    defineKernel({
      name: 'NarrowingTest',
      version: '1.0.0',
      exportSchemas: { stl: stlSchema, step: stepSchema },
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
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry(input) {
        if (input.format === 'stl') {
          expectTypeOf(input.options).toEqualTypeOf<{ binary: boolean }>();
        }
        if (input.format === 'step') {
          expectTypeOf(input.options).toEqualTypeOf<{ assemblyMode: 'single' | 'assembly' }>();
        }
        return createKernelError([]);
      },
    });
  });
});

// =============================================================================
// ExportGeometryInput switch-based options narrowing
// =============================================================================

describe('ExportGeometryInput switch-based options narrowing', () => {
  const stlSchema = z.object({ binary: z.boolean().default(true) });
  const stepSchema = z.object({
    assemblyMode: z.enum(['single', 'assembly']).default('single'),
  });
  const glbSchema = tessellationSchema.extend(coordinateSystemSchema.shape);

  it('should narrow input.options when switching on input.format', () => {
    defineKernel({
      name: 'SwitchNarrow',
      version: '1.0.0',
      exportSchemas: { stl: stlSchema, step: stepSchema, glb: glbSchema },
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
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry(input) {
        switch (input.format) {
          case 'stl': {
            expectTypeOf(input.options).toEqualTypeOf<{ binary: boolean }>();
            break;
          }
          case 'step': {
            expectTypeOf(input.options).toEqualTypeOf<{ assemblyMode: 'single' | 'assembly' }>();
            break;
          }
          case 'glb': {
            expectTypeOf(input.options).toEqualTypeOf<{
              tessellation: { linearTolerance: number; angularTolerance: number };
              coordinateSystem: 'y-up' | 'z-up';
            }>();
            break;
          }
        }
        return createKernelError([]);
      },
    });
  });

  it('should narrow input.format to never in default case for exhaustive switch', () => {
    type Schemas = { stl: typeof stlSchema; step: typeof stepSchema };
    type Input = ExportGeometryInput<unknown, Schemas>;

    const check = (input: Input) => {
      switch (input.format) {
        case 'stl': {
          break;
        }
        case 'step': {
          break;
        }
        default: {
          expectTypeOf(input).toEqualTypeOf<never>();
        }
      }
    };
    void check;
  });

  it('should NOT narrow options when format and options are destructured before switch', () => {
    type Schemas = { stl: typeof stlSchema; step: typeof stepSchema };
    type Input = ExportGeometryInput<unknown, Schemas>;

    const check = (input: Input) => {
      const { options } = input;
      expectTypeOf(options).toEqualTypeOf<{ binary: boolean } | { assemblyMode: 'single' | 'assembly' }>();
    };
    void check;
  });
});

// =============================================================================
// serializeHandle / deserializeHandle type inference
// =============================================================================

describe('serializeHandle / deserializeHandle type inference', () => {
  it('should infer NativeHandle from createGeometry return and auto-type serializeHandle param', () => {
    defineKernel({
      name: 'SerializeInference',
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
      serializeHandle(nativeHandle) {
        expectTypeOf(nativeHandle).toEqualTypeOf<{
          meshData: Float32Array<ArrayBuffer>;
          id: string;
        }>();
        return { encoded: JSON.stringify(nativeHandle) };
      },
      async exportGeometry() {
        return createKernelError([]);
      },
    });
  });

  it('should auto-type nativeHandle param for array NativeHandle types', () => {
    defineKernel({
      name: 'ArraySerialize',
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
        const shape: Record<string, unknown> = {};
        return {
          geometry: [],
          nativeHandle: [{ shape, name: 'part' }],
        };
      },
      serializeHandle(nativeHandle) {
        expectTypeOf(nativeHandle).toEqualTypeOf<Array<{ shape: Record<string, unknown>; name: string }>>();
        return nativeHandle.map((entry) => ({ serialized: true, name: entry.name }));
      },
      async exportGeometry() {
        return createKernelError([]);
      },
    });
  });

  it('should infer SerializedHandle from serializeHandle return and auto-type deserializeHandle data param', () => {
    defineKernel({
      name: 'DeserializeInference',
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
      serializeHandle(nativeHandle) {
        return { encoded: JSON.stringify(nativeHandle), meta: { count: 1 as number } };
      },
      deserializeHandle(data) {
        expectTypeOf(data).toEqualTypeOf<{ encoded: string; meta: { count: number } }>();
        return { meshData: new Float32Array(0), id: data.encoded };
      },
      async exportGeometry() {
        return createKernelError([]);
      },
    });
  });

  it('should validate deserializeHandle return type matches NativeHandle', () => {
    defineKernel({
      name: 'ReturnValidation',
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
      serializeHandle() {
        return { encoded: 'brep-data' };
      },
      deserializeHandle(data) {
        return { meshData: new Float32Array(JSON.parse(data.encoded) as ArrayLike<number>), id: 'restored' };
      },
      async exportGeometry() {
        return createKernelError([]);
      },
    });
  });

  it('should NOT compile when deserializeHandle return type does not match NativeHandle', () => {
    defineKernel({
      name: 'DeserializeReturnTypeValidation',
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
      serializeHandle() {
        return { encoded: 'brep-data' };
      },
      // @ts-expect-error -- invalid return type - should be { meshData: Float32Array<ArrayBuffer>; id: string; }
      deserializeHandle(data) {
        return data.encoded;
      },
      async exportGeometry() {
        return createKernelError([]);
      },
    });
  });

  it('should thread Context type to serializeHandle and deserializeHandle', () => {
    defineKernel({
      name: 'ContextThreading',
      version: '1.0.0',
      async initialize() {
        const decoder: Record<string, unknown> = {};
        return { decoder, version: 2 as number };
      },
      async getDependencies() {
        return { resolved: [], unresolved: [] };
      },
      async getParameters() {
        return createKernelError([]);
      },
      async createGeometry() {
        return { geometry: [], nativeHandle: 'handle-data' as string };
      },
      serializeHandle(_nativeHandle, context) {
        expectTypeOf(context).toEqualTypeOf<{ decoder: Record<string, unknown>; version: number }>();
        return { data: 'serialized' };
      },
      deserializeHandle(_data, context) {
        expectTypeOf(context).toEqualTypeOf<{ decoder: Record<string, unknown>; version: number }>();
        return 'restored-handle';
      },
      async exportGeometry() {
        return createKernelError([]);
      },
    });
  });

  it('should compile when both hooks are omitted', () => {
    defineKernel({
      name: 'NoHooks',
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
          nativeHandle: { meshData: new Float32Array(0), id: 'test' },
        };
      },
      async exportGeometry() {
        return createKernelError([]);
      },
    });
  });

  it('should compile when only serializeHandle is provided', () => {
    defineKernel({
      name: 'SerializeOnly',
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
        return { geometry: [], nativeHandle: 'some-data' as string };
      },
      serializeHandle(nativeHandle) {
        return { data: nativeHandle };
      },
      async exportGeometry() {
        return createKernelError([]);
      },
    });
  });

  it('should compile when only deserializeHandle is provided', () => {
    defineKernel({
      name: 'DeserializeOnly',
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
        return { geometry: [], nativeHandle: 'some-data' as string };
      },
      deserializeHandle(data) {
        return data as string;
      },
      async exportGeometry() {
        return createKernelError([]);
      },
    });
  });

  it('should allow KernelDefinition with SerializedHandle to extend KernelDefinition with default generics', () => {
    type ConcreteKernel = KernelDefinition<{ ctx: boolean }, { handle: string }, { serialized: string }>;
    expectTypeOf<ConcreteKernel>().toExtend<KernelDefinition>();
  });

  it('should allow KernelDefinition without SerializedHandle to extend KernelDefinition with default generics', () => {
    type SimpleKernel = KernelDefinition<{ ctx: boolean }, { handle: string }>;
    expectTypeOf<SimpleKernel>().toExtend<KernelDefinition>();
  });
});

// =============================================================================
// KernelPlugin render options phantom type (R3)
// =============================================================================

describe('KernelPlugin render options phantom', () => {
  it('should carry both FormatMap and RenderOptions phantom types', () => {
    type TestPlugin = KernelPlugin<{ stl: { binary: boolean } }, { tessellation: { linearTolerance: number } }>;
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- variance: test assignability to any plugin
    expectTypeOf<TestPlugin>().toExtend<KernelPlugin<any, any>>();
  });

  it('should default RenderOptions to Record<string, unknown> when omitted', () => {
    type DefaultPlugin = KernelPlugin<{ stl: { binary: boolean } }>;
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- variance: test assignability
    expectTypeOf<DefaultPlugin>().toExtend<KernelPlugin<any>>();
  });

  it('should default both generics when omitted', () => {
    type BarePlugin = KernelPlugin;
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- variance: test assignability to any plugin
    expectTypeOf<BarePlugin>().toExtend<KernelPlugin<any, any>>();
  });
});

// =============================================================================
// CollectRenderOptions type inference (R3)
// =============================================================================

describe('CollectRenderOptions type inference', () => {
  it('should extract render options from a single kernel plugin', () => {
    type Plugins = [KernelPlugin<Record<string, unknown>, { tessellation: { linearTolerance: number } }>];
    type RenderOptions = CollectRenderOptions<Plugins>;
    expectTypeOf<RenderOptions>().toEqualTypeOf<{ tessellation: { linearTolerance: number } }>();
  });

  it('should produce union of render options from multiple kernels', () => {
    type PluginA = KernelPlugin<Record<string, unknown>, { tessellation: { linearTolerance: number } }>;
    type PluginB = KernelPlugin<Record<string, unknown>, { segments: number }>;
    type RenderOptions = CollectRenderOptions<[PluginA, PluginB]>;
    expectTypeOf<{ tessellation: { linearTolerance: number } }>().toExtend<RenderOptions>();
    expectTypeOf<{ segments: number }>().toExtend<RenderOptions>();
  });

  it('should default to Record<string, unknown> when no renderSchema declared', () => {
    type RenderOptions = CollectRenderOptions<[KernelPlugin, KernelPlugin]>;
    expectTypeOf<RenderOptions>().toEqualTypeOf<Record<string, unknown>>();
  });

  it('should drop the Record<string, unknown> default phantom when at least one kernel declares a concrete renderSchema', () => {
    type PluginA = KernelPlugin<Record<string, unknown>, { tessellation: { linearTolerance: number } }>;
    type PluginB = KernelPlugin;
    type RenderOptions = CollectRenderOptions<[PluginA, PluginB]>;
    expectTypeOf<RenderOptions>().toEqualTypeOf<{ tessellation: { linearTolerance: number } }>();
  });
});

// =============================================================================
// createKernelPlugin renderSchema inference (R3)
// =============================================================================

describe('createKernelPlugin renderSchema inference', () => {
  const staticConfig = { id: 'test', moduleUrl: 'test.js', extensions: ['ts'] };

  it('should infer RenderOptions from renderSchema', () => {
    const renderSchema = z.object({ tessellation: z.object({ linearTolerance: z.number() }) });
    const factory = createKernelPlugin({ ...staticConfig, renderSchema });
    const plugin = factory();
    // oxlint-disable-next-line typescript/no-empty-object-type -- empty object type is valid for this test
    expectTypeOf(plugin).toEqualTypeOf<KernelPlugin<{}, { tessellation: { linearTolerance: number } }>>();
  });

  it('should infer both FormatMap and RenderOptions simultaneously', () => {
    const renderSchema = z.object({ tessellation: z.object({ linearTolerance: z.number() }) });
    const stlSchema = z.object({ binary: z.boolean().default(true) });
    const factory = createKernelPlugin({
      ...staticConfig,
      renderSchema,
      exportSchemas: { stl: stlSchema },
    });
    const plugin = factory();
    expectTypeOf(plugin).toEqualTypeOf<
      KernelPlugin<{ stl: { binary?: boolean } }, { tessellation: { linearTolerance: number } }>
    >();
  });

  it('should infer all three: Options, FormatMap, and RenderOptions via optionsSchema', () => {
    const renderSchema = z.object({ segments: z.number() });
    const stlSchema = z.object({ binary: z.boolean().default(true) });
    const optionsSchema = z.object({ debug: z.boolean().default(false) });
    const factory = createKernelPlugin({
      ...staticConfig,
      optionsSchema,
      renderSchema,
      exportSchemas: { stl: stlSchema },
    });
    expectTypeOf(factory).toBeCallableWith({ debug: true });
    const plugin = factory();
    expectTypeOf(plugin).toEqualTypeOf<KernelPlugin<{ stl: { binary?: boolean } }, { segments: number }>>();
  });

  it('should default RenderOptions to Record<string, unknown> when no renderSchema', () => {
    const factory = createKernelPlugin(staticConfig);
    const plugin = factory();
    expectTypeOf(plugin).toEqualTypeOf<KernelPlugin>();
  });
});

// =============================================================================
// TranscoderPlugin edge phantom type (R9)
// =============================================================================

describe('TranscoderPlugin edge phantom type', () => {
  it('should carry EdgeMap phantom type', () => {
    type TestTranscoder = TranscoderPlugin<{ usdz: { quality: number } }>;
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- variance: test assignability
    expectTypeOf<TestTranscoder>().toExtend<TranscoderPlugin<any, any>>();
  });

  it('should default EdgeMap to empty when omitted', () => {
    type BareTranscoder = TranscoderPlugin;
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- variance: test assignability
    expectTypeOf<BareTranscoder>().toExtend<TranscoderPlugin<any, any>>();
  });

  it('should carry From phantom type', () => {
    type WithFrom = TranscoderPlugin<{ usdz: { quality: number } }, 'glb'>;
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- variance: test assignability
    expectTypeOf<WithFrom>().toExtend<TranscoderPlugin<any, any>>();
  });

  it('should default From to string when omitted', () => {
    type WithoutFrom = TranscoderPlugin<{ usdz: { quality: number } }>;
    expectTypeOf<WithoutFrom>().toExtend<TranscoderPlugin<{ usdz: { quality: number } }>>();
  });
});

// =============================================================================
// CollectTranscodeMap type inference (R9)
// =============================================================================

describe('CollectTranscodeMap type inference', () => {
  it('should extract edge map from a single transcoder plugin', () => {
    type Transcoders = [TranscoderPlugin<{ usdz: { quality: number } }>];
    type EdgeMap = CollectTranscodeMap<Transcoders>;
    expectTypeOf<EdgeMap>().toEqualTypeOf<{ usdz: { quality: number } }>();
  });

  it('should merge edge maps from multiple transcoders', () => {
    type T1 = TranscoderPlugin<{ usdz: { quality: number } }>;
    // eslint-disable-next-line id-denylist -- `obj` is a valid extension
    type T2 = TranscoderPlugin<{ obj: { normals: boolean } }>;
    type EdgeMap = CollectTranscodeMap<[T1, T2]>;
    // eslint-disable-next-line id-denylist -- `obj` is a valid extension
    expectTypeOf<EdgeMap>().toEqualTypeOf<{ usdz: { quality: number }; obj: { normals: boolean } }>();
  });

  it('should produce empty map from transcoders without edge schemas', () => {
    type EdgeMap = CollectTranscodeMap<[TranscoderPlugin, TranscoderPlugin]>;
    // oxlint-disable-next-line @typescript-eslint/no-empty-object-type -- verifying empty result
    expectTypeOf<EdgeMap>().toEqualTypeOf<{}>();
  });
});

// =============================================================================
// MergeExportMap source-format merging
// =============================================================================

describe('MergeExportMap source-format merging', () => {
  type GlbOptions = { tessellation: { linearTolerance: number }; coordinateSystem: string };

  it('should merge source-format options into transcoded target', () => {
    type Result = MergeExportMap<{ glb: GlbOptions }, [TranscoderPlugin<{ usdz: { quality: number } }, 'glb'>]>;
    expectTypeOf<Result['usdz']>().toEqualTypeOf<GlbOptions & { quality: number }>();
  });

  it('should preserve kernel-native formats unchanged', () => {
    type Result = MergeExportMap<{ glb: GlbOptions }, [TranscoderPlugin<{ usdz: { quality: number } }, 'glb'>]>;
    expectTypeOf<Result['glb']>().toEqualTypeOf<GlbOptions>();
  });

  it('should produce edge-only options when From is string (no from declared)', () => {
    type Result = MergeExportMap<{ glb: GlbOptions }, [TranscoderPlugin<{ usdz: { quality: number } }>]>;
    expectTypeOf<Result['usdz']>().toEqualTypeOf<{ quality: number }>();
  });

  it('should produce edge-only options when From does not match any kernel format', () => {
    type Result = MergeExportMap<{ step: { mode: string } }, [TranscoderPlugin<{ usdz: { quality: number } }, 'glb'>]>;
    expectTypeOf<Result['usdz']>().toEqualTypeOf<{ quality: number }>();
  });

  it('should handle empty transcoder tuple', () => {
    type Result = MergeExportMap<{ glb: GlbOptions }, never[]>;
    expectTypeOf<Result>().toEqualTypeOf<{ glb: GlbOptions }>();
  });

  it('should merge across multiple transcoders', () => {
    type Result = MergeExportMap<
      { glb: GlbOptions },
      [
        TranscoderPlugin<{ usdz: { quality: number } }, 'glb'>,
        // eslint-disable-next-line id-denylist -- `obj` is a valid extension
        TranscoderPlugin<{ obj: { normals: boolean } }, 'glb'>,
      ]
    >;
    expectTypeOf<Result['usdz']>().toEqualTypeOf<GlbOptions & { quality: number }>();

    expectTypeOf<Result['obj']>().toEqualTypeOf<GlbOptions & { normals: boolean }>();
    expectTypeOf<Result['glb']>().toEqualTypeOf<GlbOptions>();
  });
});

// =============================================================================
// createTranscoderPlugin edge schema inference (R9)
// =============================================================================

describe('createTranscoderPlugin edge schema inference', () => {
  const staticConfig = { id: 'test', moduleUrl: 'test.js' };

  it('should infer EdgeMap from edges Zod schemas', () => {
    const factory = createTranscoderPlugin({
      ...staticConfig,
      edges: { usdz: z.object({ quality: z.number().default(0.8) }) },
    });
    const plugin = factory();
    expectTypeOf(plugin).toEqualTypeOf<TranscoderPlugin<{ usdz: { quality?: number } }>>();
  });

  it('should produce empty EdgeMap when no edges declared', () => {
    const factory = createTranscoderPlugin(staticConfig);
    const plugin = factory();
    expectTypeOf(plugin).toEqualTypeOf<TranscoderPlugin>();
  });

  it('should strip edges from returned plugin object', () => {
    const factory = createTranscoderPlugin({
      ...staticConfig,
      edges: { usdz: z.object({ quality: z.number() }) },
    });
    const plugin = factory();
    expectTypeOf(plugin).not.toHaveProperty('edges');
  });
});

// =============================================================================
// createTranscoderPlugin from inference
// =============================================================================

describe('createTranscoderPlugin from inference', () => {
  const staticConfig = { id: 'test', moduleUrl: 'test.js' };

  it('should infer From literal from config', () => {
    const factory = createTranscoderPlugin({
      ...staticConfig,
      from: 'glb',
      edges: { usdz: z.object({ quality: z.number().default(0.8) }) },
    });
    const plugin = factory();
    expectTypeOf(plugin).toEqualTypeOf<TranscoderPlugin<{ usdz: { quality?: number } }, 'glb'>>();
  });

  it('should default From to string when no from declared', () => {
    const factory = createTranscoderPlugin({
      ...staticConfig,
      edges: { usdz: z.object({ quality: z.number() }) },
    });
    const plugin = factory();
    expectTypeOf(plugin).toEqualTypeOf<TranscoderPlugin<{ usdz: { quality: number } }>>();
  });

  it('should strip from from returned plugin object', () => {
    const factory = createTranscoderPlugin({
      ...staticConfig,
      from: 'glb',
      edges: { usdz: z.object({ quality: z.number() }) },
    });
    const plugin = factory();
    expectTypeOf(plugin).not.toHaveProperty('from');
  });

  it('should infer From without edges', () => {
    const factory = createTranscoderPlugin({
      ...staticConfig,
      from: 'glb',
    });
    const plugin = factory();
    // oxlint-disable-next-line @typescript-eslint/no-empty-object-type -- verifying empty EdgeMap with From
    expectTypeOf(plugin).toEqualTypeOf<TranscoderPlugin<{}, 'glb'>>();
  });
});

// =============================================================================
// E2E: createRuntimeClient — kernels only (Task 5b, Section 1)
// =============================================================================

describe('createRuntimeClient — kernels only', () => {
  const stlSchema = z.object({ binary: z.boolean().default(true) });
  const stepSchema = z.object({ assemblyMode: z.enum(['single', 'assembly']).default('single') });
  const glbSchema = z.object({ quality: z.number().default(0.8) });
  const tessSchema = z.object({ tessellation: z.object({ linearTolerance: z.number() }) });

  const k1 = createKernelPlugin({
    id: 'k1',
    moduleUrl: 'k1.js',
    extensions: ['ts'],
    exportSchemas: { stl: stlSchema, step: stepSchema },
    renderSchema: tessSchema,
  });

  const k2 = createKernelPlugin({
    id: 'k2',
    moduleUrl: 'k2.js',
    extensions: ['scad'],
    exportSchemas: { glb: glbSchema },
    renderSchema: z.object({ segments: z.number() }),
  });

  const k3 = createKernelPlugin({
    id: 'k3',
    moduleUrl: 'k3.js',
    extensions: ['jscad'],
  });

  it('should infer export format map from a single kernel plugin', () => {
    const client = createRuntimeClient({ kernels: [k1()] });
    void client.export('stl', { binary: true });
    void client.export('step', { assemblyMode: 'assembly' });
    // @ts-expect-error -- invalid format
    void client.export('glb', { quality: 0.5 });
  });

  it('should merge export format maps from multiple kernel plugins', () => {
    const client = createRuntimeClient({ kernels: [k1(), k2()] });
    void client.export('stl', { binary: true });
    void client.export('step', { assemblyMode: 'assembly' });
    void client.export('glb', { quality: 0.5 });
    // @ts-expect-error -- undeclared format
    void client.export('usdz');
  });

  it('should infer render options from single kernel renderSchema', () => {
    const client = createRuntimeClient({ kernels: [k1()] });
    void client.render({
      code: { 'main.ts': 'const x = 1;' },
      options: { tessellation: { linearTolerance: 0.1 } },
    });
  });

  it('should union render options from multiple kernels', () => {
    const client = createRuntimeClient({ kernels: [k1(), k2()] });
    void client.render({
      code: { 'main.ts': 'const x = 1;' },
      options: { tessellation: { linearTolerance: 0.1 } },
    });
    void client.render({
      code: { 'main.scad': 'cube(1);' },
      options: { segments: 32 },
    });
  });

  it('should allow export without options (defaults applied by worker)', () => {
    const client = createRuntimeClient({ kernels: [k1()] });
    void client.export('stl');
  });

  it('should reject undeclared export formats', () => {
    const client = createRuntimeClient({ kernels: [k1()] });
    // @ts-expect-error -- undeclared format
    void client.export('usdz');
  });

  it('should accept self-rendering export when kernels have no exportSchemas', () => {
    const client = createRuntimeClient({ kernels: [k3()] });
    void client.export('stl' as FileExtension, { file: 'main.ts' });
  });

  it('should allow export with empty options when schema fields have defaults (z.input)', () => {
    const client = createRuntimeClient({ kernels: [k1(), k2()] });
    void client.export('stl', {});
    void client.export('step', {});
    void client.export('glb', {});
  });

  it('should allow export with partial options when schema fields have defaults (z.input)', () => {
    const client = createRuntimeClient({ kernels: [k1(), k2()] });
    void client.export('stl', { binary: false });
    void client.export('step', {});
    void client.export('glb', {});
  });
});

// =============================================================================
// E2E: createRuntimeClient — kernels + transcoders (Task 5b, Section 2)
// =============================================================================

describe('createRuntimeClient — kernels + transcoders', () => {
  const glbSchema = z.object({
    tessellation: z
      .object({
        linearTolerance: z.number().default(0.01),
      })
      .default({ linearTolerance: 0.01 }),
  });

  const k1 = createKernelPlugin({
    id: 'k1',
    moduleUrl: 'k1.js',
    extensions: ['ts'],
    exportSchemas: { glb: glbSchema },
  });

  const t1 = createTranscoderPlugin({
    id: 't1',
    moduleUrl: 't1.js',
    from: 'glb',
    edges: { usdz: z.object({ quality: z.number().default(0.8) }) },
  });

  const t2 = createTranscoderPlugin({
    id: 't2',
    moduleUrl: 't2.js',
    from: 'glb',
    // eslint-disable-next-line id-denylist -- `obj` is a valid extension
    edges: { obj: z.object({ normals: z.boolean().default(true) }) },
  });

  const t3 = createTranscoderPlugin({
    id: 't3',
    moduleUrl: 't3.js',
  });

  it('should include transcoder edge formats in export map with merged source options', () => {
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [t1()] });
    void client.export('usdz', { quality: 0.5 });
    void client.export('usdz', { quality: 0.5, tessellation: { linearTolerance: 0.01 } });
  });

  it('should preserve kernel-native formats alongside transcoded formats', () => {
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [t1()] });
    void client.export('glb', { tessellation: { linearTolerance: 0.1 } });
    void client.export('usdz', { quality: 0.5 });
  });

  it('should support kernel-native format options alongside transcoded format options', () => {
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [t1()] });
    void client.export('usdz', {
      quality: 0.5,
      tessellation: { linearTolerance: 0.1 },
    });
  });

  it('should reject invalid transcoder edge options', () => {
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [t1()] });
    // @ts-expect-error -- wrong option type for usdz
    void client.export('usdz', { quality: 'high' });
  });

  it('should handle transcoder with no edge options (empty merge)', () => {
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [t3()] });
    void client.export('glb', { tessellation: { linearTolerance: 0.1 } });
  });

  it('should handle multiple transcoders with merged source options', () => {
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [t1(), t2()] });
    void client.export('usdz', { quality: 0.5, tessellation: { linearTolerance: 0.1 } });

    void client.export('obj', { normals: true, tessellation: { linearTolerance: 0.1 } });
    void client.export('glb', { tessellation: { linearTolerance: 0.1 } });
  });
});

// =============================================================================
// E2E: createRuntimeClient — source-format merging
// =============================================================================

describe('createRuntimeClient — source-format merging', () => {
  const glbSchema = z.object({
    tessellation: z
      .object({
        linearTolerance: z.number().default(0.01),
      })
      .default({ linearTolerance: 0.01 }),
  });

  const k1 = createKernelPlugin({
    id: 'k1',
    moduleUrl: 'k1.js',
    extensions: ['ts'],
    exportSchemas: { glb: glbSchema },
  });

  const t1 = createTranscoderPlugin({
    id: 't1',
    moduleUrl: 't1.js',
    from: 'glb',
    edges: { usdz: z.object({ quality: z.number().default(0.8) }) },
  });

  const tNoFrom = createTranscoderPlugin({
    id: 't-no-from',
    moduleUrl: 't-no-from.js',
    edges: { fbx: z.object({ ascii: z.boolean().default(false) }) },
  });

  it('should merge kernel source-format options into transcoded export', () => {
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [t1()] });
    void client.export('usdz', {
      quality: 0.5,
      tessellation: { linearTolerance: 0.1 },
    });
  });

  it('should allow transcoded export with only edge options (source opts have defaults)', () => {
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [t1()] });
    void client.export('usdz', { quality: 0.5 });
  });

  it('should allow transcoded export with only source-format options', () => {
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [t1()] });
    void client.export('usdz', { tessellation: { linearTolerance: 0.1 } });
  });

  it('should reject invalid source-format options on transcoded export', () => {
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [t1()] });
    // @ts-expect-error -- tessellation must be an object, not a string
    void client.export('usdz', { quality: 0.5, tessellation: 'invalid' });
  });

  it('should reject invalid edge options on transcoded export', () => {
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [t1()] });
    // @ts-expect-error -- quality must be a number
    void client.export('usdz', { quality: 'high' });
  });

  it('should not merge source-format options when transcoder lacks from', () => {
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [tNoFrom()] });
    void client.export('fbx', { ascii: true });
  });

  it('should merge source options across multiple transcoders', () => {
    const t2 = createTranscoderPlugin({
      id: 't2',
      moduleUrl: 't2.js',
      from: 'glb',
      // eslint-disable-next-line id-denylist -- `obj` is a valid extension
      edges: { obj: z.object({ normals: z.boolean().default(true) }) },
    });
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [t1(), t2()] });
    void client.export('usdz', { quality: 0.5, tessellation: { linearTolerance: 0.1 } });

    void client.export('obj', { normals: true, tessellation: { linearTolerance: 0.1 } });
  });

  it('should keep kernel-native formats unaffected by transcoders', () => {
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [t1()] });
    void client.export('glb', { tessellation: { linearTolerance: 0.1 } });
  });

  it('should allow kernel-native export with empty options (z.input defaults are optional)', () => {
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [t1()] });
    void client.export('glb', {});
  });

  it('should allow transcoded export with empty options when both sides have defaults', () => {
    const client = createRuntimeClient({ kernels: [k1()], transcoders: [t1()] });
    void client.export('usdz', {});
  });
});

// =============================================================================
// E2E: createRuntimeClientOptions — generic preservation (Task 5b, Section 3)
// =============================================================================

describe('createRuntimeClientOptions — generic preservation', () => {
  const stlSchema = z.object({ binary: z.boolean().default(true) });

  const k1 = createKernelPlugin({
    id: 'k1',
    moduleUrl: 'k1.js',
    extensions: ['ts'],
    exportSchemas: { stl: stlSchema },
  });

  const t1 = createTranscoderPlugin({
    id: 't1',
    moduleUrl: 't1.js',
    from: 'stl',
    edges: { usdz: z.object({ quality: z.number() }) },
  });

  it('should preserve kernel tuple types through identity call', () => {
    const options = createRuntimeClientOptions({ kernels: [k1()] });
    const client = createRuntimeClient(options);
    void client.export('stl', { binary: true });
    // @ts-expect-error -- undeclared format
    void client.export('invalid');
  });

  it('should preserve kernel + transcoder tuple types through identity call', () => {
    const options = createRuntimeClientOptions({ kernels: [k1()], transcoders: [t1()] });
    const client = createRuntimeClient(options);
    void client.export('stl', { binary: true });
    void client.export('usdz', { quality: 0.5 });
  });

  it('should produce typed client from full options pipeline', () => {
    const options = createRuntimeClientOptions({ kernels: [k1()], transcoders: [t1()] });
    const client = createRuntimeClient(options);
    void client.export('stl', { binary: false });
    void client.export('usdz', { quality: 0.9 });
    // @ts-expect-error -- undeclared format
    void client.export('step');
  });

  it('should preserve source-merged types through identity call', () => {
    const options = createRuntimeClientOptions({ kernels: [k1()], transcoders: [t1()] });
    const client = createRuntimeClient(options);
    void client.export('usdz', { quality: 0.5, binary: true });
  });
});

// =============================================================================
// E2E: RuntimeClient erasure boundaries (Task 5b, Section 5 / R2)
// =============================================================================

describe('RuntimeClient erasure boundaries (R2)', () => {
  it('should compile with explicit wide-default erasure annotation', () => {
    // oxlint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- intentional: documents the wide-default erasure form per R6
    const check = (_client: RuntimeClient<KernelPlugin[], TranscoderPlugin[]>) => {};
    void check;
  });

  it('should allow any FileExtension on the erased client', () => {
    // oxlint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- intentional: documents the wide-default erasure form per R6
    const check = (client: RuntimeClient<KernelPlugin[], TranscoderPlugin[]>) => {
      void client.export('anything' as FileExtension);
    };
    void check;
  });
});

// =============================================================================
// defineTranscoder type inference (R1, R3, R4, R5, R7)
// =============================================================================

describe('defineTranscoder type inference', () => {
  const threeMfSchema = z.object({
    unit: z.enum(['micron', 'millimeter', 'centimeter']).default('millimeter'),
    application: z.string().optional(),
  });

  it('should infer literal from/to types from edges and narrow input.from/input.to (R3, R4)', () => {
    const transcoder = defineTranscoder({
      name: 'TestTranscoder',
      version: '1.0.0',
      edges: [
        { from: 'glb', to: 'usdz', fidelity: 'mesh' },
        { from: 'glb', to: 'stl', fidelity: 'mesh' },
      ] as const,
      async initialize() {
        return {};
      },
      async transcode(input) {
        expectTypeOf(input.from).toEqualTypeOf<'glb'>();
        expectTypeOf(input.to).toEqualTypeOf<'usdz' | 'stl'>();
        return { success: true, data: input.files, issues: [] };
      },
      async cleanup() {},
    });
    expectTypeOf(transcoder.edges).toEqualTypeOf<
      readonly [
        { readonly from: 'glb'; readonly to: 'usdz'; readonly fidelity: 'mesh' },
        { readonly from: 'glb'; readonly to: 'stl'; readonly fidelity: 'mesh' },
      ]
    >();
  });

  it('should narrow input.options to z.input<optionsSchema> when discriminating on input.to (R5)', () => {
    defineTranscoder({
      name: 'TestTranscoder',
      version: '1.0.0',
      edges: [
        { from: 'glb', to: '3mf', fidelity: 'mesh', optionsSchema: threeMfSchema },
        { from: 'glb', to: 'stl', fidelity: 'mesh' },
      ] as const,
      async initialize() {
        return {};
      },
      async transcode(input) {
        if (input.to === '3mf') {
          expectTypeOf(input.options).toEqualTypeOf<z.input<typeof threeMfSchema>>();
        } else {
          expectTypeOf(input.to).toEqualTypeOf<'stl'>();
          expectTypeOf(input.options).toEqualTypeOf<Record<string, unknown>>();
        }
        return { success: true, data: input.files, issues: [] };
      },
      async cleanup() {},
    });
  });

  it('should default options to Record<string, unknown> when no optionsSchema declared (R5)', () => {
    defineTranscoder({
      name: 'TestTranscoder',
      version: '1.0.0',
      edges: [{ from: 'glb', to: 'usdz', fidelity: 'mesh' }] as const,
      async initialize() {
        return {};
      },
      async transcode(input) {
        expectTypeOf(input.options).toEqualTypeOf<Record<string, unknown>>();
        return { success: true, data: input.files, issues: [] };
      },
      async cleanup() {},
    });
  });

  it('should infer Context from initialize return and thread it to transcode/cleanup', () => {
    defineTranscoder({
      name: 'TestTranscoder',
      version: '1.0.0',
      edges: [{ from: 'glb', to: 'usdz', fidelity: 'mesh' }] as const,
      async initialize() {
        return { sessionId: 'abc', counter: 42 };
      },
      async transcode(_input, _runtime, context) {
        expectTypeOf(context).toEqualTypeOf<{ sessionId: string; counter: number }>();
        return { success: true, data: [], issues: [] };
      },
      async cleanup(context) {
        expectTypeOf(context).toEqualTypeOf<{ sessionId: string; counter: number }>();
      },
    });
  });

  it('should infer Options from optionsSchema and pass typed options to initialize (R5)', () => {
    const optionsSchema = z.object({ verbose: z.boolean().default(false) });
    defineTranscoder({
      name: 'TestTranscoder',
      version: '1.0.0',
      optionsSchema,
      edges: [{ from: 'glb', to: 'usdz', fidelity: 'mesh' }] as const,
      async initialize(options) {
        expectTypeOf(options).toEqualTypeOf<{ verbose: boolean }>();
        return {};
      },
      async transcode(_input) {
        return { success: true, data: [], issues: [] };
      },
      async cleanup() {},
    });
  });

  it('should require no explicit type arguments at the call site', () => {
    const transcoder = defineTranscoder({
      name: 'TestTranscoder',
      version: '1.0.0',
      edges: [{ from: 'glb', to: 'usdz', fidelity: 'mesh' }] as const,
      async initialize() {
        return {};
      },
      async transcode(input) {
        return { success: true, data: input.files, issues: [] };
      },
      async cleanup() {},
    });
    expectTypeOf(transcoder).toExtend<TranscoderDefinition>();
  });

  it('should NOT have discoverEdges or canTranscode in the contract (R1, R2)', () => {
    expectTypeOf<TranscoderDefinition>().not.toHaveProperty('discoverEdges');
    expectTypeOf<TranscoderDefinition>().not.toHaveProperty('canTranscode');
  });

  it('should expose static edges as a required property (R1)', () => {
    expectTypeOf<TranscoderDefinition>().toHaveProperty('edges');
  });
});

// =============================================================================
// TranscodeInput<Edges> discriminated union (R4, R5, R7)
// =============================================================================

describe('TranscodeInput discriminated union', () => {
  const qualitySchema = z.object({ quality: z.number().default(0.8) });

  it('should produce literal from/to per edge', () => {
    type Edges = readonly [
      { readonly from: 'glb'; readonly to: 'usdz'; readonly fidelity: 'mesh' },
      { readonly from: 'glb'; readonly to: 'stl'; readonly fidelity: 'mesh' },
    ];
    type Input = TranscodeInput<Edges>;
    expectTypeOf<Input['from']>().toEqualTypeOf<'glb'>();
    expectTypeOf<Input['to']>().toEqualTypeOf<'usdz' | 'stl'>();
  });

  it('should narrow options per-edge when optionsSchema is declared', () => {
    type Edges = readonly [
      {
        readonly from: 'glb';
        readonly to: 'usdz';
        readonly fidelity: 'mesh';
        readonly optionsSchema: typeof qualitySchema;
      },
      { readonly from: 'glb'; readonly to: 'stl'; readonly fidelity: 'mesh' },
    ];
    type Input = TranscodeInput<Edges>;
    type UsdzBranch = Extract<Input, { to: 'usdz' }>;
    type StlBranch = Extract<Input, { to: 'stl' }>;
    expectTypeOf<UsdzBranch['options']>().toEqualTypeOf<z.input<typeof qualitySchema>>();
    expectTypeOf<StlBranch['options']>().toEqualTypeOf<Record<string, unknown>>();
  });

  it('should default to wide FileExtension when Edges is unconstrained', () => {
    type Input = TranscodeInput;
    expectTypeOf<Input['from']>().toEqualTypeOf<FileExtension>();
    expectTypeOf<Input['to']>().toEqualTypeOf<FileExtension>();
  });
});

// =============================================================================
// converterTranscoder + replicad — production factories (R2)
// =============================================================================

describe('converterTranscoder + replicad — production factories', () => {
  it('should typecheck client.export("3mf", { tessellation, coordinateSystem, unit, application })', () => {
    const client = createRuntimeClient({ kernels: [replicad()], transcoders: [converterTranscoder()] });
    void client.export('3mf', {
      unit: 'meter',
      application: 'PrusaSlicer 2.8',
      tessellation: { linearTolerance: 0.1, angularTolerance: 30 },
      coordinateSystem: 'z-up',
    });
  });

  it('should typecheck client.export("3mf", {}) — every field is defaulted or optional', () => {
    const client = createRuntimeClient({ kernels: [replicad()], transcoders: [converterTranscoder()] });
    void client.export('3mf', {});
  });

  it('should reject invalid edge option values', () => {
    const client = createRuntimeClient({ kernels: [replicad()], transcoders: [converterTranscoder()] });
    // @ts-expect-error -- 'parsec' is not a member of the unit enum
    void client.export('3mf', { unit: 'parsec' });
  });

  it('should reject wrong-typed edge option values', () => {
    const client = createRuntimeClient({ kernels: [replicad()], transcoders: [converterTranscoder()] });
    // @ts-expect-error -- application must be a string
    void client.export('3mf', { application: 42 });
  });

  it('should reject wrong-shaped source-format options on transcoded export', () => {
    const client = createRuntimeClient({ kernels: [replicad()], transcoders: [converterTranscoder()] });
    // @ts-expect-error -- tessellation must be an object, not a string
    void client.export('3mf', { tessellation: 'invalid' });
  });

  it('should typecheck schemaless transcoded export with GLB source-format options (fbx)', () => {
    const client = createRuntimeClient({ kernels: [replicad()], transcoders: [converterTranscoder()] });
    void client.export('fbx', { tessellation: { linearTolerance: 0.1 } });
  });

  it('should reject excess properties on schemaless transcoded export (fbx)', () => {
    const client = createRuntimeClient({ kernels: [replicad()], transcoders: [converterTranscoder()] });
    // @ts-expect-error -- fbx has no 'quality' option; only GLB source-format options apply
    void client.export('fbx', { quality: 0.5 });
  });

  it('should preserve kernel-native glb export typing alongside transcoded formats', () => {
    const client = createRuntimeClient({ kernels: [replicad()], transcoders: [converterTranscoder()] });
    void client.export('glb', { tessellation: { linearTolerance: 0.1 } });
  });
});

// =============================================================================
// presets.all() — multi-kernel preset typesafety (R17)
// =============================================================================

describe('presets.all() — multi-kernel preset typesafety (R17)', () => {
  it('should typecheck client.export("glb", { tessellation, coordinateSystem }) on the kernel-native path', () => {
    const client = createRuntimeClient(presets.all());
    void client.export('glb', {
      tessellation: { linearTolerance: 0.05, angularTolerance: 10 },
      coordinateSystem: 'z-up',
    });
  });

  it('should accept mix-and-match tessellation fields from OCCT and OpenSCAD on the same call (Finding 8)', () => {
    const client = createRuntimeClient(presets.all());
    void client.export('glb', {
      tessellation: { linearTolerance: 0.05, angularTolerance: 10, segments: 64 },
    });
  });

  it('should typecheck client.export("gltf", ...) on the preset path', () => {
    const client = createRuntimeClient(presets.all());
    void client.export('gltf', {
      tessellation: { linearTolerance: 0.05, angularTolerance: 10 },
      coordinateSystem: 'z-up',
    });
  });

  it('should typecheck client.export("step", { coordinateSystem }) on the preset path', () => {
    const client = createRuntimeClient(presets.all());
    void client.export('step', { coordinateSystem: 'z-up' });
  });

  it('should typecheck client.export("3mf", { tessellation, unit, application }) on the transcoded path', () => {
    const client = createRuntimeClient(presets.all());
    void client.export('3mf', {
      unit: 'meter',
      application: 'PrusaSlicer 2.8',
      tessellation: { linearTolerance: 0.1, angularTolerance: 30 },
      coordinateSystem: 'z-up',
    });
  });

  it('should typecheck client.export("usdz", { tessellation }) on the transcoded path', () => {
    const client = createRuntimeClient(presets.all());
    void client.export('usdz', {
      tessellation: { linearTolerance: 0.1 },
      coordinateSystem: 'y-up',
    });
  });

  it('should typecheck client.export("3mf", {}) — every field defaulted or optional', () => {
    const client = createRuntimeClient(presets.all());
    void client.export('3mf', {});
  });

  it('should reject excess properties on transcoded export', () => {
    const client = createRuntimeClient(presets.all());
    // @ts-expect-error -- bogus key not declared by any contributing kernel or transcoder edge
    void client.export('3mf', { bogusOption: 42 });
  });

  it('should reject wrong-typed edge option values on the preset path', () => {
    const client = createRuntimeClient(presets.all());
    // @ts-expect-error -- application must be a string, not number
    void client.export('3mf', { application: 42 });
  });

  it('should reject invalid edge enum values on the preset path', () => {
    const client = createRuntimeClient(presets.all());
    // @ts-expect-error -- 'parsec' not in unit enum
    void client.export('3mf', { unit: 'parsec' });
  });

  it('should reject undeclared formats on the preset path', () => {
    const client = createRuntimeClient(presets.all());
    // @ts-expect-error -- 'not-a-format' is not declared by any kernel or transcoder
    void client.export('not-a-format', {});
  });
});

// =============================================================================
// presets.all() — Record<string, never> regression guard (R18)
// =============================================================================

describe('presets.all() — Record<string, never> regression guard (R18)', () => {
  // Mirror of plugin-types.ts:IsRecordStringNever — duplicated intentionally so
  // the invariant is independent of the helper's implementation location.
  type IsRecordStringNeverContract<T> = string extends keyof T ? ([T[string]] extends [never] ? true : false) : false;

  it('should never produce Record<string, never> for any format key in CollectFormatMap<presets.all()>', () => {
    type AllPlugins = ReturnType<typeof presets.all>['kernels'];
    type FormatMap = CollectFormatMap<AllPlugins>;
    type AnnihilatedKeys = {
      [K in keyof FormatMap]: IsRecordStringNeverContract<FormatMap[K]> extends true ? K : never;
    }[keyof FormatMap];
    expectTypeOf<AnnihilatedKeys>().toEqualTypeOf<never>();
  });
});

// =============================================================================
// CollectKernelIds — derived KernelId generic from kernels tuple (R4)
// =============================================================================

describe('CollectKernelIds type inference', () => {
  it('should produce a singleton union from a single-kernel tuple literal', () => {
    // oxlint-disable-next-line @typescript-eslint/no-empty-object-type -- matches KernelPlugin default
    type Plugins = readonly [KernelPlugin<{}, Record<string, unknown>, 'replicad'>];
    type Ids = CollectKernelIds<Plugins>;
    expectTypeOf<Ids>().toEqualTypeOf<'replicad'>();
  });

  it('should produce a union of literals from a multi-kernel tuple', () => {
    /* oxlint-disable @typescript-eslint/no-empty-object-type -- matches KernelPlugin default */
    type Plugins = readonly [
      KernelPlugin<{}, Record<string, unknown>, 'replicad'>,
      KernelPlugin<{}, Record<string, unknown>, 'jscad'>,
      KernelPlugin<{}, Record<string, unknown>, 'manifold'>,
    ];
    /* oxlint-enable @typescript-eslint/no-empty-object-type */
    type Ids = CollectKernelIds<Plugins>;
    expectTypeOf<Ids>().toEqualTypeOf<'replicad' | 'jscad' | 'manifold'>();
  });

  it('should fall back to string for plugins that erase the Id phantom', () => {
    type Plugins = readonly [KernelPlugin, KernelPlugin];
    type Ids = CollectKernelIds<Plugins>;
    expectTypeOf<Ids>().toEqualTypeOf<string>();
  });

  it('should preserve the union of literal kernel ids exposed by presets.all()', () => {
    type AllPlugins = ReturnType<typeof presets.all>['kernels'];
    type Ids = CollectKernelIds<AllPlugins>;
    expectTypeOf<string>().toExtend<Ids | string>();
    expectTypeOf<Ids>().not.toEqualTypeOf<never>();
  });
});

// =============================================================================
// createRuntimeClient — bestRouteFor KernelId narrowing (R8)
// =============================================================================

describe('createRuntimeClient — bestRouteFor KernelId narrowing', () => {
  it('should accept literal kernel ids declared on the kernels tuple', () => {
    const client = createRuntimeClient(presets.all());
    void client.bestRouteFor('glb', 'replicad');
    void client.bestRouteFor('glb', 'jscad');
    void client.bestRouteFor('glb');
  });

  it('should reject kernel ids that are not in the kernels tuple', () => {
    const client = createRuntimeClient(presets.all());
    // @ts-expect-error -- 'not-a-kernel' is not a registered kernel id
    void client.bestRouteFor('glb', 'not-a-kernel');
  });

  it('should expose routesFor as a readonly array of routes', () => {
    const client = createRuntimeClient(presets.all());
    const routes = client.routesFor('glb');
    expectTypeOf(routes).toExtend<ReadonlyArray<{ targetFormat: string; kernelId: string }>>();
  });
});

// =============================================================================
// TranscoderPlugin Id phantom (R1)
// =============================================================================

describe('TranscoderPlugin Id phantom', () => {
  it('should accept a third Id generic argument', () => {
    // oxlint-disable-next-line @typescript-eslint/no-empty-object-type -- matches TranscoderPlugin default
    type WithId = TranscoderPlugin<{}, 'glb', 'converter'>;
    expectTypeOf<WithId>().toExtend<TranscoderPlugin>();
  });

  it('should infer the Id from a TranscoderPlugin via conditional inference', () => {
    // oxlint-disable-next-line @typescript-eslint/no-empty-object-type -- matches TranscoderPlugin default
    type WithId = TranscoderPlugin<{}, 'glb', 'converter'>;
    type Inferred = WithId extends TranscoderPlugin<infer _E, infer _F, infer Id> ? Id : never;
    expectTypeOf<Inferred>().toEqualTypeOf<'converter'>();
  });

  it('should default the Id to string when no third generic provided', () => {
    type DefaultPlugin = TranscoderPlugin;
    type Inferred = DefaultPlugin extends TranscoderPlugin<infer _E, infer _F, infer Id> ? Id : never;
    expectTypeOf<Inferred>().toEqualTypeOf<string>();
  });

  it('should preserve the literal id on the runtime registration object', () => {
    const factory = createTranscoderPlugin({
      id: 'converter',
      moduleUrl: 'test://converter',
    });
    const registration = factory();
    expectTypeOf(registration.id).toEqualTypeOf<'converter'>();
  });

  it('should preserve the literal id on the converterTranscoder preset factory', () => {
    const registration = converterTranscoder();
    expectTypeOf(registration.id).toEqualTypeOf<'converter'>();
  });
});

// =============================================================================
// Type-bag helpers (R2)
// =============================================================================

describe('Type-bag helpers', () => {
  /* oxlint-disable @typescript-eslint/no-empty-object-type -- matches plugin defaults */
  type ReplicadLike = KernelPlugin<
    { stl: { binary?: boolean }; glb: { coordinateSystem?: 'y-up' | 'z-up' } },
    { tessellation?: { linearTolerance?: number; angularTolerance?: number } },
    'replicad'
  >;
  type OpenscadLike = KernelPlugin<
    { stl: {}; off: {} },
    { tessellation?: { segments?: number; minimumAngle?: number; minimumSize?: number } },
    'openscad'
  >;
  type ConverterLike = TranscoderPlugin<{ '3mf': { unit?: string }; usdz: {}; fbx: {} }, 'glb', 'converter'>;
  /* oxlint-enable @typescript-eslint/no-empty-object-type */
  type Kernels = readonly [ReplicadLike, OpenscadLike];
  type Transcoders = readonly [ConverterLike];

  it('KnownTranscoderIds should resolve to the literal Id from a tuple of transcoders', () => {
    expectTypeOf<KnownTranscoderIds<Transcoders>>().toEqualTypeOf<'converter'>();
  });

  it('KnownTranscoderIds should fall back to string for the wide-default bag', () => {
    expectTypeOf<KnownTranscoderIds<TranscoderPlugin[]>>().toEqualTypeOf<string>();
  });

  it('KnownTranscoderIds should preserve the converter id from the converterTranscoder factory', () => {
    type T = readonly [ReturnType<typeof converterTranscoder>];
    expectTypeOf<KnownTranscoderIds<T>>().toEqualTypeOf<'converter'>();
  });

  it('CollectTranscoderTargets should resolve to the EdgeMap key union for known transcoders', () => {
    type Targets = CollectTranscoderTargets<Transcoders>;
    expectTypeOf<Targets>().toEqualTypeOf<'3mf' | 'usdz' | 'fbx'>();
  });

  it('CollectTranscoderTargets should fall back to FileExtension for the wide-default bag', () => {
    expectTypeOf<CollectTranscoderTargets<TranscoderPlugin[]>>().toEqualTypeOf<FileExtension>();
  });

  it('KnownTargetFormats should resolve to the union of kernel and transcoder targets', () => {
    type Targets = KnownTargetFormats<Kernels, Transcoders>;
    expectTypeOf<Targets>().toEqualTypeOf<'stl' | 'glb' | 'off' | '3mf' | 'usdz' | 'fbx'>();
  });

  it('KnownTargetFormats should fall back to FileExtension for the wide-default bags', () => {
    expectTypeOf<KnownTargetFormats<KernelPlugin[], TranscoderPlugin[]>>().toEqualTypeOf<FileExtension>();
  });

  it('KnownSourceFormats should alias kernel-native export formats', () => {
    expectTypeOf<KnownSourceFormats<Kernels>>().toEqualTypeOf<'stl' | 'glb' | 'off'>();
  });

  it('KnownSourceFormats should fall back to FileExtension for the wide-default bag', () => {
    expectTypeOf<KnownSourceFormats<KernelPlugin[]>>().toEqualTypeOf<FileExtension>();
  });

  it('RenderOptionsFor should resolve to the replicad render options for the replicad kernel', () => {
    expectTypeOf<RenderOptionsFor<Kernels, 'replicad'>>().toEqualTypeOf<{
      tessellation?: { linearTolerance?: number; angularTolerance?: number };
    }>();
  });

  it('RenderOptionsFor should resolve to the openscad render options for the openscad kernel', () => {
    expectTypeOf<RenderOptionsFor<Kernels, 'openscad'>>().toEqualTypeOf<{
      tessellation?: { segments?: number; minimumAngle?: number; minimumSize?: number };
    }>();
  });

  it('RenderOptionsFor should fall back to Record<string, unknown> for the wide-default bag', () => {
    expectTypeOf<RenderOptionsFor<KernelPlugin[], string>>().toEqualTypeOf<Record<string, unknown>>();
  });
});

// =============================================================================
// RuntimeClient bag propagation (R3)
// =============================================================================

describe('RuntimeClient bag propagation', () => {
  /* oxlint-disable @typescript-eslint/no-empty-object-type -- matches plugin defaults */
  type ReplicadLike = KernelPlugin<
    { stl: { binary?: boolean }; glb: { coordinateSystem?: 'y-up' | 'z-up' } },
    { tessellation?: { linearTolerance?: number } },
    'replicad'
  >;
  type OpenscadLike = KernelPlugin<{ off: {} }, { tessellation?: { segments?: number } }, 'openscad'>;
  type ConverterLike = TranscoderPlugin<{ usdz: {}; '3mf': { unit?: string } }, 'glb', 'converter'>;
  /* oxlint-enable @typescript-eslint/no-empty-object-type */
  type Kernels = readonly [ReplicadLike, OpenscadLike];
  type Transcoders = readonly [ConverterLike];
  type Client = RuntimeClient<Kernels, Transcoders>;

  it('should narrow routesFor first parameter to KnownTargetFormats', () => {
    type Format = Parameters<Client['routesFor']>[0];
    expectTypeOf<Format>().toEqualTypeOf<KnownTargetFormats<Kernels, Transcoders>>();
  });

  it('should narrow bestRouteFor first parameter to KnownTargetFormats', () => {
    type Format = Parameters<Client['bestRouteFor']>[0];
    expectTypeOf<Format>().toEqualTypeOf<KnownTargetFormats<Kernels, Transcoders>>();
  });

  it('should narrow bestRouteFor second parameter to the kernel-id union', () => {
    type Kernel = NonNullable<Parameters<Client['bestRouteFor']>[1]>;
    expectTypeOf<Kernel>().toEqualTypeOf<CollectKernelIds<Kernels>>();
  });

  it('should narrow activeKernelId to the kernel-id union', () => {
    expectTypeOf<Client['activeKernelId']>().toEqualTypeOf<CollectKernelIds<Kernels> | undefined>();
  });

  it('should narrow capabilities to a typed CapabilitiesManifest projection', () => {
    type Capabilities = Client['capabilities'];
    type ManifestRoutes = NonNullable<Capabilities>['routes'];
    expectTypeOf<ManifestRoutes>().toExtend<
      ReadonlyArray<{ targetFormat: KnownTargetFormats<Kernels, Transcoders> }>
    >();
  });

  it('should still type-check render options via the kernels bag', () => {
    const _check = (client: Client) => {
      void client.render({
        code: { '/main.ts': '' },
        options: { tessellation: { linearTolerance: 0.01 } },
      });
    };
    void _check;
  });

  it('should still type-check export options via MergeExportMap', () => {
    const _check = (client: Client) => {
      void client.export('3mf', { unit: 'centimeter' });
    };
    void _check;
  });

  it('should reject unknown formats on routesFor', () => {
    const _check = (client: Client) => {
      // @ts-expect-error -- 'step' is not a known target format for these bags
      void client.routesFor('step');
    };
    void _check;
  });

  it('should reject unknown formats on bestRouteFor', () => {
    const _check = (client: Client) => {
      // @ts-expect-error -- 'step' is not a known target format for these bags
      void client.bestRouteFor('step');
    };
    void _check;
  });

  it('should reject unknown kernel ids on bestRouteFor', () => {
    const _check = (client: Client) => {
      // @ts-expect-error -- 'unknown-kernel' is not a registered kernel id
      void client.bestRouteFor('stl', 'unknown-kernel');
    };
    void _check;
  });

  it('wide-default RuntimeClient should accept any FileExtension on routesFor', () => {
    const _check = (client: RuntimeClient) => {
      void client.routesFor('stl' satisfies FileExtension);
      void client.routesFor('step' satisfies FileExtension);
    };
    void _check;
  });

  it('wide-default RuntimeClient should accept any kernel id on bestRouteFor', () => {
    const _check = (client: RuntimeClient) => {
      void client.bestRouteFor('stl' satisfies FileExtension, 'whatever-kernel');
    };
    void _check;
  });
});

// =============================================================================
// Erasure-form equivalence (R6)
// =============================================================================

describe('RuntimeClient erasure-form equivalence (R6)', () => {
  // oxlint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- intentional: documents the wide-default erasure form per R6
  type Wide = RuntimeClient<KernelPlugin[], TranscoderPlugin[]>;

  it('should accept any FileExtension and arbitrary options on export under the wide form', () => {
    const _check = (client: Wide) => {
      void client.export('stl' satisfies FileExtension);
      void client.export('step' satisfies FileExtension, { arbitrary: true });
    };
    void _check;
  });

  it('should accept any FileExtension on routesFor and bestRouteFor under the wide form', () => {
    const _check = (client: Wide) => {
      void client.routesFor('stl' satisfies FileExtension);
      void client.bestRouteFor('step' satisfies FileExtension);
      void client.bestRouteFor('glb' satisfies FileExtension, 'any-kernel');
    };
    void _check;
  });

  it('should expose capabilities as the wide-default CapabilitiesManifest', () => {
    type Cap = Wide['capabilities'];
    type Routes = NonNullable<Cap>['routes'];
    expectTypeOf<Routes>().toExtend<ReadonlyArray<{ targetFormat: FileExtension }>>();
  });
});

// =============================================================================
// Worker boundary witness narrowing (R7)
//
// The runtime worker physically emits a wide-default `CapabilitiesManifest`
// over the wire (no generic information survives `postMessage`). The
// `RuntimeClient<Kernels, Transcoders>` accessor narrows that wide value to
// `CapabilitiesManifest<Kernels, Transcoders>` at the seam.
//
// These tests assert the narrowing is a *witness* narrowing — every concrete
// value the worker produces is structurally a valid member of the narrower
// shape, so the cast is sound by construction. If this test ever fails it
// means the wide and narrow manifest shapes have diverged and the cast in
// `runtime-client.ts` would no longer be safe.
// =============================================================================

describe('Worker boundary witness narrowing (R7)', () => {
  // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- intentional: empty tuple represents "no transcoders" type-bag
  type NoTranscoders = readonly [];

  it('should preserve manifest leaf field shapes between wide and narrow forms', () => {
    type Kernels = readonly [KernelPlugin<{ stl: { mesh: { foo: number } } }, { quality: 'low' | 'high' }, 'replicad'>];

    type WideRoute = NonNullable<CapabilitiesManifest['routes'][number]>;
    type NarrowRoute = NonNullable<CapabilitiesManifest<Kernels, NoTranscoders>['routes'][number]>;

    expectTypeOf<NarrowRoute['targetFormat']>().toExtend<WideRoute['targetFormat']>();
    expectTypeOf<NarrowRoute['kernelId']>().toExtend<WideRoute['kernelId']>();
    expectTypeOf<NarrowRoute['fidelity']>().toEqualTypeOf<WideRoute['fidelity']>();
    expectTypeOf<NarrowRoute['sourceFormat']>().toExtend<WideRoute['sourceFormat']>();
  });

  it('should preserve renderSchemas indexing shape between wide and narrow forms', () => {
    type Kernels = readonly [KernelPlugin<{ stl: { mesh: { foo: number } } }, { quality: 'low' | 'high' }, 'replicad'>];

    type NarrowSchemas = NonNullable<CapabilitiesManifest<Kernels, NoTranscoders>['renderSchemas']>;
    type NarrowKernelKey = keyof NarrowSchemas;

    expectTypeOf<NarrowKernelKey>().toExtend<string>();
  });

  it('should require an unknown-bridge cast at the seam (documents the SAFETY block)', () => {
    type Kernels = readonly [KernelPlugin<{ stl: { mesh: { foo: number } } }, { quality: 'low' | 'high' }, 'replicad'>];

    const seamCast = (
      // oxlint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- intentional: documents the wide-default erasure form per R6
      wideClient: RuntimeClient<KernelPlugin[], TranscoderPlugin[]>,
    ): CapabilitiesManifest<Kernels, NoTranscoders> | undefined =>
      wideClient.capabilities as unknown as CapabilitiesManifest<Kernels, NoTranscoders> | undefined;
    void seamCast;
  });
});

// =============================================================================
// Type-info preservation invariants (audit-R4)
//
// Regression sentinels for `docs/research/runtime-client-type-preservation-audit.md`.
// Each `it` locks in a consumer-facing invariant of the runtime-client type
// surface so future changes (inline rewrites, generic re-shuffles, plugin-union
// edits) cannot silently erode type information.
//
// All assertions are expected GREEN on first run. A RED result indicates that
// the audit's "FIXED" Status no longer holds and the regression must be fixed
// at source per the cited recommendation in the audit document — never by
// weakening the assertion.
// =============================================================================

describe('Type-info preservation invariants (audit-R4)', () => {
  /* oxlint-disable @typescript-eslint/no-empty-object-type -- matches plugin defaults */
  type ReplicadLike = KernelPlugin<
    { stl: { binary?: boolean }; glb: { coordinateSystem?: 'y-up' | 'z-up' } },
    { tessellation?: { linearTolerance?: number; angularTolerance?: number } },
    'replicad'
  >;
  type OpenscadLike = KernelPlugin<
    { off: {} },
    { tessellation?: { segments?: number; minimumAngle?: number } },
    'openscad'
  >;
  type ConverterLike = TranscoderPlugin<{ usdz: { unit?: string }; '3mf': {} }, 'glb', 'converter'>;
  /* oxlint-enable @typescript-eslint/no-empty-object-type */
  type Kernels = readonly [ReplicadLike, OpenscadLike];
  type Transcoders = readonly [ConverterLike];
  type Client = RuntimeClient<Kernels, Transcoders>;
  type Manifest = NonNullable<Client['capabilities']>;

  // ── Clause (a): renderSchemas equals KernelRenderSchema ──────────────────
  // R1 (audit) — inline expansion in CapabilitiesManifest.renderSchemas must
  // remain structurally equivalent to the named KernelRenderSchema alias.
  describe('clause (a) — renderSchemas inline ≡ named (R1)', () => {
    it('should keep manifest.renderSchemas.replicad structurally equal to KernelRenderSchema<Kernels, "replicad">', () => {
      type Schema = Manifest['renderSchemas']['replicad'];
      expectTypeOf<Schema>().toEqualTypeOf<KernelRenderSchema<Kernels, 'replicad'> | undefined>();
    });

    it('should keep manifest.renderSchemas.openscad structurally equal to KernelRenderSchema<Kernels, "openscad">', () => {
      type Schema = Manifest['renderSchemas']['openscad'];
      expectTypeOf<Schema>().toEqualTypeOf<KernelRenderSchema<Kernels, 'openscad'> | undefined>();
    });

    it('should narrow renderSchemas.replicad.defaults to the replicad render-options input type', () => {
      type Defaults = NonNullable<Manifest['renderSchemas']['replicad']>['defaults'];
      expectTypeOf<Defaults>().toEqualTypeOf<{
        tessellation?: { linearTolerance?: number; angularTolerance?: number };
      }>();
    });

    it('should narrow renderSchemas.openscad.defaults to the openscad render-options input type', () => {
      type Defaults = NonNullable<Manifest['renderSchemas']['openscad']>['defaults'];
      expectTypeOf<Defaults>().toEqualTypeOf<{
        tessellation?: { segments?: number; minimumAngle?: number };
      }>();
    });
  });

  // ── Clause (b): export accepts narrow per-format options ─────────────────
  describe('clause (b) — export() narrow per-format options', () => {
    it('should constrain client.export to known target formats only', () => {
      type ExportFunction = Client['export'];
      type FirstParameter = Parameters<ExportFunction>[0];
      expectTypeOf<FirstParameter>().toEqualTypeOf<'stl' | 'glb' | 'off' | 'usdz' | '3mf'>();
    });

    it('should narrow client.export("stl", options) to the replicad STL options shape', () => {
      const _check = (client: Client) => {
        void client.export('stl', { binary: true });
        // @ts-expect-error -- 'unknownOption' is not in the STL options shape
        void client.export('stl', { unknownOption: true });
      };
      void _check;
    });

    it('should narrow client.export("glb", options) to the replicad GLB options shape', () => {
      const _check = (client: Client) => {
        void client.export('glb', { coordinateSystem: 'y-up' });
        // @ts-expect-error -- 'wrong-axis' is not in the GLB coordinateSystem union
        void client.export('glb', { coordinateSystem: 'wrong-axis' });
      };
      void _check;
    });

    it('should narrow client.export("usdz", options) to the converter USDZ options shape', () => {
      const _check = (client: Client) => {
        void client.export('usdz', { unit: 'meter' });
      };
      void _check;
    });

    it('should reject client.export with an unknown target format', () => {
      const _check = (client: Client) => {
        // @ts-expect-error -- 'step' is not in the kernel/transcoder target union
        void client.export('step', {});
      };
      void _check;
    });
  });

  // ── Clause (c): bestRouteFor / routesFor return narrow ExportRoute ───────
  describe('clause (c) — bestRouteFor / routesFor narrow ExportRoute', () => {
    it('should return ExportRoute<Kernels, Transcoders> | undefined from bestRouteFor', () => {
      type BestRouteReturn = ReturnType<Client['bestRouteFor']>;
      expectTypeOf<BestRouteReturn>().toEqualTypeOf<ExportRoute<Kernels, Transcoders> | undefined>();
    });

    it('should return ReadonlyArray<ExportRoute<Kernels, Transcoders>> from routesFor', () => {
      type RoutesReturn = ReturnType<Client['routesFor']>;
      expectTypeOf<RoutesReturn>().toEqualTypeOf<ReadonlyArray<ExportRoute<Kernels, Transcoders>>>();
    });

    it('should constrain bestRouteFor format param to known targets', () => {
      type FormatParameter = Parameters<Client['bestRouteFor']>[0];
      expectTypeOf<FormatParameter>().toEqualTypeOf<'stl' | 'glb' | 'off' | 'usdz' | '3mf'>();
    });

    it('should constrain bestRouteFor kernelId param to known kernel ids', () => {
      type KernelIdParameter = Parameters<Client['bestRouteFor']>[1];
      expectTypeOf<KernelIdParameter>().toEqualTypeOf<'replicad' | 'openscad' | undefined>();
    });

    it('should narrow ExportRoute kernelId, sourceFormat, and transcoderId to known unions', () => {
      type Route = ExportRoute<Kernels, Transcoders>;
      expectTypeOf<Route['kernelId']>().toEqualTypeOf<'replicad' | 'openscad'>();
      expectTypeOf<Route['sourceFormat']>().toEqualTypeOf<'stl' | 'glb' | 'off'>();
      expectTypeOf<Route['transcoderId']>().toEqualTypeOf<'converter' | undefined>();
    });
  });

  // ── R2 (audit): explicit alias preserves narrow types ────────────────────
  // ReturnType<typeof createRuntimeClient> picks the implementation signature
  // (wide-default), eroding narrow type info. Always declare an explicit
  // RuntimeClient<MyKernels, MyTranscoders> alias instead.
  describe('R2 — explicit alias vs ReturnType<typeof createRuntimeClient>', () => {
    it('should preserve narrow Kernels through an explicit RuntimeClient<MyKernels> alias', () => {
      type ExplicitClient = RuntimeClient<Kernels, Transcoders>;
      type Cap = NonNullable<ExplicitClient['capabilities']>;
      expectTypeOf<Cap['renderSchemas']['replicad']>().toEqualTypeOf<
        KernelRenderSchema<Kernels, 'replicad'> | undefined
      >();
    });

    it('should erode to the wide-default RuntimeClient when typed via ReturnType<typeof createRuntimeClient>', () => {
      type Eroded = ReturnType<typeof createRuntimeClient>;
      // The wide-default form has FileExtension keys and string kernel ids — strictly wider than the narrow alias.
      type ErodedFormat = Parameters<Eroded['bestRouteFor']>[0];
      expectTypeOf<ErodedFormat>().toEqualTypeOf<FileExtension>();
      type ErodedKernelId = Parameters<Eroded['bestRouteFor']>[1];
      expectTypeOf<ErodedKernelId>().toEqualTypeOf<string | undefined>();
    });
  });

  // ── R3 (audit): plugin.id is the literal Id, never `any` ────────────────
  // Plugin-union utility types must constrain `Id extends string` so
  // `plugin.id` accesses are statically `string`, not `any`.
  describe('R3 — plugin.id literal Id preservation', () => {
    it('should expose plugin.id as the literal Id for typed kernel plugins', () => {
      expectTypeOf<ReplicadLike['id']>().toEqualTypeOf<'replicad'>();
      expectTypeOf<OpenscadLike['id']>().toEqualTypeOf<'openscad'>();
    });

    it('should expose plugin.id as the literal Id for typed transcoder plugins', () => {
      expectTypeOf<ConverterLike['id']>().toEqualTypeOf<'converter'>();
    });

    it('should expose plugin.id as string (not any) on wide-default KernelPlugin', () => {
      expectTypeOf<KernelPlugin['id']>().toEqualTypeOf<string>();
    });

    it('should expose plugin.id as string (not any) on wide-default TranscoderPlugin', () => {
      expectTypeOf<TranscoderPlugin['id']>().toEqualTypeOf<string>();
    });
  });
});
