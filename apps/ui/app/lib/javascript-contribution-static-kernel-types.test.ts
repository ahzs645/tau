/**
 * Ensures TS/JS contributions configure import-driven kernel declaration
 * loaders without touching the file-manager mount or registering every
 * declaration during language activation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivationContext } from '#lib/monaco-language-registry.js';
import type { MonacoTestStub } from '#lib/testing/monaco-language-stub.js';
import { tsContribution } from '#lib/typescript-contribution.js';
import { jsContribution } from '#lib/javascript-contribution.js';
import { LanguageContributionRegistry } from '#lib/monaco-language-registry.js';
import { TypeAcquisitionService } from '#lib/type-acquisition-service.js';
import { createMonacoTestStub } from '#lib/testing/monaco-language-stub.js';
import { attachTypescriptShim } from '#lib/testing/monaco-typescript-shim.js';

const createMockContext = (stub: MonacoTestStub): ActivationContext =>
  ({
    monaco: stub.monaco,
    fileManager: {
      readFile: vi.fn(async () => new Uint8Array()),
      exists: vi.fn(async () => false),
      readdir: vi.fn(async () => []),
      getDirectoryStat: vi.fn(),
    },
    fileManagerRef: {},
    workspaceFs: {
      registerFileSystemProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
      hasProvider: vi.fn(() => false),
      getFileSystemProvider: vi.fn(),
      getTextDocumentProvider: vi.fn(),
      openTextDocument: vi.fn(),
      openTextProvider: vi.fn(),
      peekModel: vi.fn(),
      materialiseUrisForWorkspaceEdit: vi.fn(async () => undefined),
      findFiles: vi.fn(async () => []),
      canMaterialise: vi.fn(() => false),
      bindModelService: vi.fn(),
      dispose: vi.fn(),
    },
  }) as unknown as ActivationContext;

describe.each([
  ['TypeScript', tsContribution, 'typescript'],
  ['JavaScript', jsContribution, 'javascript'],
] as const)('%s contribution kernel declarations', (_name, contribution, languageId) => {
  let stub: MonacoTestStub;
  let registry: LanguageContributionRegistry;

  beforeEach(() => {
    stub = createMonacoTestStub();
    attachTypescriptShim(stub);
    registry = new LanguageContributionRegistry();
  });

  afterEach(() => {
    registry.dispose();
    stub.__reset();
    vi.restoreAllMocks();
  });

  it('registers lazy loaders without eagerly adding kernel declarations', async () => {
    const initialize = vi.spyOn(TypeAcquisitionService.prototype, 'initialize');
    vi.spyOn(TypeAcquisitionService.prototype, 'startWatching').mockImplementation(() => undefined);

    registry.addContribution(contribution);
    registry.activate(createMockContext(stub));
    stub.__createModel(`inmemory://${languageId}/kernel`, languageId);

    await vi.waitFor(() => {
      expect(initialize).toHaveBeenCalledOnce();
    });

    const config = initialize.mock.calls[0]![1];
    expect(Object.keys(config.builtinTypeLoaders ?? {})).toEqual([
      'opencascade.js',
      'replicad',
      '@jscad/modeling',
      'manifold-3d',
    ]);
    expect(stub.monaco.typescript.typescriptDefaults.addExtraLib).not.toHaveBeenCalled();

    const replicadDefinitions = await config.builtinTypeLoaders?.['replicad']?.();
    expect(replicadDefinitions?.map((definition) => definition.packageName)).toContain('replicad');
    expect(replicadDefinitions?.[0]?.content.length).toBeGreaterThan(100);
  });
});
