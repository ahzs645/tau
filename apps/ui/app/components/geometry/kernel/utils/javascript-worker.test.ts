/**
 * JavaScriptWorker Tests
 *
 * Tests for the JavaScriptWorker base class including:
 * - Module resolution
 * - Bundling
 * - Error handling
 * - Stack trace classification
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type {
  KernelRuntime,
  CanHandleInput,
  GetParametersInput,
  GetParametersResult,
  CreateGeometryInput,
  CreateGeometryResult,
  ExportGeometryInput,
  ExportGeometryResult,
  GetDependenciesInput,
  KernelFilesystem,
  FrameContext,
} from '@taucad/types';
import {
  parsePackageSpecifier,
  resolveRelativePath,
  getNodeModulesPath,
  isBareSpecifier,
  extractPackageFromCdnUrl,
  extractPackageInfoFromCdnUrl,
  isEsmShUrl,
} from '#utils/import.utils.js';
import { JavaScriptWorker } from '#components/geometry/kernel/utils/javascript-worker.js';
import { EsbuildBundler } from '#components/geometry/kernel/utils/esbuild-bundler.js';

describe('Module Manager', () => {
  describe('parsePackageSpecifier', () => {
    it('should parse simple package name', () => {
      const result = parsePackageSpecifier('replicad');
      expect(result).toEqual({ name: 'replicad', version: '', path: '' });
    });

    it('should parse package with version', () => {
      const result = parsePackageSpecifier('replicad@0.19.1');
      expect(result).toEqual({ name: 'replicad', version: '0.19.1', path: '' });
    });

    it('should parse scoped package', () => {
      const result = parsePackageSpecifier('@jscad/modeling');
      expect(result).toEqual({ name: '@jscad/modeling', version: '', path: '' });
    });

    it('should parse scoped package with version', () => {
      const result = parsePackageSpecifier('@jscad/modeling@2.12.6');
      expect(result).toEqual({ name: '@jscad/modeling', version: '2.12.6', path: '' });
    });

    it('should parse package with subpath', () => {
      const result = parsePackageSpecifier('replicad/shapes');
      expect(result).toEqual({ name: 'replicad', version: '', path: 'shapes' });
    });

    it('should parse scoped package with version and subpath', () => {
      const result = parsePackageSpecifier('@jscad/modeling@2.12.6/primitives');
      expect(result).toEqual({ name: '@jscad/modeling', version: '2.12.6', path: 'primitives' });
    });
  });

  describe('isBareSpecifier', () => {
    it('should return true for bare specifiers', () => {
      expect(isBareSpecifier('replicad')).toBe(true);
      expect(isBareSpecifier('@jscad/modeling')).toBe(true);
      expect(isBareSpecifier('zod')).toBe(true);
    });

    it('should return false for relative imports', () => {
      expect(isBareSpecifier('./utils.ts')).toBe(false);
      expect(isBareSpecifier('../helpers.ts')).toBe(false);
    });

    it('should return false for absolute imports', () => {
      expect(isBareSpecifier('/absolute/path.ts')).toBe(false);
    });

    it('should return false for URL imports', () => {
      expect(isBareSpecifier('https://cdn.jsdelivr.net/npm/lodash')).toBe(false);
      expect(isBareSpecifier('http://example.com/module.js')).toBe(false);
    });
  });

  describe('extractPackageFromCdnUrl', () => {
    it('should extract package name from jsdelivr URLs', () => {
      expect(
        extractPackageFromCdnUrl('https://cdn.jsdelivr.net/npm/replicad-decorate/dist/studio/replicad-decorate.js'),
      ).toBe('replicad-decorate');
      expect(extractPackageFromCdnUrl('https://cdn.jsdelivr.net/npm/lodash')).toBe('lodash');
      expect(extractPackageFromCdnUrl('https://cdn.jsdelivr.net/npm/lodash@4.17.21')).toBe('lodash');
    });

    it('should extract package name from esm.sh URLs', () => {
      expect(extractPackageFromCdnUrl('https://esm.sh/lodash')).toBe('lodash');
      expect(extractPackageFromCdnUrl('https://esm.sh/lodash@4.17.21')).toBe('lodash');
    });

    it('should handle esm.sh version prefix', () => {
      expect(extractPackageFromCdnUrl('https://esm.sh/v135/lodash@4.17.21/index.d.ts')).toBe('lodash');
    });

    it('should extract package name from unpkg URLs', () => {
      expect(extractPackageFromCdnUrl('https://unpkg.com/lodash@4.17.21/lodash.js')).toBe('lodash');
    });

    it('should extract package name from esm.run URLs', () => {
      expect(extractPackageFromCdnUrl('https://esm.run/lodash')).toBe('lodash');
    });

    it('should extract package name from Skypack lookup URLs', () => {
      expect(extractPackageFromCdnUrl('https://cdn.skypack.dev/qrcode-generator@2.0.4')).toBe('qrcode-generator');
      expect(extractPackageFromCdnUrl('https://cdn.skypack.dev/react')).toBe('react');
    });

    it('should extract package name from Skypack pinned URLs', () => {
      expect(extractPackageFromCdnUrl('https://cdn.skypack.dev/pin/react@v16.13.1-zjOHmKoBShdi3wIQWY2z/react.js')).toBe(
        'react',
      );
      expect(
        extractPackageFromCdnUrl(
          'https://cdn.skypack.dev/pin/preact@v10.19.3-VLh4KNKC08lfhYfF3qms/dist=es2019,mode=imports/optimized/preact.js',
        ),
      ).toBe('preact');
    });

    it('should handle scoped packages in CDN URLs', () => {
      expect(extractPackageFromCdnUrl('https://cdn.jsdelivr.net/npm/@scope/pkg@1.0.0/dist/index.js')).toBe(
        '@scope/pkg',
      );
      expect(extractPackageFromCdnUrl('https://esm.sh/@jscad/modeling')).toBe('@jscad/modeling');
      expect(extractPackageFromCdnUrl('https://unpkg.com/@scope/pkg')).toBe('@scope/pkg');
      expect(extractPackageFromCdnUrl('https://cdn.skypack.dev/@scope/pkg@1.0.0')).toBe('@scope/pkg');
    });

    it('should return undefined for non-CDN URLs', () => {
      expect(extractPackageFromCdnUrl('https://example.com/module.js')).toBeUndefined();
      expect(extractPackageFromCdnUrl('https://github.com/user/repo')).toBeUndefined();
    });

    it('should return undefined for non-URL strings', () => {
      expect(extractPackageFromCdnUrl('lodash')).toBeUndefined();
      expect(extractPackageFromCdnUrl('./utils.ts')).toBeUndefined();
      expect(extractPackageFromCdnUrl('')).toBeUndefined();
    });
  });

  describe('extractPackageInfoFromCdnUrl', () => {
    it('should extract full package info from Skypack URLs', () => {
      expect(extractPackageInfoFromCdnUrl('https://cdn.skypack.dev/qrcode-generator@2.0.4')).toEqual({
        name: 'qrcode-generator',
        version: '2.0.4',
        path: '',
      });
    });

    it('should extract full package info from esm.sh URLs', () => {
      expect(extractPackageInfoFromCdnUrl('https://esm.sh/lodash@4.17.21')).toEqual({
        name: 'lodash',
        version: '4.17.21',
        path: '',
      });
    });

    it('should extract full package info from jsdelivr URLs', () => {
      expect(
        extractPackageInfoFromCdnUrl('https://cdn.jsdelivr.net/npm/replicad-decorate/dist/studio/replicad-decorate.js'),
      ).toEqual({
        name: 'replicad-decorate',
        version: '',
        path: 'dist/studio/replicad-decorate.js',
      });
    });

    it('should return undefined for non-CDN URLs', () => {
      expect(extractPackageInfoFromCdnUrl('https://example.com/module.js')).toBeUndefined();
    });
  });

  describe('isEsmShUrl', () => {
    it('should return true for esm.sh URLs', () => {
      expect(isEsmShUrl('https://esm.sh/lodash@4.17.21')).toBe(true);
      expect(isEsmShUrl('https://esm.sh/v135/lodash@4.17.21/index.d.ts')).toBe(true);
    });

    it('should return false for non-esm.sh URLs', () => {
      expect(isEsmShUrl('https://cdn.jsdelivr.net/npm/lodash')).toBe(false);
      expect(isEsmShUrl('https://cdn.skypack.dev/react')).toBe(false);
    });
  });

  describe('resolveRelativePath', () => {
    it('should resolve ./ imports', () => {
      const result = resolveRelativePath('./utils.ts', '/project/src/main.ts');
      expect(result).toBe('/project/src/utils.ts');
    });

    it('should resolve ../ imports', () => {
      const result = resolveRelativePath('../helpers.ts', '/project/src/main.ts');
      expect(result).toBe('/project/helpers.ts');
    });

    it('should handle multiple ../', () => {
      const result = resolveRelativePath('../../lib/utils.ts', '/project/src/components/button.ts');
      expect(result).toBe('/project/lib/utils.ts');
    });
  });

  describe('getNodeModulesPath', () => {
    it('should return correct path for simple package', () => {
      const result = getNodeModulesPath('replicad');
      expect(result).toBe('/node_modules/replicad');
    });

    it('should return correct path for scoped package', () => {
      const result = getNodeModulesPath('@jscad/modeling');
      expect(result).toBe('/node_modules/@jscad/modeling');
    });
  });
});

/**
 * Stack Frame Classification
 *
 * Tests the actual classifyFrame method from JavaScriptWorker via
 * TestableJavaScriptWorker. This exercises the full decision tree:
 *   1. blob: URLs -> 'user' (bundled user code)
 *   2. Library patterns -> 'library' (matched before node_modules)
 *   3. node:/</wasm: -> 'runtime' (engine and native frames)
 *   4. node_modules/data:/kernel/ -> 'framework' (infrastructure)
 *   5. Outside projectPath -> 'framework'
 *   6. Everything else -> 'user'
 *
 * @see JavaScriptWorker.classifyFrame in javascript-worker.ts
 */
describe('Stack Frame Classification', () => {
  let worker: TestableJavaScriptWorker;

  beforeAll(() => {
    worker = new TestableJavaScriptWorker();
  });

  it('should classify blob: URLs as user code', () => {
    expect(worker.testClassifyFrame('blob:https://example.com/abc123')).toBe('user');
  });

  it('should classify node_modules frames as framework', () => {
    expect(worker.testClassifyFrame('/builds/project/node_modules/some-lib/index.js')).toBe('framework');
  });

  it('should classify data: URLs as framework', () => {
    expect(worker.testClassifyFrame('data:text/javascript;base64,abc123')).toBe('framework');
  });

  it('should classify node: URLs as runtime', () => {
    expect(worker.testClassifyFrame('node:fs')).toBe('runtime');
  });

  it('should classify anonymous frames as runtime', () => {
    expect(worker.testClassifyFrame('<anonymous>')).toBe('runtime');
  });

  it('should classify wasm: URLs as runtime', () => {
    expect(worker.testClassifyFrame('wasm://wasm/0001b2c3')).toBe('runtime');
    expect(worker.testClassifyFrame('wasm:module')).toBe('runtime');
  });

  it('should classify kernel paths as framework', () => {
    expect(worker.testClassifyFrame('/builds/project/kernel/worker.js')).toBe('framework');
  });

  it('should classify regular project files as user code', () => {
    expect(worker.testClassifyFrame('/builds/project/main.ts')).toBe('user');
    expect(worker.testClassifyFrame('/builds/project/src/utils.ts')).toBe('user');
  });

  it('should classify library patterns as library (before node_modules check)', () => {
    const workerWithLibraries = new TestableJavaScriptWorker();
    workerWithLibraries.setLibraryPatterns([
      { pattern: '/node_modules/replicad/', moduleName: 'replicad' },
      { pattern: '/node_modules/@jscad/modeling/', moduleName: '@jscad/modeling' },
    ]);

    // Library pattern match takes priority over generic node_modules -> framework
    expect(workerWithLibraries.testClassifyFrame('/builds/project/node_modules/replicad/dist/index.js')).toBe(
      'library',
    );
    expect(
      workerWithLibraries.testClassifyFrame('/builds/project/node_modules/@jscad/modeling/src/primitives.js'),
    ).toBe('library');

    // Non-matching node_modules path is still framework
    expect(workerWithLibraries.testClassifyFrame('/builds/project/node_modules/lodash/index.js')).toBe('framework');
  });

  it('should classify files outside projectPath as framework', () => {
    const projectPath = '/builds/project';
    expect(worker.testClassifyFrame('/other/location/file.ts', projectPath)).toBe('framework');
    expect(worker.testClassifyFrame('/tmp/scratch.js', projectPath)).toBe('framework');
  });

  it('should classify files inside projectPath as user code', () => {
    const projectPath = '/builds/project';
    expect(worker.testClassifyFrame('/builds/project/main.ts', projectPath)).toBe('user');
    expect(worker.testClassifyFrame('/builds/project/src/helpers.ts', projectPath)).toBe('user');
  });
});

// =============================================================================
// Bundler Lifecycle
// =============================================================================

vi.mock('#components/geometry/kernel/utils/esbuild-bundler.js', () => {
  // Each instance remembers its own projectPath so changing the mock
  // for a new call doesn't affect existing instances.
  const esbuildBundlerMock = vi.fn().mockImplementation((options: { projectPath: string }) => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    getProjectPath: vi.fn().mockReturnValue(options.projectPath),
  }));
  // eslint-disable-next-line @typescript-eslint/naming-convention -- Mocking a class constructor
  return { EsbuildBundler: esbuildBundlerMock };
});

/**
 * Minimal concrete subclass of JavaScriptWorker for testing protected methods.
 */
class TestableJavaScriptWorker extends JavaScriptWorker {
  protected get name(): string {
    return 'test-worker';
  }

  private testLibraryPatterns: Array<{ pattern: string; moduleName: string }> = [];

  public async exposedGetBundler(filesystem: KernelFilesystem, projectPath: string): Promise<EsbuildBundler> {
    return this.getBundler(filesystem, projectPath);
  }

  /** Expose protected classifyFrame for direct testing. */
  public testClassifyFrame(fileName: string, projectPath?: string): FrameContext {
    return this.classifyFrame(fileName, projectPath);
  }

  /** Set library patterns for classifyFrame tests. */
  public setLibraryPatterns(patterns: Array<{ pattern: string; moduleName: string }>): void {
    this.testLibraryPatterns = patterns;
  }

  protected override getLibraryPathPatterns(): Array<{ pattern: string; moduleName: string }> {
    return this.testLibraryPatterns;
  }

  protected async canHandle(_input: CanHandleInput, _runtime: KernelRuntime): Promise<boolean> {
    return true;
  }

  protected async getParameters(_input: GetParametersInput, _runtime: KernelRuntime): Promise<GetParametersResult> {
    return { success: true, data: { defaultParameters: {}, jsonSchema: undefined }, issues: [] };
  }

  protected async createGeometry(_input: CreateGeometryInput, _runtime: KernelRuntime): Promise<CreateGeometryResult> {
    return { success: false, issues: [] };
  }

  protected async exportGeometry(_input: ExportGeometryInput, _runtime: KernelRuntime): Promise<ExportGeometryResult> {
    return { success: false, issues: [] };
  }

  protected override async getDependencies(_input: GetDependenciesInput, _runtime: KernelRuntime): Promise<string[]> {
    return [];
  }
}

describe('Bundler Lifecycle', () => {
  const mockedEsbuildBundler = vi.mocked(EsbuildBundler);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should dispose old bundler when projectPath changes', async () => {
    const worker = new TestableJavaScriptWorker();
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Minimal mock for testing
    const filesystem = {} as KernelFilesystem;

    // First call: create bundler for project A
    const bundlerA = await worker.exposedGetBundler(filesystem, '/project-a');
    expect(bundlerA).toBeDefined();
    expect(mockedEsbuildBundler).toHaveBeenCalledTimes(1);
    expect(bundlerA.getProjectPath()).toBe('/project-a');

    // Second call with different projectPath: should dispose old and create new
    const bundlerB = await worker.exposedGetBundler(filesystem, '/project-b');
    expect(bundlerB).toBeDefined();
    expect(mockedEsbuildBundler).toHaveBeenCalledTimes(2);
    expect(bundlerB.getProjectPath()).toBe('/project-b');

    // The old bundler's dispose should have been called
    expect(bundlerA.dispose).toHaveBeenCalledTimes(1);
  });

  it('should not dispose bundler when projectPath is the same', async () => {
    const worker = new TestableJavaScriptWorker();
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Minimal mock for testing
    const filesystem = {} as KernelFilesystem;

    const bundlerA = await worker.exposedGetBundler(filesystem, '/project-a');
    const bundlerB = await worker.exposedGetBundler(filesystem, '/project-a');

    // Should reuse the same bundler, no dispose called
    expect(mockedEsbuildBundler).toHaveBeenCalledTimes(1);
    expect(bundlerA).toBe(bundlerB);
    expect(bundlerA.dispose).not.toHaveBeenCalled();
  });
});
