import { describe, expect, it, vi } from 'vitest';
import { loadStaticGeometry, staticGeometryFromBytes } from '#static-geometry.js';

describe('staticGeometryFromBytes', () => {
  it('copies input bytes into a Tau geometry object', () => {
    const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

    const geometry = staticGeometryFromBytes({ bytes, hash: 'model.glb' });

    expect(geometry).toEqual({
      format: 'gltf',
      content: bytes,
      hash: 'model.glb',
    });
    expect(geometry.content).not.toBe(bytes);
  });
});

describe('loadStaticGeometry', () => {
  it('loads GLB bytes with the default glTF geometry format', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
      }),
    );

    const geometry = await loadStaticGeometry({ kind: 'static', url: '/models/demo.glb' }, { fetch: fetchMock });

    expect(fetchMock).toHaveBeenCalledWith('/models/demo.glb', { signal: undefined });
    expect(geometry.format).toBe('gltf');
    expect(geometry.hash).toBe('static:/models/demo.glb');
    expect([...geometry.content]).toEqual([1, 2, 3]);
  });

  it('surfaces non-OK responses as load failures', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));

    await expect(loadStaticGeometry({ kind: 'static', url: '/missing.glb' }, { fetch: fetchMock })).rejects.toThrow(
      'Failed to load static geometry: 404',
    );
  });
});
