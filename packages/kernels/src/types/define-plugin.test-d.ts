/**
 * Type-level tests for defineKernel, defineBundler, and defineMiddleware.
 *
 * Ensures all type parameters are correctly inferred from the definition
 * object without explicit type arguments. These tests are statically
 * analysed by the TypeScript compiler via vitest --typecheck and are
 * never executed at runtime.
 */

import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineKernel } from '#types/kernel-worker.types.js';
import { defineBundler } from '#types/kernel-bundler.types.js';
import { defineMiddleware } from '#middleware/kernel-middleware.js';
import type { KernelMiddleware } from '#middleware/kernel-middleware.js';
import { createKernelError } from '#framework/kernel-helpers.js';

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
        expectTypeOf(context).toEqualTypeOf<{ contextValue: string; count: number }>();
        return true;
      },
      async getDependencies(_input, _runtime, context) {
        expectTypeOf(context).toEqualTypeOf<{ contextValue: string; count: number }>();
        return [];
      },
      async getParameters(_input, _runtime, context) {
        expectTypeOf(context).toEqualTypeOf<{ contextValue: string; count: number }>();
        return createKernelError([]);
      },
      async createGeometry(_input, _runtime, context) {
        expectTypeOf(context).toEqualTypeOf<{ contextValue: string; count: number }>();
        return { geometry: [], nativeHandle: undefined };
      },
      async exportGeometry(_input, _runtime, context) {
        expectTypeOf(context).toEqualTypeOf<{ contextValue: string; count: number }>();
        return createKernelError([]);
      },
      async cleanup(context) {
        expectTypeOf(context).toEqualTypeOf<{ contextValue: string; count: number }>();
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
        return [];
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
        return [];
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
        expectTypeOf(nativeHandle).toEqualTypeOf<{ meshData: Float32Array<ArrayBuffer>; id: string }>();
        return createKernelError([]);
      },
    });
  });

  it('should infer Options from optionsSchema', () => {
    const schema = z.object({ baseUrl: z.string(), debug: z.boolean().default(false) });

    defineKernel({
      name: 'Test',
      version: '1.0.0',
      optionsSchema: schema,
      async initialize(options) {
        expectTypeOf(options).toEqualTypeOf<{ baseUrl: string; debug: boolean }>();
        return {};
      },
      async getDependencies() {
        return [];
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
        return [];
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
        return [];
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
        return [];
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
        expectTypeOf(context).toEqualTypeOf<{ bundlerInstance: string; projectPath: string }>();
        return { detectedModules: [], dependencies: [] };
      },
      async bundle(_input, context) {
        expectTypeOf(context).toEqualTypeOf<{ bundlerInstance: string; projectPath: string }>();
        return { code: '', issues: [], success: true, dependencies: [] };
      },
      async execute(_code, context) {
        expectTypeOf(context).toEqualTypeOf<{ bundlerInstance: string; projectPath: string }>();
        return { success: true as const, value: undefined };
      },
      registerModule(_name, _module, context) {
        expectTypeOf(context).toEqualTypeOf<{ bundlerInstance: string; projectPath: string }>();
      },
      async resolveDependencies(_input, context) {
        expectTypeOf(context).toEqualTypeOf<{ bundlerInstance: string; projectPath: string }>();
        return [];
      },
      async cleanup(context) {
        expectTypeOf(context).toEqualTypeOf<{ bundlerInstance: string; projectPath: string }>();
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
        return { code: '', issues: [], success: true, dependencies: [] };
      },
      async execute() {
        return { success: true as const, value: undefined };
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
        return { code: '', issues: [], success: true, dependencies: [] };
      },
      async execute() {
        return { success: true as const, value: undefined };
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
    const stateSchema = z.object({ cacheKey: z.string(), cacheHit: z.boolean() });

    const middleware = defineMiddleware({
      name: 'TestMiddleware',
      stateSchema,
      async wrapCreateGeometry(input, handler, { state }) {
        expectTypeOf(state.value).toExtend<{ cacheKey?: string; cacheHit?: boolean }>();
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
