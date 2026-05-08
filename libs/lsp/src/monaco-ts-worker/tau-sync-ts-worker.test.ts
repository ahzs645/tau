import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncFsClient } from '@taucad/lsp-fs/sync';

const hoisted = vi.hoisted(() => ({
  scriptTextByFile: new Map<string, string | undefined>(),
}));

vi.mock('monaco-editor/esm/vs/language/typescript/ts.worker.js', () => ({
  TypeScriptWorker: class TypeScriptWorker {
    public _getScriptText(fileName: string): string | undefined {
      return hoisted.scriptTextByFile.get(fileName);
    }

    public getScriptVersion(_fileName: string): string {
      return '';
    }
  },
}));

import { TauSyncTsWorker } from '#monaco-ts-worker/tau-sync-ts-worker.js';

function createSyncFsMock(): SyncFsClient {
  return {
    readFileText: vi.fn(),
    fileExists: vi.fn(),
    directoryExists: vi.fn(() => false),
    getDirectories: vi.fn(() => []),
    getScriptVersionForPath: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('TauSyncTsWorker', () => {
  beforeEach(() => {
    hoisted.scriptTextByFile.clear();
    vi.clearAllMocks();
  });

  it('getScriptVersion returns 1 for libFileMap-style files when base version is empty', () => {
    hoisted.scriptTextByFile.set('lib.es2015.d.ts', '// lib');
    const syncFs = createSyncFsMock();
    const worker = new TauSyncTsWorker(null as never, null as never, { syncFsClient: syncFs });

    expect(worker.getScriptVersion('lib.es2015.d.ts')).toBe('1');
    expect(syncFs.getScriptVersionForPath).not.toHaveBeenCalled();
  });

  it('getScriptVersion falls through to sync FS when base has no script text', () => {
    const syncFs = createSyncFsMock();
    vi.mocked(syncFs.getScriptVersionForPath).mockReturnValue('42');
    const worker = new TauSyncTsWorker(null as never, null as never, { syncFsClient: syncFs });

    expect(worker.getScriptVersion('file:///lib/a.ts')).toBe('42');
    expect(syncFs.getScriptVersionForPath).toHaveBeenCalledWith('file:///lib/a.ts');
  });

  it('directoryExists returns true for node_modules basename without sync FS', () => {
    const syncFs = createSyncFsMock();
    const worker = new TauSyncTsWorker(null as never, null as never, { syncFsClient: syncFs });

    expect(worker.directoryExists('file:///node_modules')).toBe(true);
    expect(syncFs.directoryExists).not.toHaveBeenCalled();
  });

  it('directoryExists returns true when an extraLib path is under the directory', () => {
    const syncFs = createSyncFsMock();
    const worker = new TauSyncTsWorker(null as never, null as never, { syncFsClient: syncFs });
    Object.assign(worker as unknown as { _extraLibs: Record<string, unknown> }, {
      _extraLibs: {
        'file:///node_modules/replicad/index.d.ts': { version: 1, content: '' },
      },
    });

    expect(worker.directoryExists('file:///node_modules/replicad')).toBe(true);
    expect(syncFs.directoryExists).not.toHaveBeenCalled();
  });

  it('directoryExists falls through to sync FS when no virtual directory match', () => {
    const syncFs = createSyncFsMock();
    vi.mocked(syncFs.directoryExists).mockReturnValue(true);
    const worker = new TauSyncTsWorker(null as never, null as never, { syncFsClient: syncFs });

    expect(worker.directoryExists('file:///lib')).toBe(true);
    expect(syncFs.directoryExists).toHaveBeenCalledWith('file:///lib');
  });
});
