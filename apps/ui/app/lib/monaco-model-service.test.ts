/**
 * MonacoModelService Tests – disposeAllModels scoping
 *
 * Verifies that disposeAllModels only disposes models tracked by the service
 * (editorHolds, backgroundAccessTimes, syncedPaths), leaving Monaco internals
 * (TypeScript lib files, ATA-injected type declarations, etc.) intact.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { MonacoModelService } from '#lib/monaco-model-service.js';

// =============================================================================
// Mock dependencies
// =============================================================================

vi.mock('#lib/monaco.constants.js', () => ({
  isJsLikeFile: (path: string) => /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(path),
  getMonacoLanguage(path: string) {
    if (path.endsWith('.ts') || path.endsWith('.tsx')) {
      return 'typescript';
    }

    if (path.endsWith('.js') || path.endsWith('.jsx')) {
      return 'javascript';
    }

    return undefined;
  },
}));

vi.mock('#utils/filesystem.utils.js', () => ({
  decodeTextFile: (data: Uint8Array<ArrayBuffer>) => new TextDecoder().decode(data),
}));

// =============================================================================
// Mock helpers
// =============================================================================

type MockModel = {
  uri: { toString: () => string; path: string };
  dispose: ReturnType<typeof vi.fn>;
  getValue: () => string;
  setValue: ReturnType<typeof vi.fn>;
  getFullModelRange: () => unknown;
  pushStackElement: ReturnType<typeof vi.fn>;
  pushEditOperations: ReturnType<typeof vi.fn>;
};

type MockMonaco = {
  editor: {
    getModels: () => MockModel[];
    getModel: (uri: { toString: () => string }) => MockModel | undefined;
    createModel: ReturnType<typeof vi.fn>;
    setModelMarkers: ReturnType<typeof vi.fn>;
  };
  Uri: {
    file: (path: string) => { toString: () => string; path: string };
  };
};

function createMockModel(uriPath: string, content = ''): MockModel {
  const uri = { toString: () => `file://${uriPath}`, path: uriPath };
  return {
    uri,
    dispose: vi.fn(),
    getValue: () => content,
    setValue: vi.fn(),
    getFullModelRange: () => ({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    }),
    pushStackElement: vi.fn(),
    pushEditOperations: vi.fn(),
  };
}

function createMockMonaco(): {
  monaco: typeof Monaco & MockMonaco;
  models: Map<string, MockModel>;
} {
  const models = new Map<string, MockModel>();

  const monaco: MockMonaco = {
    editor: {
      getModels: () => [...models.values()],
      getModel(uri: { toString: () => string }) {
        for (const [, model] of models) {
          if (model.uri.toString() === uri.toString()) {
            return model;
          }
        }

        return undefined;
      },
      createModel: vi.fn((content: string, _language: string, uri: { toString: () => string; path: string }) => {
        const model = createMockModel(uri.path, content);
        models.set(uri.toString(), model);
        return model;
      }),
      setModelMarkers: vi.fn(),
    },
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Monaco API uses PascalCase
    Uri: {
      file: (path: string) => ({ toString: () => `file://${path}`, path }),
    },
  };

  return { monaco: monaco as unknown as typeof Monaco & MockMonaco, models };
}

type MockFileManagerRef = {
  on: ReturnType<typeof vi.fn>;
};

type MockFileManager = {
  readFile: ReturnType<typeof vi.fn>;
  getDirectoryStat: ReturnType<typeof vi.fn>;
};

type MockMarkerService = {
  clearAll: ReturnType<typeof vi.fn>;
  removeUri: ReturnType<typeof vi.fn>;
  migrateUri: ReturnType<typeof vi.fn>;
};

function createMockFileManagerRef(): MockFileManagerRef {
  return {
    on: vi.fn(() => ({ unsubscribe: vi.fn() })),
  };
}

function createMockFileManager(): MockFileManager {
  return {
    readFile: vi.fn(async () => new TextEncoder().encode('')),
    getDirectoryStat: vi.fn(async () => []),
  };
}

function createMockMarkerService(): MockMarkerService {
  return {
    clearAll: vi.fn(),
    removeUri: vi.fn(),
    migrateUri: vi.fn(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('MonacoModelService', () => {
  let service: MonacoModelService;
  let monaco: typeof Monaco & MockMonaco;
  let models: Map<string, MockModel>;
  let fileManagerRef: MockFileManagerRef;
  let fileManager: MockFileManager;
  let markerService: MockMarkerService;

  beforeEach(() => {
    vi.useFakeTimers();

    service = new MonacoModelService();
    ({ monaco, models } = createMockMonaco());
    fileManagerRef = createMockFileManagerRef();
    fileManager = createMockFileManager();
    markerService = createMockMarkerService();

    service.initialize({
      monaco,
      fileManagerRef: fileManagerRef as never,
      fileManager: fileManager as never,
      markerService: markerService as never,
    });
  });

  describe('disposeAllModels', () => {
    it('should only dispose tracked models, not untracked ones', async () => {
      // Set up a tracked model via getOrEnsureModel
      fileManager.readFile.mockResolvedValueOnce(new TextEncoder().encode('const x = 1;'));
      await service.getOrEnsureModel('src/app.ts');

      // Manually inject an untracked model (simulates a TS lib or ATA model)
      const untrackedModel = createMockModel('/lib.es2015.d.ts', 'declare const Array: any;');
      models.set('file:///lib.es2015.d.ts', untrackedModel);

      // Verify both models exist
      expect(monaco.editor.getModels()).toHaveLength(2);

      // Trigger dispose via setBuildSession (calls disposeAllModels internally)
      service.setBuildSession('new-session');

      // The tracked model should have been disposed
      const trackedModel = models.get('file:///src/app.ts');
      expect(trackedModel?.dispose).toHaveBeenCalled();

      // The untracked model should NOT have been disposed
      expect(untrackedModel.dispose).not.toHaveBeenCalled();
    });

    it('should dispose models from editorHolds', async () => {
      // Create a model and register an editor hold
      fileManager.readFile.mockResolvedValueOnce(new TextEncoder().encode('export {};'));
      await service.getOrEnsureModel('src/editor-held.ts');
      service.registerEditorModel('src/editor-held.ts');

      const model = models.get('file:///src/editor-held.ts');

      service.setBuildSession('new-session');

      expect(model?.dispose).toHaveBeenCalled();
    });

    it('should dispose models from backgroundAccessTimes', async () => {
      // Create a model that stays as a background model
      fileManager.readFile.mockResolvedValueOnce(new TextEncoder().encode('export {};'));
      await service.getOrEnsureModel('src/background.ts');

      const model = models.get('file:///src/background.ts');

      service.setBuildSession('new-session');

      expect(model?.dispose).toHaveBeenCalled();
    });

    it('should dispose models from syncedPaths', async () => {
      // Create a model, register editor hold, then unregister it
      // After unregister it moves to backgroundAccessTimes but stays in syncedPaths
      fileManager.readFile.mockResolvedValueOnce(new TextEncoder().encode('export {};'));
      await service.getOrEnsureModel('src/synced.ts');
      service.registerEditorModel('src/synced.ts');
      service.unregisterEditorModel('src/synced.ts');

      const model = models.get('file:///src/synced.ts');

      service.setBuildSession('new-session');

      expect(model?.dispose).toHaveBeenCalled();
    });

    it('should leave TypeScript lib models intact after session change', async () => {
      // Inject multiple untracked models simulating Monaco/TS internals
      const tsLib = createMockModel('/lib.es5.d.ts', 'declare const Object: any;');
      const tsLibDom = createMockModel('/lib.dom.d.ts', 'declare const document: any;');
      const ataModel = createMockModel('/node_modules/@types/react/index.d.ts', 'declare namespace React {}');
      models.set('file:///lib.es5.d.ts', tsLib);
      models.set('file:///lib.dom.d.ts', tsLibDom);
      models.set('file:///node_modules/@types/react/index.d.ts', ataModel);

      // Also create a tracked model
      fileManager.readFile.mockResolvedValueOnce(new TextEncoder().encode('const y = 2;'));
      await service.getOrEnsureModel('src/index.ts');

      service.setBuildSession('new-session');

      // None of the untracked models should be disposed
      expect(tsLib.dispose).not.toHaveBeenCalled();
      expect(tsLibDom.dispose).not.toHaveBeenCalled();
      expect(ataModel.dispose).not.toHaveBeenCalled();

      // The tracked model should be disposed
      const trackedModel = models.get('file:///src/index.ts');
      expect(trackedModel?.dispose).toHaveBeenCalled();
    });

    it('should leave untracked models intact after full dispose', async () => {
      // Inject an untracked model
      const untrackedModel = createMockModel('/lib.es2020.d.ts', 'declare const BigInt: any;');
      models.set('file:///lib.es2020.d.ts', untrackedModel);

      // Create a tracked model
      fileManager.readFile.mockResolvedValueOnce(new TextEncoder().encode('const z = 3;'));
      await service.getOrEnsureModel('src/main.ts');

      const trackedModel = models.get('file:///src/main.ts');

      // Full service dispose
      service.dispose();

      expect(trackedModel?.dispose).toHaveBeenCalled();
      expect(untrackedModel.dispose).not.toHaveBeenCalled();
    });

    it('should handle empty tracking sets gracefully', () => {
      // Inject untracked models but don't create any tracked models
      const libModel = createMockModel('/lib.d.ts', '');
      models.set('file:///lib.d.ts', libModel);

      // Should not throw and should not dispose the untracked model
      service.setBuildSession('new-session');

      expect(libModel.dispose).not.toHaveBeenCalled();
    });

    it('should handle models that have already been disposed externally', async () => {
      // Create a tracked model
      fileManager.readFile.mockResolvedValueOnce(new TextEncoder().encode('export {};'));
      await service.getOrEnsureModel('src/already-gone.ts');

      // Simulate external disposal (model no longer found by getModel)
      models.delete('file:///src/already-gone.ts');

      // Should not throw when the model is not found
      expect(() => {
        service.setBuildSession('new-session');
      }).not.toThrow();
    });
  });
});
