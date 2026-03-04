/* eslint-disable @typescript-eslint/naming-convention -- Monaco API */
/**
 * TypeAcquisitionService Tests
 *
 * Comprehensive tests covering:
 * - Static type registration (addExtraLib on both defaults)
 * - Dynamic type watching (model listeners, create/dispose)
 * - Debounce behavior
 * - Import scanning and dedup
 * - CDN fetching (no version resolution)
 * - Epoch / session safety
 * - Retry and backoff
 * - Offline / CDN failure resilience
 * - Disposal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { TypeAcquisitionService } from '#lib/type-acquisition-service.js';
import type { StaticTypeDefinition } from '#lib/type-acquisition-service.js';

// =============================================================================
// Mock helpers
// =============================================================================

type MockDisposable = { dispose: ReturnType<typeof vi.fn> };

function createMockDisposable(): MockDisposable {
  return { dispose: vi.fn() };
}

type MockModelListener = (event?: unknown) => void;

// Define mock types explicitly to avoid circular type references
type MockMonacoModel = {
  getLanguageId: () => string;
  getValue: () => string;
  getVersionId: () => number;
  uri: { toString: () => string; path: string };
  onDidChangeContent: ReturnType<typeof vi.fn>;
  _setContent: (newContent: string) => void;
};

type MockDefaults = {
  addExtraLib: ReturnType<typeof vi.fn>;
  setCompilerOptions: ReturnType<typeof vi.fn>;
  setEagerModelSync: ReturnType<typeof vi.fn>;
};

type MockMonaco = {
  typescript: {
    typescriptDefaults: MockDefaults;
    javascriptDefaults: MockDefaults;
    ModuleResolutionKind: { NodeJs: number };
    ScriptTarget: { ESNext: number };
    ModuleKind: { ESNext: number };
  };
  editor: {
    getModels: () => MockMonacoModel[];
    getModel: ReturnType<typeof vi.fn>;
    onDidCreateModel: ReturnType<typeof vi.fn>;
    onWillDisposeModel: ReturnType<typeof vi.fn>;
  };
  Uri: {
    file: (path: string) => { toString: () => string; path: string };
  };
  _addModel: (model: MockMonacoModel) => void;
};

function createMockModel(options: { languageId?: string; content?: string; uri?: string }): {
  model: MockMonacoModel;
  fireContentChange: () => void;
} {
  const contentChangeListeners: MockModelListener[] = [];
  let currentContent = options.content ?? '';
  let versionId = 1;

  const model: MockMonacoModel = {
    getLanguageId: () => options.languageId ?? 'typescript',
    getValue: () => currentContent,
    getVersionId: () => versionId,
    uri: { toString: () => options.uri ?? 'file:///main.ts', path: options.uri ?? '/main.ts' },
    onDidChangeContent: vi.fn((listener: MockModelListener) => {
      contentChangeListeners.push(listener);
      return createMockDisposable();
    }),
    _setContent(newContent: string): void {
      currentContent = newContent;
      versionId++;
    },
  };

  return {
    model,
    fireContentChange(): void {
      for (const listener of contentChangeListeners) {
        listener();
      }
    },
  };
}

type ModelCreateListener = (model: MockMonacoModel) => void;
type ModelDisposeListener = (model: MockMonacoModel) => void;

function createMockMonaco(): {
  monaco: typeof Monaco & MockMonaco;
  fireModelCreate: (model: MockMonacoModel) => void;
  fireModelDispose: (model: MockMonacoModel) => void;
} {
  const models: MockMonacoModel[] = [];
  const modelCreateListeners: ModelCreateListener[] = [];
  const modelDisposeListeners: ModelDisposeListener[] = [];

  const tsDefaults: MockDefaults = {
    addExtraLib: vi.fn(() => createMockDisposable()),
    setCompilerOptions: vi.fn(),
    setEagerModelSync: vi.fn(),
  };
  const jsDefaults: MockDefaults = {
    addExtraLib: vi.fn(() => createMockDisposable()),
    setCompilerOptions: vi.fn(),
    setEagerModelSync: vi.fn(),
  };

  const monaco: MockMonaco = {
    typescript: {
      typescriptDefaults: tsDefaults,
      javascriptDefaults: jsDefaults,
      ModuleResolutionKind: { NodeJs: 2 },
      ScriptTarget: { ESNext: 99 },
      ModuleKind: { ESNext: 99 },
    },
    editor: {
      getModels: () => [...models],
      getModel: vi.fn(),
      onDidCreateModel: vi.fn((listener: ModelCreateListener) => {
        modelCreateListeners.push(listener);
        return createMockDisposable();
      }),
      onWillDisposeModel: vi.fn((listener: ModelDisposeListener) => {
        modelDisposeListeners.push(listener);
        return createMockDisposable();
      }),
    },
    Uri: {
      file: (path: string) => ({ toString: () => `file://${path}`, path }),
    },
    _addModel(model: MockMonacoModel): void {
      models.push(model);
    },
  };

  return {
    monaco: monaco as unknown as typeof Monaco & MockMonaco,
    fireModelCreate(model: MockMonacoModel): void {
      for (const listener of modelCreateListeners) {
        listener(model);
      }
    },
    fireModelDispose(model: MockMonacoModel): void {
      for (const listener of modelDisposeListeners) {
        listener(model);
      }
    },
  };
}

// =============================================================================
// Mock es-module-lexer
// =============================================================================

// Mock the entire module to avoid WASM initialization in tests
vi.mock('es-module-lexer', () => {
  let initialized = false;
  return {
    // oxlint-disable-next-line promise/prefer-await-to-then -- test setup
    init: Promise.resolve().then(() => {
      initialized = true;
    }),
    parse(code: string): [Array<{ n: string; s: number; e: number; ss: number; se: number; d: number }>] {
      if (!initialized) {
        throw new Error('es-module-lexer not initialized');
      }

      // Simple regex-based import parser for tests
      const imports: Array<{ n: string; s: number; e: number; ss: number; se: number; d: number }> = [];
      const importRegex = /import\s+(?:.*?\s+from\s+)?["']([^"']+)["']/g;
      let match;

      while ((match = importRegex.exec(code)) !== null) {
        const specifier = match[1]!;
        const specifierStart = match.index + match[0].indexOf(specifier);
        imports.push({
          n: specifier,
          s: specifierStart,
          e: specifierStart + specifier.length,
          ss: match.index,
          se: match.index + match[0].length,
          d: -1,
        });
      }

      return [imports];
    },
  };
});

// =============================================================================
// Test setup
// =============================================================================

const staticReplicad: StaticTypeDefinition = {
  packageName: 'replicad',
  content: 'export function draw(): void;',
};

const staticJscad: StaticTypeDefinition = {
  packageName: '@jscad/modeling',
  content: 'export function cube(): void;',
};

// =============================================================================
// Tests
// =============================================================================

describe('TypeAcquisitionService', () => {
  let service: TypeAcquisitionService;
  let mockMonaco: ReturnType<typeof createMockMonaco>;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new TypeAcquisitionService();
    mockMonaco = createMockMonaco();
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
      setTimeout(callback, 0);
      return 0;
    });
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Static type registration
  // =========================================================================

  describe('static type registration', () => {
    it('should register static types via addExtraLib on both defaults', () => {
      service.initialize(mockMonaco.monaco, {
        staticTypes: [staticReplicad, staticJscad],
      });

      const tsDefaults = mockMonaco.monaco.typescript.typescriptDefaults;
      const jsDefaults = mockMonaco.monaco.typescript.javascriptDefaults;

      // Each static type should be registered on both TS and JS defaults
      expect(tsDefaults.addExtraLib).toHaveBeenCalledTimes(2);
      expect(jsDefaults.addExtraLib).toHaveBeenCalledTimes(2);
    });

    it('should wrap content in declare module format', () => {
      service.initialize(mockMonaco.monaco, {
        staticTypes: [staticReplicad],
      });

      const tsDefaults = mockMonaco.monaco.typescript.typescriptDefaults;
      const call = tsDefaults.addExtraLib.mock.calls[0]!;
      const content = call[0] as string;

      expect(content).toContain("declare module 'replicad'");
      expect(content).toContain('export function draw(): void;');
    });

    it('should use correct filePath format', () => {
      service.initialize(mockMonaco.monaco, {
        staticTypes: [staticReplicad],
      });

      const tsDefaults = mockMonaco.monaco.typescript.typescriptDefaults;
      const call = tsDefaults.addExtraLib.mock.calls[0]!;
      const filePath = call[1] as string;

      expect(filePath).toBe('file:///node_modules/replicad/index.d.ts');
    });

    it('should handle scoped package names in filePath', () => {
      service.initialize(mockMonaco.monaco, {
        staticTypes: [staticJscad],
      });

      const tsDefaults = mockMonaco.monaco.typescript.typescriptDefaults;
      const call = tsDefaults.addExtraLib.mock.calls[0]!;
      const filePath = call[1] as string;

      expect(filePath).toBe('file:///node_modules/@jscad/modeling/index.d.ts');
    });

    it('should not re-fetch static types dynamically', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
      });
      vi.stubGlobal('fetch', mockFetch);

      service.initialize(mockMonaco.monaco, {
        staticTypes: [staticReplicad],
      });

      const { model, fireContentChange } = createMockModel({
        content: "import { draw } from 'replicad';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();

      // Trigger content change and debounce
      fireContentChange();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      // Fetch should NOT have been called for replicad (it's static)
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Dynamic type watching
  // =========================================================================

  describe('dynamic type watching', () => {
    beforeEach(() => {
      service.initialize(mockMonaco.monaco, { staticTypes: [staticReplicad] });
      vi.stubGlobal('fetch', vi.fn());
    });

    it('should attach content listeners to existing JS/TS models on startWatching', () => {
      const { model } = createMockModel({ languageId: 'typescript' });
      mockMonaco.monaco._addModel(model);

      service.startWatching();

      expect(model.onDidChangeContent).toHaveBeenCalledOnce();
    });

    it('should attach content listeners to newly created models', () => {
      service.startWatching();

      const { model } = createMockModel({ languageId: 'javascript' });
      mockMonaco.fireModelCreate(model);

      expect(model.onDidChangeContent).toHaveBeenCalledOnce();
    });

    it('should detach listeners on model dispose', () => {
      const { model } = createMockModel({ languageId: 'typescript' });
      mockMonaco.monaco._addModel(model);

      service.startWatching();

      const disposable = model.onDidChangeContent.mock.results[0]!.value as MockDisposable;

      mockMonaco.fireModelDispose(model);

      expect(disposable.dispose).toHaveBeenCalledOnce();
    });

    it('should ignore non-JS/TS models', () => {
      const { model: jsonModel } = createMockModel({ languageId: 'json' });
      const { model: kclModel } = createMockModel({ languageId: 'kcl' });

      mockMonaco.monaco._addModel(jsonModel);
      mockMonaco.monaco._addModel(kclModel);

      service.startWatching();

      expect(jsonModel.onDidChangeContent).not.toHaveBeenCalled();
      expect(kclModel.onDidChangeContent).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Debounce behavior
  // =========================================================================

  describe('debounce behavior', () => {
    beforeEach(() => {
      service.initialize(mockMonaco.monaco, { staticTypes: [] });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: { get: () => null },
        }),
      );
    });

    it('should debounce content changes at 500ms', () => {
      const { model, fireContentChange } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();

      // Fire content change
      fireContentChange();

      // Fetch should not be called yet (within debounce window)
      vi.advanceTimersByTime(200);
      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();

      // After 500ms debounce, scan should trigger
      vi.advanceTimersByTime(400);
      // Note: scan is async but fetch should be called
    });

    it('should reset debounce on rapid changes', () => {
      const { model, fireContentChange } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();

      // Rapid changes
      fireContentChange();
      vi.advanceTimersByTime(300);
      fireContentChange();
      vi.advanceTimersByTime(300);
      fireContentChange();

      // Only 300ms after last change, should not have triggered scan
      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Import scanning and dedup
  // =========================================================================

  describe('import scanning', () => {
    beforeEach(() => {
      service.initialize(mockMonaco.monaco, { staticTypes: [staticReplicad] });
    });

    it('should extract package name from subpath imports', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
      });
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content: "import debounce from 'lodash/debounce';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      // Should fetch 'lodash' not 'lodash/debounce'
      expect(mockFetch).toHaveBeenCalledWith(
        'https://esm.sh/lodash',
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expected AbortSignal
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('should handle scoped package subpaths', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
      });
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content: "import booleans from '@jscad/modeling/booleans';",
      });
      // Note: @jscad/modeling is NOT in static types for this test
      service.dispose();
      service = new TypeAcquisitionService();
      service.initialize(mockMonaco.monaco, { staticTypes: [] });

      mockMonaco.monaco._addModel(model);
      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://esm.sh/@jscad/modeling',
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expected AbortSignal
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('should skip relative imports', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content: "import { helper } from './utils';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip already-acquired types', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
      });
      vi.stubGlobal('fetch', mockFetch);

      const { model, fireContentChange } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();

      // First scan
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Trigger another scan
      mockFetch.mockClear();
      fireContentChange();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      // Should NOT fetch again (already acquired)
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should dedup in-flight fetch requests', async () => {
      let resolveFirst: (() => void) | undefined;
      const mockFetch = vi.fn().mockImplementation(
        async () =>
          new Promise<{ ok: boolean; headers: { get: () => undefined } }>((resolve) => {
            resolveFirst = () => {
              resolve({ ok: true, headers: { get: () => undefined } });
            };
          }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const { model: model1 } = createMockModel({
        content: "import lodash from 'lodash';",
        uri: 'file:///a.ts',
      });
      const { model: model2 } = createMockModel({
        content: "import lodash from 'lodash';",
        uri: 'file:///b.ts',
      });
      mockMonaco.monaco._addModel(model1);
      mockMonaco.monaco._addModel(model2);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      // Both models import lodash, but fetch should only be called once
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Resolve to clean up
      resolveFirst?.();
    });
  });

  // =========================================================================
  // CDN fetching
  // =========================================================================

  describe('CDN fetching', () => {
    beforeEach(() => {
      service.initialize(mockMonaco.monaco, { staticTypes: [] });
    });

    it('should fetch from esm.sh without version', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (header: string) => (header === 'X-TypeScript-Types' ? '/v135/lodash@4.17.21/index.d.ts' : null),
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => 'export function debounce(): void;',
        });
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://esm.sh/lodash',
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expected AbortSignal
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('should fetch types from X-TypeScript-Types header URL', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (header: string) => (header === 'X-TypeScript-Types' ? '/v135/lodash@4.17.21/index.d.ts' : null),
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => 'export function debounce(): void;',
        });
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      // Second fetch should be the types URL
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://esm.sh/v135/lodash@4.17.21/index.d.ts',
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expected AbortSignal
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('should inject types via addExtraLib on both defaults', async () => {
      const typesContent = 'export function debounce(): void;';
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (header: string) => (header === 'X-TypeScript-Types' ? 'https://esm.sh/types/lodash.d.ts' : null),
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => typesContent,
        });
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(50);

      const tsDefaults = mockMonaco.monaco.typescript.typescriptDefaults;
      const jsDefaults = mockMonaco.monaco.typescript.javascriptDefaults;

      // Should inject on both defaults
      expect(tsDefaults.addExtraLib).toHaveBeenCalledWith(
        expect.stringContaining("declare module 'lodash'"),
        'file:///node_modules/lodash/index.d.ts',
      );
      expect(jsDefaults.addExtraLib).toHaveBeenCalledWith(
        expect.stringContaining("declare module 'lodash'"),
        'file:///node_modules/lodash/index.d.ts',
      );
    });

    it('should use cached types on subsequent sessions', async () => {
      const typesContent = 'export function debounce(): void;';
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (header: string) => (header === 'X-TypeScript-Types' ? 'https://esm.sh/types/lodash.d.ts' : null),
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => typesContent,
        });
      vi.stubGlobal('fetch', mockFetch);

      const { model, fireContentChange } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(50);

      // Verify initial fetch happened
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Session change
      mockFetch.mockClear();
      service.onBuildSessionChange();

      // Re-trigger scan
      vi.advanceTimersByTime(100); // RequestIdleCallback deferred
      fireContentChange();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(50);

      // Should NOT fetch again (cached)
      expect(mockFetch).not.toHaveBeenCalled();

      // But should re-inject via addExtraLib
      const tsDefaults = mockMonaco.monaco.typescript.typescriptDefaults;
      expect(tsDefaults.addExtraLib).toHaveBeenCalledWith(
        expect.stringContaining("declare module 'lodash'"),
        'file:///node_modules/lodash/index.d.ts',
      );
    });
  });

  // =========================================================================
  // Epoch / session safety
  // =========================================================================

  describe('epoch / session safety', () => {
    beforeEach(() => {
      service.initialize(mockMonaco.monaco, { staticTypes: [staticReplicad] });
    });

    it('should discard in-flight fetches when session changes', async () => {
      let resolveFetch: ((value: unknown) => void) | undefined;
      const mockFetch = vi.fn().mockImplementation(
        async () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      // Fetch is in-flight
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Change session
      service.onBuildSessionChange();

      // Resolve the stale fetch
      resolveFetch?.({
        ok: true,
        headers: { get: (header: string) => (header === 'X-TypeScript-Types' ? 'https://esm.sh/types.d.ts' : null) },
      });
      await vi.advanceTimersByTimeAsync(10);

      // Types should NOT have been injected (epoch mismatch)
      const tsDefaults = mockMonaco.monaco.typescript.typescriptDefaults;
      // Only the static replicad type should be registered, not lodash
      expect(tsDefaults.addExtraLib).toHaveBeenCalledTimes(1); // Only replicad static
    });

    it('should dispose dynamic types on session change', async () => {
      const typesContent = 'export function debounce(): void;';
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: (header: string) => (header === 'X-TypeScript-Types' ? 'https://esm.sh/types.d.ts' : null) },
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => typesContent,
        });
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(50);

      // Get the disposables created for lodash
      const tsDisposable = mockMonaco.monaco.typescript.typescriptDefaults.addExtraLib.mock.results[1]!
        .value as MockDisposable;
      const jsDisposable = mockMonaco.monaco.typescript.javascriptDefaults.addExtraLib.mock.results[1]!
        .value as MockDisposable;

      // Session change
      service.onBuildSessionChange();

      expect(tsDisposable.dispose).toHaveBeenCalled();
      expect(jsDisposable.dispose).toHaveBeenCalled();
    });

    it('should keep static types across session changes', () => {
      const tsDisposable = mockMonaco.monaco.typescript.typescriptDefaults.addExtraLib.mock.results[0]!
        .value as MockDisposable;

      service.onBuildSessionChange();

      // Static type disposable should NOT be disposed
      expect(tsDisposable.dispose).not.toHaveBeenCalled();
    });

    it('should pass AbortController signal to all fetch calls', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
      });
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expected AbortSignal
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  // =========================================================================
  // Retry and backoff
  // =========================================================================

  describe('retry and backoff', () => {
    beforeEach(() => {
      service.initialize(mockMonaco.monaco, { staticTypes: [] });
    });

    it('should track failed packages with timestamp', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.stubGlobal('fetch', mockFetch);

      const { model, fireContentChange } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      // First attempt should have happened
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Trigger another scan immediately
      mockFetch.mockClear();
      fireContentChange();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      // Should NOT retry (within 60s window)
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should allow retry after RETRY_DELAY_MS', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => null },
        });
      vi.stubGlobal('fetch', mockFetch);

      const { model, fireContentChange } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      // Trigger session change to reset acquiredTypes (failed packages are added to acquiredTypes)
      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Session change to clear acquiredTypes (but failedPackages timestamp remains)
      mockFetch.mockClear();
      service.onBuildSessionChange();

      // Advance past retry delay
      vi.advanceTimersByTime(61_000);
      fireContentChange();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      // FailedPackages was cleared by onBuildSessionChange, so it should retry
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Offline / CDN failure
  // =========================================================================

  describe('offline / CDN failure', () => {
    beforeEach(() => {
      service.initialize(mockMonaco.monaco, { staticTypes: [staticReplicad] });
    });

    it('should not throw on fetch errors', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      // Should not throw
      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);
    });

    it('should handle 404 responses gracefully', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: { get: () => null },
      });
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content: "import nonexistent from 'nonexistent-pkg';",
      });
      mockMonaco.monaco._addModel(model);

      // Should not throw
      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);
    });

    it('should handle missing X-TypeScript-Types header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
      });
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content: "import pkg from 'no-types-pkg';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      // Only one fetch (module itself), no types fetch
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should keep static types available when offline', () => {
      // Static types are injected during initialize, before any network calls
      const tsDefaults = mockMonaco.monaco.typescript.typescriptDefaults;
      expect(tsDefaults.addExtraLib).toHaveBeenCalledWith(
        expect.stringContaining("declare module 'replicad'"),
        'file:///node_modules/replicad/index.d.ts',
      );
    });

    it('should handle AbortError silently without recording failure', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      const mockFetch = vi.fn().mockRejectedValue(abortError);
      vi.stubGlobal('fetch', mockFetch);

      const { model, fireContentChange } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      // Session change to clear state
      mockFetch.mockClear();
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => null },
      });
      service.onBuildSessionChange();

      // Retry should work immediately (AbortError doesn't count as failure)
      fireContentChange();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      expect(mockFetch).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // CDN URL type acquisition
  // =========================================================================

  describe('CDN URL type acquisition', () => {
    beforeEach(() => {
      service.initialize(mockMonaco.monaco, { staticTypes: [staticReplicad] });
    });

    it('should acquire types for jsdelivr CDN URL imports', async () => {
      const typesContent = 'export function drawSVG(): void;';
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (header: string) =>
              header === 'X-TypeScript-Types' ? '/v135/replicad-decorate@1.0.0/index.d.ts' : null,
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => typesContent,
        });
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content:
          "import { drawSVG } from 'https://cdn.jsdelivr.net/npm/replicad-decorate/dist/studio/replicad-decorate.js';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(50);

      // Should have fetched types for the package
      expect(mockFetch).toHaveBeenCalledWith(
        'https://esm.sh/replicad-decorate',
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expected AbortSignal
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('should inject types under the CDN URL module specifier', async () => {
      const typesContent = 'export function drawSVG(): void;';
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (header: string) =>
              header === 'X-TypeScript-Types' ? 'https://esm.sh/types/replicad-decorate.d.ts' : null,
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => typesContent,
        });
      vi.stubGlobal('fetch', mockFetch);

      const cdnUrl = 'https://cdn.jsdelivr.net/npm/replicad-decorate/dist/studio/replicad-decorate.js';
      const { model } = createMockModel({
        content: `import { drawSVG } from '${cdnUrl}';`,
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(50);

      const tsDefaults = mockMonaco.monaco.typescript.typescriptDefaults;

      // Should inject types under the CDN URL module specifier
      expect(tsDefaults.addExtraLib).toHaveBeenCalledWith(
        expect.stringContaining(`declare module '${cdnUrl}'`),
        expect.any(String),
      );
    });

    it('should also inject types under the package name for CDN URL imports', async () => {
      const typesContent = 'export function drawSVG(): void;';
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (header: string) =>
              header === 'X-TypeScript-Types' ? 'https://esm.sh/types/replicad-decorate.d.ts' : null,
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => typesContent,
        });
      vi.stubGlobal('fetch', mockFetch);

      const cdnUrl = 'https://cdn.jsdelivr.net/npm/replicad-decorate/dist/studio/replicad-decorate.js';
      const { model } = createMockModel({
        content: `import { drawSVG } from '${cdnUrl}';`,
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(50);

      const tsDefaults = mockMonaco.monaco.typescript.typescriptDefaults;

      // Should also inject under the bare package name
      expect(tsDefaults.addExtraLib).toHaveBeenCalledWith(
        expect.stringContaining("declare module 'replicad-decorate'"),
        'file:///node_modules/replicad-decorate/index.d.ts',
      );
    });

    it('should only fetch once for multiple CDN URLs of the same package', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
      });
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content: [
          "import { drawSVG } from 'https://cdn.jsdelivr.net/npm/replicad-decorate/dist/studio/replicad-decorate.js';",
          "import { otherFunc } from 'https://esm.sh/replicad-decorate';",
        ].join('\n'),
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(50);

      // Should only fetch once for replicad-decorate
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://esm.sh/replicad-decorate',
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expected AbortSignal
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('should handle scoped packages in CDN URLs', async () => {
      // Use a fresh service without @jscad/modeling in static types
      service.dispose();
      service = new TypeAcquisitionService();
      service.initialize(mockMonaco.monaco, { staticTypes: [] });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
      });
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content: "import booleans from 'https://cdn.jsdelivr.net/npm/@jscad/modeling@2.12.6/booleans';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(50);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://esm.sh/@jscad/modeling',
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expected AbortSignal
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('should skip non-CDN URL imports', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const { model } = createMockModel({
        content: "import { helper } from 'https://example.com/not-a-cdn/module.js';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should not re-fetch CDN package if already acquired via bare import', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
      });
      vi.stubGlobal('fetch', mockFetch);

      // First: bare import acquires the package
      const { model, fireContentChange } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Then: CDN URL import for same package
      mockFetch.mockClear();
      model._setContent("import lodash from 'https://cdn.jsdelivr.net/npm/lodash';");
      fireContentChange();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(10);

      // Should NOT fetch again
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should clear CDN URL aliases on session change', async () => {
      const typesContent = 'export function drawSVG(): void;';
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (header: string) =>
              header === 'X-TypeScript-Types' ? 'https://esm.sh/types/replicad-decorate.d.ts' : null,
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => typesContent,
        });
      vi.stubGlobal('fetch', mockFetch);

      const cdnUrl = 'https://cdn.jsdelivr.net/npm/replicad-decorate/dist/studio/replicad-decorate.js';
      const { model } = createMockModel({
        content: `import { drawSVG } from '${cdnUrl}';`,
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(50);

      // Get the CDN URL alias disposable (injected after the package name + static replicad)
      const tsDefaults = mockMonaco.monaco.typescript.typescriptDefaults;
      const cdnUrlCall = tsDefaults.addExtraLib.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes(`declare module '${cdnUrl}'`),
      );
      expect(cdnUrlCall).toBeDefined();

      // Session change should dispose CDN alias libs
      service.onBuildSessionChange();

      // The CDN URL lib disposable should have been disposed
      const cdnUrlCallIndex = tsDefaults.addExtraLib.mock.calls.indexOf(cdnUrlCall!);
      const cdnUrlDisposable = tsDefaults.addExtraLib.mock.results[cdnUrlCallIndex]!.value as MockDisposable;
      expect(cdnUrlDisposable.dispose).toHaveBeenCalled();
    });

    it('should acquire types for Skypack CDN URL imports', async () => {
      const typesContent = 'export function qrcode(): void;';
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (header: string) =>
              header === 'X-TypeScript-Types' ? '/v135/qrcode-generator@2.0.4/index.d.ts' : null,
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => typesContent,
        });
      vi.stubGlobal('fetch', mockFetch);

      const skypackUrl = 'https://cdn.skypack.dev/qrcode-generator@2.0.4';
      const { model } = createMockModel({
        content: `import { qrcode } from '${skypackUrl}';`,
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(50);

      // Should have fetched types for the package via esm.sh
      expect(mockFetch).toHaveBeenCalledWith(
        'https://esm.sh/qrcode-generator',
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expected AbortSignal
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      const tsDefaults = mockMonaco.monaco.typescript.typescriptDefaults;

      // Should inject types under the Skypack CDN URL module specifier
      expect(tsDefaults.addExtraLib).toHaveBeenCalledWith(
        expect.stringContaining(`declare module '${skypackUrl}'`),
        expect.any(String),
      );

      // Should also inject types under the bare package name
      expect(tsDefaults.addExtraLib).toHaveBeenCalledWith(
        expect.stringContaining("declare module 'qrcode-generator'"),
        'file:///node_modules/qrcode-generator/index.d.ts',
      );
    });
  });

  // =========================================================================
  // Disposal
  // =========================================================================

  describe('disposal', () => {
    it('should dispose all static type libs', () => {
      service.initialize(mockMonaco.monaco, {
        staticTypes: [staticReplicad, staticJscad],
      });

      const disposables = [
        ...mockMonaco.monaco.typescript.typescriptDefaults.addExtraLib.mock.results,
        ...mockMonaco.monaco.typescript.javascriptDefaults.addExtraLib.mock.results,
      ].map((r) => r.value as MockDisposable);

      service.dispose();

      for (const disposable of disposables) {
        expect(disposable.dispose).toHaveBeenCalled();
      }
    });

    it('should detach all model listeners', () => {
      service.initialize(mockMonaco.monaco, { staticTypes: [] });

      const { model } = createMockModel({ languageId: 'typescript' });
      mockMonaco.monaco._addModel(model);

      service.startWatching();

      const listenerDisposable = model.onDidChangeContent.mock.results[0]!.value as MockDisposable;

      service.dispose();

      expect(listenerDisposable.dispose).toHaveBeenCalled();
    });

    it('should dispose global model create/dispose listeners', () => {
      service.initialize(mockMonaco.monaco, { staticTypes: [] });
      service.startWatching();

      const createDisposable = mockMonaco.monaco.editor.onDidCreateModel.mock.results[0]!.value as MockDisposable;
      const disposeDisposable = mockMonaco.monaco.editor.onWillDisposeModel.mock.results[0]!.value as MockDisposable;

      service.dispose();

      expect(createDisposable.dispose).toHaveBeenCalled();
      expect(disposeDisposable.dispose).toHaveBeenCalled();
    });

    it('should clear debounce timers', () => {
      service.initialize(mockMonaco.monaco, { staticTypes: [] });
      vi.stubGlobal('fetch', vi.fn());

      const { model, fireContentChange } = createMockModel({
        content: "import lodash from 'lodash';",
      });
      mockMonaco.monaco._addModel(model);

      service.startWatching();
      fireContentChange(); // Start debounce timer

      // Dispose before timer fires
      service.dispose();

      // Advance past debounce -- should not trigger errors
      vi.advanceTimersByTime(1000);
    });
  });
});
