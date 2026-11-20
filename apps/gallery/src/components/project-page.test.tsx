// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GalleryProject, GalleryVariant } from '#catalog/types.js';
import type * as DownloadModule from '#components/download.js';
import type { GalleryRenderResult, GallerySession } from '#runtime.js';
import { readGalleryLocation, useGalleryHref } from '#sharing/location.js';
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
vi.mock('#components/parameter-panel.jsx', () => ({
  ParameterPanel: ({ onReplace }: { readonly onReplace: (parameters: Record<string, unknown>) => void }) => (
    <aside aria-label='Model parameters'>
      <button
        type='button'
        onClick={() => {
          onReplace({ width: -1 });
        }}
      >
        Apply failing parameters
      </button>
      <button
        type='button'
        onClick={() => {
          onReplace({ width: 20 });
        }}
      >
        Apply valid parameters
      </button>
    </aside>
  ),
}));
vi.mock('#components/ar-button.jsx', () => ({ ArButton: () => undefined }));
vi.mock('#components/theme.jsx', () => ({ ThemeToggle: () => undefined }));
vi.mock('#components/source-dialog.jsx', () => ({ SourceDialog: () => undefined }));
vi.mock('#components/share-dialog.jsx', () => ({ ShareDialog: () => undefined }));

const variant: GalleryVariant = {
  id: 'openscad',
  label: 'OpenSCAD',
  shortLabel: 'SCAD',
  entry: 'model.scad',
  kernel: 'openrscad',
  language: 'scad',
  exportFormats: ['glb'],
};
const project: GalleryProject = {
  id: 'test-part',
  title: 'Test part',
  description: 'Test part',
  tags: [],
  sourceUrl: 'https://github.com/ahzs645/tau',
  mode: 'parametric',
  hidden: false,
  defaultVariantId: 'openscad',
  variants: [variant],
  initialParameters: { width: 10 },
  presets: [],
  uploads: [],
  filePaths: ['model.scad'],
  libraries: [],
  parityExclusions: {},
};
const artifact = (width: number): GalleryRenderResult => ({
  artifact: { mimeType: 'model/gltf-binary', content: new Uint8Array([width]) },
  artifactHash: `width-${width}`,
  jsonSchema: undefined,
  parameterManifest: undefined,
  defaultParameters: { width: 10 },
  parameters: { width },
  formats: ['glb'],
  issues: [],
});
const RoutedProject = (): React.JSX.Element => {
  const href = useGalleryHref();
  return <ProjectPage project={project} href={href} route={readGalleryLocation(new URL(href))} />;
};

beforeEach(() => {
  mocks.create.mockReset();
  mocks.loadFiles.mockReset();
  mocks.download.mockReset();
  mocks.loadFiles.mockResolvedValue({ 'model.scad': new Uint8Array([1]) });
  globalThis.history.replaceState({}, '', '/test-part');
});
afterEach(cleanup);

describe('gallery export after a failed model update', () => {
  it('should keep the last valid preview visible while blocking export until a later render succeeds', async () => {
    const failed = Promise.withResolvers<GalleryRenderResult>();
    const client: GallerySession = {
      render: vi
        .fn<GallerySession['render']>()
        .mockResolvedValueOnce(artifact(10))
        .mockReturnValueOnce(failed.promise)
        .mockResolvedValueOnce(artifact(20)),
      export: vi
        .fn<GallerySession['export']>()
        .mockResolvedValue([{ name: 'model.glb', bytes: new Uint8Array([1]), mimeType: 'model/gltf-binary' }]),
      dispose: vi.fn<GallerySession['dispose']>().mockResolvedValue(),
    };
    mocks.create.mockResolvedValue(client);
    render(<RoutedProject />);
    const download = screen.getByRole('button', { name: /^Export$/u });
    const preview = screen.getByRole('img', { name: '3D model preview' });
    await waitFor(() => {
      expect(download).toHaveProperty('disabled', false);
      expect(preview.textContent).toContain('width-10');
    });
    fireEvent.click(download);
    await waitFor(() => {
      expect(mocks.download).toHaveBeenCalledOnce();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Apply failing parameters' }));
    await waitFor(() => {
      expect(client.render).toHaveBeenCalledTimes(2);
    });
    expect(download).toHaveProperty('disabled', true);
    expect(preview.textContent).toContain('width-10');
    await act(async () => {
      failed.reject(new Error('Could not render the model: Boolean difference failed; partial geometry was rejected.'));
    });
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'The model could not update. The last successful preview is still visible.',
      );
    });
    expect(preview.textContent).toContain('width-10');
    expect(download).toHaveProperty('disabled', true);
    fireEvent.click(download);
    expect(client.export).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Apply valid parameters' }));
    await waitFor(() => {
      expect(preview.textContent).toContain('width-20');
      expect(download).toHaveProperty('disabled', false);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(download);
    await waitFor(() => {
      expect(mocks.download).toHaveBeenCalledTimes(2);
    });
    expect(client.export).toHaveBeenLastCalledWith('glb');
    expect(mocks.create).toHaveBeenCalledOnce();
  });
});
