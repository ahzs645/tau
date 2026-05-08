import { describe, it, expect, vi, afterEach } from 'vitest';
import * as monaco from 'monaco-editor';
import { createMonacoWorkspaceFs } from '#lib/monaco-workspace-fs/monaco-workspace-fs.js';
import { createInMemoryFileSystemProvider } from '#lib/monaco-workspace-fs/in-memory-file-system-provider.js';

import { drainMonacoPostTestWork } from '#lib/testing/monaco-async-drain.js';

describe('MonacoWorkspaceFs', () => {
  afterEach(async () => {
    for (const model of monaco.editor.getModels()) {
      model.dispose();
    }
    await drainMonacoPostTestWork();
  });

  it('throws on duplicate file-system scheme registration', () => {
    const fs = createMonacoWorkspaceFs(monaco);
    const p = createInMemoryFileSystemProvider(monaco, 'dup');
    fs.registerFileSystemProvider(p);
    expect(() => fs.registerFileSystemProvider(p)).toThrow(/duplicate file-system scheme/);
    fs.dispose();
  });

  it('prefers file-system provider over content provider for the same scheme (R14 order)', async () => {
    const registry = createMonacoWorkspaceFs(monaco);
    const fsReads: string[] = [];
    const contentReads: string[] = [];

    registry.registerTextDocumentContentProvider({
      scheme: 'tau-test',
      provideTextDocumentContent(uri: monaco.Uri): Promise<string> {
        contentReads.push(uri.path);
        return Promise.resolve('from-content');
      },
    });

    registry.registerFileSystemProvider({
      scheme: 'tau-test',
      readText(uri: monaco.Uri): Promise<string> {
        fsReads.push(uri.path);
        return Promise.resolve('from-fs');
      },
      onDidChange(): monaco.IDisposable {
        return { dispose(): void {} };
      },
    });

    const uri = monaco.Uri.parse('tau-test:/x.txt');
    const model = await registry.openTextDocument(uri);
    expect(model?.getValue()).toBe('from-fs');
    expect(fsReads).toEqual(['/x.txt']);
    expect(contentReads).toHaveLength(0);
    registry.dispose();
  });

  it('falls back to content provider when file-system provider is removed', async () => {
    const registry = createMonacoWorkspaceFs(monaco);

    registry.registerTextDocumentContentProvider({
      scheme: 'tau-test',
      provideTextDocumentContent(): Promise<string> {
        return Promise.resolve('from-content');
      },
    });

    const disposable = registry.registerFileSystemProvider({
      scheme: 'tau-test',
      readText(): Promise<string> {
        return Promise.resolve('from-fs');
      },
      onDidChange(): monaco.IDisposable {
        return { dispose(): void {} };
      },
    });

    const uri = monaco.Uri.parse('tau-test:/y.txt');
    disposable.dispose();
    const model = await registry.openTextDocument(uri);
    expect(model?.getValue()).toBe('from-content');
    registry.dispose();
  });

  it('findFiles merges from providers respecting maxResults', async () => {
    const registry = createMonacoWorkspaceFs(monaco);
    registry.registerFileSystemProvider({
      scheme: 'a',
      readText(): Promise<string> {
        return Promise.resolve('');
      },
      onDidChange(): monaco.IDisposable {
        return { dispose(): void {} };
      },
      findFiles(_pattern, opts) {
        const n = opts?.maxResults ?? 10;
        return Array.from({ length: n }, (_, i) => monaco.Uri.parse(`a:/f${i}.txt`));
      },
    });
    registry.registerFileSystemProvider({
      scheme: 'b',
      readText(): Promise<string> {
        return Promise.resolve('');
      },
      onDidChange(): monaco.IDisposable {
        return { dispose(): void {} };
      },
      findFiles(_pattern, opts) {
        const n = opts?.maxResults ?? 10;
        return Array.from({ length: n }, (_, i) => monaco.Uri.parse(`b:/g${i}.txt`));
      },
    });

    const found = await registry.findFiles('*', { maxResults: 3 });
    expect(found).toHaveLength(3);
    expect(found[0]!.scheme).toBe('a');
    expect(found[1]!.scheme).toBe('a');
    expect(found[2]!.scheme).toBe('a');
    registry.dispose();
  });

  it('routes onDidChange from FS provider to refreshContent', async () => {
    const registry = createMonacoWorkspaceFs(monaco);
    const refresh = vi.fn(async () => undefined);
    registry.bindModelService({ refreshContent: refresh });

    let fire!: () => void;
    registry.registerFileSystemProvider({
      scheme: 'chg',
      readText(): Promise<string> {
        return Promise.resolve('v1');
      },
      onDidChange(_uri: monaco.Uri, listener: () => void): monaco.IDisposable {
        fire = listener;
        return { dispose(): void {} };
      },
    });

    const uri = monaco.Uri.parse('chg:/doc.txt');
    await registry.openTextDocument(uri);
    fire!();
    expect(refresh).toHaveBeenCalledWith(uri);
    registry.dispose();
  });
});
