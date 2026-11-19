// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GalleryProject, GalleryVariant } from '#catalog/types.js';
import type { GalleryRenderResult, GallerySession } from '#runtime.js';
import { useGalleryModel } from '#components/use-gallery-model.js';
import type { UploadedAssets } from '#components/use-gallery-model.js';

const mocks = vi.hoisted(() => ({ create: vi.fn(), loadFiles: vi.fn(), loadStatic: vi.fn() }));
vi.mock('#runtime.js', () => ({ createGallerySession: mocks.create, loadGalleryStaticArtifact: mocks.loadStatic }));
vi.mock('#catalog/catalog.js', () => ({ loadProjectFiles: mocks.loadFiles }));

const variant: GalleryVariant = {
  id: 'openscad',
  label: 'OpenSCAD',
  shortLabel: 'SCAD',
  entry: 'model.scad',
  kernel: 'openrscad',
  language: 'scad',
  exportFormats: ['stl', 'glb'],
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
  initialParameters: {},
  presets: [],
  uploads: [],
  filePaths: ['model.scad'],
  libraries: [],
  parityExclusions: {},
};
const noUploads: UploadedAssets = {};
const input = { project, variant, parameters: { width: 10 }, uploads: noUploads, operationTimeout: 120_000, retry: 0 };
const rendered = (width: number): GalleryRenderResult => ({
  artifact: { mimeType: 'model/gltf-binary', content: new Uint8Array([width]) },
  artifactHash: `width-${width}`,
  jsonSchema: undefined,
  parameterManifest: undefined,
  defaultParameters: { width: 10 },
  parameters: { width },
  formats: ['glb', 'stl'],
  issues: [],
});
const session = (): GallerySession => ({
  render: vi.fn<GallerySession['render']>().mockResolvedValue(rendered(10)),
  export: vi.fn<GallerySession['export']>().mockResolvedValue([]),
  dispose: vi.fn<GallerySession['dispose']>().mockResolvedValue(),
});

beforeEach(() => {
  mocks.create.mockReset();
  mocks.loadStatic.mockReset();
  mocks.loadFiles.mockReset();
  mocks.loadFiles.mockImplementation(async () => ({ 'model.scad': new Uint8Array([1]) }));
});
afterEach(cleanup);

describe('gallery model lifecycle', () => {
  it('should reuse its worker for edits and prevent a late render replacing newer geometry', async () => {
    const client = session();
    const twenty = Promise.withResolvers<GalleryRenderResult>();
    const thirty = Promise.withResolvers<GalleryRenderResult>();
    vi.mocked(client.render)
      .mockResolvedValueOnce(rendered(10))
      .mockReturnValueOnce(twenty.promise)
      .mockReturnValueOnce(thirty.promise);
    mocks.create.mockResolvedValue(client);
    const { result, rerender } = renderHook((props) => useGalleryModel(props), { initialProps: input });
    await waitFor(() => {
      expect(result.current.result?.artifactHash).toBe('width-10');
    });
    rerender({ ...input, parameters: { width: 20 } });
    await waitFor(() => {
      expect(client.render).toHaveBeenCalledTimes(2);
    });
    expect(result.current.result?.artifactHash).toBe('width-10');
    expect(result.current.busy).toBe(true);
    rerender({ ...input, parameters: { width: 30 } });
    await waitFor(() => {
      expect(client.render).toHaveBeenCalledTimes(3);
    });
    await act(async () => {
      thirty.resolve(rendered(30));
    });
    await waitFor(() => {
      expect(result.current.result?.artifactHash).toBe('width-30');
    });
    await act(async () => {
      twenty.resolve(rendered(20));
    });
    expect(result.current.result?.artifactHash).toBe('width-30');
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('should replace the worker when uploaded source bytes change and dispose the previous session', async () => {
    const first = session();
    const second = session();
    mocks.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const { result, rerender } = renderHook((props) => useGalleryModel(props), { initialProps: input });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    const bytes = new TextEncoder().encode('<svg />');
    rerender({ ...input, uploads: { 'artwork.svg': { name: 'new.svg', bytes, mimeType: 'image/svg+xml' } } });
    await waitFor(() => {
      expect(second.render).toHaveBeenCalledOnce();
    });
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[1]?.[0].files['artwork.svg']).toEqual(bytes);
  });

  it('should keep the last successful preview after failure and report that export is not ready', async () => {
    const client = session();
    vi.mocked(client.render).mockResolvedValueOnce(rendered(10)).mockRejectedValueOnce(new Error('Invalid width'));
    mocks.create.mockResolvedValue(client);
    const { result, rerender } = renderHook((props) => useGalleryModel(props), { initialProps: input });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    rerender({ ...input, parameters: { width: -1 } });
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error).toBe('Invalid width');
    expect(result.current.result?.artifactHash).toBe('width-10');
  });

  it('should dispose a session that finishes opening after the view has unmounted', async () => {
    const client = session();
    const opening = Promise.withResolvers<GallerySession>();
    mocks.create.mockReturnValue(opening.promise);
    const { unmount } = renderHook(() => useGalleryModel(input));
    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledOnce();
    });
    unmount();
    await act(async () => {
      opening.resolve(client);
    });
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(client.render).not.toHaveBeenCalled();
  });

  it('should display a static model without creating a CAD worker', async () => {
    mocks.loadStatic.mockResolvedValue(rendered(15));
    const staticProject: GalleryProject = {
      ...project,
      mode: 'static',
      variants: [],
      defaultVariantId: 'static',
      staticPreviewUrl: '/model.glb',
      staticPreviewCoordinateSystem: 'z-up',
    };
    const { result } = renderHook(() => useGalleryModel({ ...input, project: staticProject, variant: undefined }));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.result?.artifactHash).toBe('width-15');
    expect(mocks.loadStatic).toHaveBeenCalledWith('/model.glb', expect.objectContaining({ coordinateSystem: 'z-up' }));
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
