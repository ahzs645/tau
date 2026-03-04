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
import type { KernelIssue } from '#types/kernel.types.js';
import { defineBundler } from '#types/kernel-bundler.types.js';
import type { BuiltinModule } from '#bundler/module-manager.js';
import {
  EsbuildBundler,
  initializeEsbuild,
  executeCode,
  createDetectionPlugin,
  extractExternalImports,
  extractProjectDependencies,
} from '#bundler/esbuild-core.js';

const autoExportNames = ['main', 'defaultParams', 'getParameterDefinitions'];

export default defineBundler({
  name: 'EsbuildBundler',
  version: '1.0.0',
  extensions: ['ts', 'js', 'tsx', 'jsx'],

  async initialize({ filesystem, projectPath }, _options) {
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

  async detectImports({ entryPath }, context) {
    const buildOptions: BuildOptions = {
      entryPoints: [entryPath],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      plugins: [
        createDetectionPlugin({
          filesystem: context.filesystem,
          projectPath: context.projectPath,
        }),
      ],
      external: [],
      logLevel: 'silent',
    };

    try {
      const result = await esbuild.build(buildOptions);
      return {
        detectedModules: extractExternalImports(result.metafile),
        dependencies: extractProjectDependencies(result.metafile, context.projectPath),
      };
    } catch (error) {
      const issues: KernelIssue[] = [];
      if (error && typeof error === 'object' && 'errors' in error) {
        const buildErrors = error as { errors: Array<{ text: string }> };
        for (const errorMessage of buildErrors.errors) {
          issues.push({
            message: errorMessage.text,
            type: 'compilation',
            severity: 'error',
          });
        }
      }

      return { detectedModules: [], dependencies: [] };
    }
  },

  async bundle({ entryPath }, context) {
    return context.bundler.bundle(entryPath);
  },

  async execute(code, _context) {
    return executeCode(code);
  },

  registerModule(name, builtinModule, context) {
    const entry: BuiltinModule = {
      code: builtinModule.code,
      version: builtinModule.version,
      globalName: builtinModule.globalName,
    };
    context.builtinModules.set(name, entry);
    context.bundler.registerModule(name, entry);
  },

  async resolveDependencies({ entryPath }, context) {
    const result = await context.bundler.bundle(entryPath);
    return result.dependencies;
  },

  async cleanup(context) {
    context.bundler.dispose();
  },
});
