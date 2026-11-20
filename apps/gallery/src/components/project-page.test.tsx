// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GalleryProject, GalleryUpload, GalleryVariant } from '#catalog/types.js';
import type * as DownloadModule from '#components/download.js';
import type { GalleryExportFile, GalleryRenderResult, GallerySession } from '#runtime.js';
import type { UploadedAsset } from '#components/use-gallery-model.js';
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
  ParameterPanel: ({
    onReplace,
    onUpload,
  }: {
    readonly onReplace: (parameters: Record<string, unknown>) => void;
    readonly onUpload: (slot: GalleryUpload, asset: UploadedAsset) => void;
  }) => (
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
      <button
        type='button'
        onClick={() => {
          onUpload(
            { id: 'artwork.svg', filePath: 'artwork.svg', label: 'Artwork', accept: '.svg' },
            { name: 'new.svg', bytes: new Uint8Array([2]), mimeType: 'image/svg+xml' },
          );
        }}
      >
        Replace artwork
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
const RoutedProject = ({ definition = project }: { readonly definition?: GalleryProject }): React.JSX.Element => {
  const href = useGalleryHref();
  return <ProjectPage project={definition} href={href} route={readGalleryLocation(new URL(href))} />;
};

const exportedFiles = (width: number): readonly GalleryExportFile[] => [
  { name: `width-${width}.glb`, bytes: new Uint8Array([width]), mimeType: 'model/gltf-binary' },
];
const createSession = (): GallerySession => ({
  parameterDescription: { jsonSchema: undefined, parameterManifest: undefined, defaultParameters: { width: 10 } },
  render: vi.fn<GallerySession['render']>().mockResolvedValue(artifact(10)),
  export: vi.fn<GallerySession['export']>().mockResolvedValue(exportedFiles(10)),
  dispose: vi.fn<GallerySession['dispose']>().mockResolvedValue(),
});
const readyExport = async (): Promise<HTMLElement> => {
  const button = await screen.findByRole('button', { name: /^Export$/u });
  await waitFor(() => {
    expect(button).toHaveProperty('disabled', false);
  });
  return button;
};

beforeEach(() => {
  mocks.create.mockReset();
  mocks.loadFiles.mockReset();
  mocks.download.mockReset();
  mocks.loadFiles.mockResolvedValue({ 'model.scad': new Uint8Array([1]) });
  globalThis.history.replaceState({}, '', '/test-part');
});
afterEach(cleanup);

describe('gallery export lifetime', () => {
  it('should discard a pending export after an edit fails and allow export after recovery', async () => {
    const previous = Promise.withResolvers<readonly GalleryExportFile[]>();
    const client = createSession();
    vi.mocked(client.render)
      .mockResolvedValueOnce(artifact(10))
      .mockRejectedValueOnce(new Error('Invalid width'))
      .mockResolvedValueOnce(artifact(20));
    vi.mocked(client.export).mockReturnValueOnce(previous.promise).mockResolvedValueOnce(exportedFiles(20));
    mocks.create.mockResolvedValue(client);
    render(<RoutedProject />);
    fireEvent.click(await readyExport());
    fireEvent.click(screen.getByRole('button', { name: 'Apply failing parameters' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Invalid width');
    });
    await act(async () => {
      previous.resolve(exportedFiles(10));
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(vi.mocked(client.export).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(screen.getByRole('button', { name: /^Export$/u })).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByRole('button', { name: 'Apply valid parameters' }));
    fireEvent.click(await readyExport());
    await waitFor(() => {
      expect(mocks.download).toHaveBeenCalledExactlyOnceWith(exportedFiles(20)[0]);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['success', 'failure'])(
    'should ignore an older export %s while a replacement export is pending',
    async (outcome) => {
      const previous = Promise.withResolvers<readonly GalleryExportFile[]>();
      const current = Promise.withResolvers<readonly GalleryExportFile[]>();
      const client = createSession();
      vi.mocked(client.render).mockResolvedValueOnce(artifact(10)).mockResolvedValueOnce(artifact(20));
      vi.mocked(client.export).mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
      mocks.create.mockResolvedValue(client);
      render(<RoutedProject />);
      fireEvent.click(await readyExport());
      fireEvent.click(screen.getByRole('button', { name: 'Apply valid parameters' }));
      fireEvent.click(await readyExport());
      expect(client.export).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (outcome === 'success') {
          previous.resolve(exportedFiles(10));
        } else {
          previous.reject(new Error('Superseded worker export failed'));
        }
      });
      expect(mocks.download).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('button', { name: 'Exporting…' })).toHaveProperty('disabled', true);
      expect(vi.mocked(client.export).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(vi.mocked(client.export).mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
      await act(async () => {
        current.resolve(exportedFiles(20));
      });
      expect(mocks.download).toHaveBeenCalledExactlyOnceWith(exportedFiles(20)[0]);
      expect(await readyExport()).toHaveProperty('disabled', false);
    },
  );

  it.each(['variant', 'upload'])(
    'should discard a pending export when its source session changes through %s',
    async (change) => {
      const previous = Promise.withResolvers<readonly GalleryExportFile[]>();
      const first = createSession();
      const second = createSession();
      vi.mocked(first.export).mockReturnValueOnce(previous.promise);
      vi.mocked(second.render).mockResolvedValue(artifact(20));
      vi.mocked(second.export).mockResolvedValue(exportedFiles(20));
      mocks.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      const alternate: GalleryVariant = {
        ...variant,
        id: 'replicad',
        label: 'Replicad',
        shortLabel: 'Replicad',
        kernel: 'replicad',
        entry: 'model.ts',
      };
      render(<RoutedProject definition={{ ...project, variants: [variant, alternate] }} />);
      fireEvent.click(await readyExport());
      fireEvent.click(
        screen.getByRole('button', { name: change === 'variant' ? 'Replicad Replicad' : 'Replace artwork' }),
      );
      await readyExport();
      expect(first.dispose).toHaveBeenCalledOnce();
      await act(async () => {
        previous.resolve(exportedFiles(10));
      });
      expect(mocks.download).not.toHaveBeenCalled();
      expect(vi.mocked(first.export).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      fireEvent.click(await readyExport());
      await waitFor(() => {
        expect(mocks.download).toHaveBeenCalledExactlyOnceWith(exportedFiles(20)[0]);
      });
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  it('should retain the current export error when an older export fails later', async () => {
    const previous = Promise.withResolvers<readonly GalleryExportFile[]>();
    const client = createSession();
    vi.mocked(client.render).mockResolvedValueOnce(artifact(10)).mockResolvedValueOnce(artifact(20));
    vi.mocked(client.export)
      .mockReturnValueOnce(previous.promise)
      .mockRejectedValueOnce(new Error('Current export failed'));
    mocks.create.mockResolvedValue(client);
    render(<RoutedProject />);
    fireEvent.click(await readyExport());
    fireEvent.click(screen.getByRole('button', { name: 'Apply valid parameters' }));
    fireEvent.click(await readyExport());
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Current export failed');
    });
    await act(async () => {
      previous.reject(new Error('Previous export failed'));
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Current export failed');
    expect(screen.getByRole('alert').textContent).not.toContain('Previous export failed');
    expect(await readyExport()).toHaveProperty('disabled', false);
  });

  it.each(['success', 'failure'])('should cancel pending export %s on unmount', async (outcome) => {
    const previous = Promise.withResolvers<readonly GalleryExportFile[]>();
    const client = createSession();
    vi.mocked(client.export).mockReturnValueOnce(previous.promise);
    mocks.create.mockResolvedValue(client);
    const { unmount } = render(<RoutedProject />);
    fireEvent.click(await readyExport());
    unmount();
    await act(async () => {
      if (outcome === 'success') {
        previous.resolve(exportedFiles(10));
      } else {
        previous.reject(new Error('Closed worker export failed'));
      }
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(vi.mocked(client.export).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(client.dispose).toHaveBeenCalledOnce();
  });
});

describe('gallery export after a failed model update', () => {
  it('should keep the last valid preview visible while blocking export until a later render succeeds', async () => {
    const failed = Promise.withResolvers<GalleryRenderResult>();
    const client: GallerySession = {
      parameterDescription: { jsonSchema: undefined, parameterManifest: undefined, defaultParameters: { width: 10 } },
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
    expect(vi.mocked(client.export).mock.calls.at(-1)?.[0]).toBe('glb');
    expect(vi.mocked(client.export).mock.calls.at(-1)?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.create).toHaveBeenCalledOnce();
  });
});
