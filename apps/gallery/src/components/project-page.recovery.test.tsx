// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentDigest } from '@taucad/cache-core';
import { compileParameterManifest } from '@taucad/parameters';
import type { JSONSchema7 } from '@taucad/json-schema';
import { createKernelParameterDeclaration } from '@taucad/runtime/kernel';
import { TooltipProvider } from '@taucad/ui/components/tooltip';
import type { GalleryProject, GalleryVariant } from '#catalog/types.js';
import type * as DownloadModule from '#components/download.js';
import type { GalleryParameterDescription, GalleryRenderResult, GallerySession } from '#runtime.js';
import { modelUrl, readGalleryLocation, useGalleryHref } from '#sharing/location.js';
import { ProjectPage } from '#components/project-page.jsx';

const mocks = vi.hoisted(() => ({ create: vi.fn(), loadFiles: vi.fn(), download: vi.fn() }));
vi.mock('#runtime.js', () => ({ createGallerySession: mocks.create, loadGalleryStaticArtifact: vi.fn() }));
vi.mock('#catalog/catalog.js', () => ({ loadProjectFiles: mocks.loadFiles }));
vi.mock('#components/download.js', async (importOriginal) => ({
  ...(await importOriginal<typeof DownloadModule>()),
  downloadBytes: mocks.download,
}));
vi.mock('#components/model-preview.jsx', () => ({
  ModelPreview: ({ result }: { readonly result?: GalleryRenderResult }) => (
    <div role='img' aria-label='3D model preview'>
      {result?.artifactHash ?? 'Preparing model'}
    </div>
  ),
}));
vi.mock('#components/ar-button.jsx', () => ({ ArButton: () => undefined }));
vi.mock('#components/theme.jsx', () => ({ ThemeToggle: () => undefined }));
vi.mock('#components/source-dialog.jsx', () => ({ SourceDialog: () => undefined }));
vi.mock('#components/share-dialog.jsx', () => ({ ShareDialog: () => undefined }));

// Preserve the real Customizer keys and groups in a small fixture of the keyguard's frame prerequisites.
const basicsGroup = 'Keyguard Basics';
const caseGroup = 'Tablet Case';
const frameGroup = 'Keyguard Frame Info';
const caseParameter = 'have_a_case';
const frameParameter = 'have_a_keyguard_frame';
const defaults = {
  [basicsGroup]: { generate: 'keyguard' },
  [caseGroup]: { [caseParameter]: 'yes' },
  [frameGroup]: { [frameParameter]: 'no' },
};
const failedPreset = { generate: 'keyguard frame', [caseParameter]: 'yes', [frameParameter]: 'no' };
const corrected = {
  ...defaults,
  [basicsGroup]: { generate: 'keyguard frame' },
  [frameGroup]: { [frameParameter]: 'yes' },
};
const frameError =
  'Keyguard frame output requires Have a case and Have a keyguard frame set to yes. Enable both, or choose keyguard output.';
const schema: JSONSchema7 = {
  type: 'object',
  properties: {
    [basicsGroup]: {
      type: 'object',
      properties: { generate: { type: 'string', enum: ['keyguard', 'keyguard frame'] } },
    },
    [caseGroup]: {
      type: 'object',
      properties: { [caseParameter]: { type: 'string', title: 'Have a case', enum: ['yes', 'no'] } },
    },
    [frameGroup]: {
      type: 'object',
      properties: { [frameParameter]: { type: 'string', title: 'Have a keyguard frame', enum: ['yes', 'no'] } },
    },
  },
};
const variant: GalleryVariant = {
  id: 'openscad',
  label: 'OpenSCAD',
  shortLabel: 'SCAD',
  entry: 'main.scad',
  kernel: 'openscad',
  language: 'scad',
  exportFormats: ['glb'],
};
const project: GalleryProject = {
  id: 'keyguard-with-raised-tabs',
  title: 'Customizable Keyguard',
  description: 'A keyguard frame fixture using the original parameter names and saved values.',
  tags: [],
  sourceUrl: 'https://github.com/ahzs645/tau',
  mode: 'parametric',
  hidden: false,
  defaultVariantId: 'openscad',
  variants: [variant],
  initialParameters: {},
  presets: [{ id: 'preset-2', name: 'New set 2', variantIds: ['openscad'], parameters: failedPreset }],
  uploads: [],
  filePaths: ['main.scad'],
  libraries: [],
  parityExclusions: {},
};

let parameterDescription: GalleryParameterDescription;
const rendered = (parameters: Record<string, unknown>, artifactHash: string): GalleryRenderResult => ({
  ...parameterDescription,
  artifact: { mimeType: 'model/gltf-binary', content: new Uint8Array([1]) },
  artifactHash,
  parameters,
  formats: ['glb'],
  issues: [],
});
const RoutedProject = (): React.JSX.Element => {
  const href = useGalleryHref();
  return (
    <TooltipProvider>
      <ProjectPage project={project} href={href} route={readGalleryLocation(new URL(href))} />
    </TooltipProvider>
  );
};

const domMethods = ['scrollIntoView', 'hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'] as const;
const originalMethods = new Map(
  domMethods.map((name) => [name, Object.getOwnPropertyDescriptor(Element.prototype, name)]),
);
beforeAll(async () => {
  for (const name of domMethods) {
    Object.defineProperty(Element.prototype, name, { configurable: true, value: vi.fn(() => false) });
  }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      public observe = vi.fn();
      public unobserve = vi.fn();
      public disconnect = vi.fn();
    },
  );
  const digest = contentDigest({ value: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' });
  const manifest = await compileParameterManifest({
    declaration: createKernelParameterDeclaration(defaults, schema, {
      id: 'urn:gallery:keyguard-recovery-fixture',
      name: 'KeyguardRecoveryFixture',
    }),
    scope: { kind: 'source', authority: 'filesystem', root: '/project', entry: '/project/main.scad' },
    source: { id: 'keyguard-recovery-fixture', version: '1.0.0', revision: digest, capability: 'json-structure' },
    dependency: digest,
    middleware: digest,
  });
  if (manifest.legacyProjection.status !== 'usable') {
    throw new Error('Expected an editable keyguard fixture schema.');
  }
  parameterDescription = Object.freeze({
    parameterManifest: manifest,
    jsonSchema: manifest.legacyProjection.schema,
    defaultParameters: manifest.defaults,
  });
});
afterAll(() => {
  for (const [name, descriptor] of originalMethods) {
    if (descriptor) {
      Object.defineProperty(Element.prototype, name, descriptor);
    } else {
      Reflect.deleteProperty(Element.prototype, name);
    }
  }
  vi.unstubAllGlobals();
});
beforeEach(() => {
  mocks.create.mockReset();
  mocks.loadFiles.mockReset();
  mocks.download.mockReset();
  mocks.loadFiles.mockResolvedValue({ 'main.scad': new Uint8Array([1]) });
  globalThis.history.replaceState(
    {},
    '',
    modelUrl(project.id, { base: new URL(globalThis.location.href), parameters: failedPreset }),
  );
});
afterEach(cleanup);

describe('gallery recovery from an initially failing saved preset', () => {
  it('should keep the real parameter form editable, correct a legacy flat override, and export only after recovery', async () => {
    const first = Promise.withResolvers<GalleryRenderResult>();
    const correction = Promise.withResolvers<GalleryRenderResult>();
    const client: GallerySession = {
      parameterDescription,
      render: vi
        .fn<GallerySession['render']>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(correction.promise)
        .mockResolvedValueOnce(rendered(defaults, 'default-keyguard')),
      export: vi
        .fn<GallerySession['export']>()
        .mockResolvedValue([{ name: 'frame.glb', bytes: new Uint8Array([1]), mimeType: 'model/gltf-binary' }]),
      dispose: vi.fn<GallerySession['dispose']>().mockResolvedValue(),
    };
    mocks.create.mockResolvedValue(client);
    const user = userEvent.setup();
    render(<RoutedProject />);
    const download = screen.getByRole('button', { name: /^Export$/u });
    const frame = await screen.findByRole('combobox', { name: 'Select for Have a keyguard frame' });
    expect(frame.textContent).toBe('no');
    expect(screen.queryByRole('status', { name: 'Loading model parameters' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reset parameters' })).toHaveProperty('disabled', false);
    expect(download).toHaveProperty('disabled', true);
    expect(screen.getByRole('combobox', { name: 'Preset' })).toHaveProperty('value', 'preset-2');

    await act(async () => {
      first.reject(new Error(frameError));
    });
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(frameError);
    });
    expect(frame.textContent).toBe('no');
    expect(download).toHaveProperty('disabled', true);
    fireEvent.click(download);
    expect(client.export).not.toHaveBeenCalled();

    await user.click(frame);
    await user.click(screen.getByRole('option', { name: 'yes' }));
    await waitFor(() => {
      expect(client.render).toHaveBeenCalledTimes(2);
    });
    const submitted = vi.mocked(client.render).mock.calls[1]?.[0];
    expect(submitted).toEqual(corrected);
    expect(submitted).not.toHaveProperty(frameParameter);
    expect(readGalleryLocation(new URL(globalThis.location.href)).parameters).toEqual(corrected);
    expect(download).toHaveProperty('disabled', true);
    await act(async () => {
      correction.resolve(rendered(corrected, 'enabled-frame'));
    });
    await waitFor(() => {
      expect(download).toHaveProperty('disabled', false);
      expect(screen.getByRole('img', { name: '3D model preview' }).textContent).toBe('enabled-frame');
    });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(download);
    await waitFor(() => {
      expect(mocks.download).toHaveBeenCalledOnce();
    });
    expect(client.export).toHaveBeenCalledOnce();
    expect(vi.mocked(client.export).mock.calls[0]?.[0]).toBe('glb');
    expect(vi.mocked(client.export).mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    fireEvent.click(screen.getByRole('button', { name: 'Reset parameters' }));
    await waitFor(() => {
      expect(screen.getByRole('img', { name: '3D model preview' }).textContent).toBe('default-keyguard');
      expect(frame.textContent).toBe('no');
    });
    expect(readGalleryLocation(new URL(globalThis.location.href)).parameters).toEqual({});
    expect(vi.mocked(client.render).mock.calls[2]?.[0]).toEqual({});
    expect(mocks.create).toHaveBeenCalledOnce();
  });
});
