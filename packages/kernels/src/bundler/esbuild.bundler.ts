/**
 * ESBuild Bundler Definition
 *
 * Provides the `defineBundler` plugin interface for the kernel framework:
 * - detectImports: lightweight pass that discovers bare-specifier imports
 *   transitively using esbuild externals mode (no modules need to be registered)
 * - bundle: full production bundle with all registered modules resolved
 * - execute: run bundled JS/TS code via dynamic import (Blob URL or data URL)
 * - registerModule: register/update builtin modules for bundle resolution
 * - resolveDependencies: fast-path dependency resolution via metafile
 *
 * Named exports (EsbuildBundler, createZenFsPlugin, initializeEsbuild, etc.)
 * live in `./esbuild-core.ts` to avoid mixed default + named CJS output.
 */

import * as esbuild from 'esbuild-wasm';
import type { BuildOptions } from 'esbuild-wasm';
import type {
  BundleInput,
  BundlerInitOptions,
  BundleResult as TypesBundleResult,
  ExecuteResult,
  BuiltinModuleEntry,
  DetectImportsResult,
  KernelIssue,
} from '@taucad/types';
import { defineBundler } from '@taucad/types';
import type { BuiltinModule } from '#bundler/module-manager.js';
import {
  EsbuildBundler,
  initializeEsbuild,
  executeCode,
  createDetectionPlugin,
  extractExternalImports,
  extractProjectDependencies,
} from '#bundler/esbuild-core.js';
import type { EsbuildBundlerContext } from '#bundler/esbuild-core.js';

const autoExportNames = ['main', 'defaultParams', 'getParameterDefinitions'];

export default defineBundler<EsbuildBundlerContext>({
  name: 'EsbuildBundler',
  version: '1.0.0',

  async initialize({ filesystem, projectPath }: BundlerInitOptions): Promise<EsbuildBundlerContext> {
    const builtinModules = new Map<string, BuiltinModule>();
    await initializeEsbuild();
    const bundler = new EsbuildBundler({
      filesystem,
      projectPath,
      builtinModules,
      autoExportNames,
    });
    await bundler.initialize();
    return { bundler, builtinModules, filesystem, projectPath };
  },

  async detectImports({ entryPath }: BundleInput, ctx: EsbuildBundlerContext): Promise<DetectImportsResult> {
    const buildOptions: BuildOptions = {
      entryPoints: [entryPath],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      plugins: [createDetectionPlugin({ filesystem: ctx.filesystem, projectPath: ctx.projectPath })],
      external: [],
      logLevel: 'silent',
    };

    try {
      const result = await esbuild.build(buildOptions);
      return {
        detectedModules: extractExternalImports(result.metafile),
        dependencies: extractProjectDependencies(result.metafile, ctx.projectPath),
      };
    } catch (error) {
      const issues: KernelIssue[] = [];
      if (error && typeof error === 'object' && 'errors' in error) {
        const buildErrors = error as { errors: Array<{ text: string }> };
        for (const errorMessage of buildErrors.errors) {
          issues.push({ message: errorMessage.text, type: 'compilation', severity: 'error' });
        }
      }

      return { detectedModules: [], dependencies: [] };
    }
  },

  async bundle({ entryPath }: BundleInput, ctx: EsbuildBundlerContext): Promise<TypesBundleResult> {
    return ctx.bundler.bundle(entryPath);
  },

  async execute(code: string, _ctx: EsbuildBundlerContext): Promise<ExecuteResult> {
    return executeCode(code);
  },

  registerModule(name: string, builtinModule: BuiltinModuleEntry, ctx: EsbuildBundlerContext): void {
    const entry: BuiltinModule = {
      code: builtinModule.code,
      version: builtinModule.version,
      globalName: builtinModule.globalName,
    };
    ctx.builtinModules.set(name, entry);
    ctx.bundler.registerModule(name, entry);
  },

  async resolveDependencies({ entryPath }: BundleInput, ctx: EsbuildBundlerContext): Promise<string[]> {
    const result = await ctx.bundler.bundle(entryPath);
    return result.dependencies;
  },

  async cleanup(_ctx: EsbuildBundlerContext): Promise<void> {
    _ctx.bundler.dispose();
  },
});
