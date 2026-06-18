// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Geometry } from '@taucad/types';
import { CadPreviewViewer, loadStaticPreviewGeometry } from '#components/cad-preview.js';

const { mockPreview } = vi.hoisted(() => ({
  mockPreview: {
    cadRef: {},
    defaultParameters: {},
    error: undefined as Error | undefined,
    geometries: [] as Geometry[],
    graphicsRef: {},
    jsonSchema: undefined,
    parameters: {},
    setParameters: vi.fn(),
    status: 'loading' as 'idle' | 'loading' | 'ready' | 'error',
  },
}));

vi.mock('#hooks/use-cad-preview.js', () => ({
  useCadPreview() {
    return mockPreview;
  },
}));

vi.mock('#components/model-viewer.js', () => ({
  ModelViewer({ error, geometries }: { readonly error?: Error; readonly geometries: readonly Geometry[] }) {
    return (
      <div
        data-testid='model-viewer'
        data-count={String(geometries.length)}
        data-error={error?.message ?? ''}
        data-hash={geometries[0]?.hash ?? ''}
      />
    );
  },
  RenderStatusOverlay({ status }: { readonly status: string }) {
    return <div data-testid='render-status'>{status}</div>;
  },
}));

const staticBytes = new Uint8Array([1, 2, 3]);
const liveGeometry: Geometry = {
  format: 'gltf',
  content: new Uint8Array([9, 9, 9]),
  hash: 'live-preview',
};

describe('CadPreviewViewer', () => {
  beforeEach(() => {
    mockPreview.error = undefined;
    mockPreview.geometries = [];
    mockPreview.status = 'loading';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => staticBytes.buffer,
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('uses a static preview GLB as first-paint geometry while live preview is empty', async () => {
    render(<CadPreviewViewer staticPreviewUrl='/static/rack.glb' />);

    await waitFor(() => {
      expect(screen.getByTestId('model-viewer')).toHaveAttribute('data-count', '1');
    });

    expect(screen.getByTestId('model-viewer')).toHaveAttribute('data-hash', 'static-preview:/static/rack.glb');
  });

  it('keeps live geometry authoritative when it is available', async () => {
    mockPreview.geometries = [liveGeometry];
    mockPreview.status = 'ready';

    render(<CadPreviewViewer staticPreviewUrl='/static/rack.glb' />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/static/rack.glb', expect.any(Object));
    });
    expect(screen.getByTestId('model-viewer')).toHaveAttribute('data-hash', 'live-preview');
  });
});

describe('loadStaticPreviewGeometry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads GLB bytes into a hashed glTF geometry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => staticBytes.buffer,
      })),
    );

    await expect(loadStaticPreviewGeometry('/static/rack.glb')).resolves.toMatchObject({
      format: 'gltf',
      hash: 'static-preview:/static/rack.glb',
      content: staticBytes,
    });
  });
});
