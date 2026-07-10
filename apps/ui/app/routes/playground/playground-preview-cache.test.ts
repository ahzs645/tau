import { describe, expect, it } from 'vitest';
import type { Geometry } from '@taucad/types';
import {
  buildPlaygroundPreviewCacheKey,
  cachePlaygroundPreviewGeometries,
  createPlaygroundPreviewCache,
  haveSamePlaygroundParameters,
} from '#routes/playground/playground-preview-cache.js';

const libraryFile = 'lib.scad';
const mainFile = 'main.scad';

const createRequest = (overrides: Partial<Parameters<typeof buildPlaygroundPreviewCacheKey>[0]> = {}) => ({
  activeRenderIdentity: 'model::openscad',
  mainFile,
  parameters: { width: 10 },
  renderOptions: { tessellation: { angularTolerance: 0.2 } },
  sourceFiles: { [libraryFile]: 'module helper() {}', [mainFile]: 'cube(10);' },
  ...overrides,
});

describe('playground preview cache', () => {
  it('should build the same key regardless of object key order', () => {
    const left = buildPlaygroundPreviewCacheKey(
      createRequest({ parameters: { width: 10, nested: { depth: 2, height: 3 } } }),
    );
    const right = buildPlaygroundPreviewCacheKey(
      createRequest({ parameters: { nested: { height: 3, depth: 2 }, width: 10 } }),
    );

    expect(left).toBe(right);
  });

  it('should distinguish nullish and non-finite parameter values', () => {
    const values = [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0];
    const keys = values.map((value) => buildPlaygroundPreviewCacheKey(createRequest({ parameters: { value } })));

    expect(new Set(keys).size).toBe(values.length);
  });

  it('should invalidate when a dependency source or render option changes', () => {
    const baseline = buildPlaygroundPreviewCacheKey(createRequest());
    const dependencyChanged = buildPlaygroundPreviewCacheKey(
      createRequest({
        sourceFiles: { [libraryFile]: 'module helper() { sphere(1); }', [mainFile]: 'cube(10);' },
      }),
    );
    const renderOptionsChanged = buildPlaygroundPreviewCacheKey(
      createRequest({ renderOptions: { tessellation: { angularTolerance: 0.1 } } }),
    );

    expect(dependencyChanged).not.toBe(baseline);
    expect(renderOptionsChanged).not.toBe(baseline);
  });

  it('should compare parameter records independently of key order', () => {
    expect(haveSamePlaygroundParameters({ width: 10, height: 20 }, { height: 20, width: 10 })).toBe(true);
    expect(haveSamePlaygroundParameters({ width: undefined }, { width: null })).toBe(false);
  });

  it('should copy geometry once and return the owned immutable snapshot on reads', () => {
    const cache = createPlaygroundPreviewCache({ maxBytes: 10, maxEntries: 2 });
    const source: Geometry = { format: 'gltf', content: new Uint8Array([1, 2, 3]), hash: 'geometry' };

    expect(cachePlaygroundPreviewGeometries(cache, 'key', [source])).toBe(true);
    source.content[0] = 9;

    const firstRead = cache.get('key');
    const secondRead = cache.get('key');
    expect(firstRead).toBe(secondRead);
    expect(firstRead?.[0]?.format).toBe('gltf');
    if (firstRead?.[0]?.format === 'gltf') {
      expect([...firstRead[0].content]).toEqual([1, 2, 3]);
    }
  });

  it('should evict by bytes and reject an oversized geometry', () => {
    const cache = createPlaygroundPreviewCache({ maxBytes: 5, maxEntries: 10 });
    const geometry = (hash: string, bytes: number): Geometry => ({
      format: 'gltf',
      content: new Uint8Array(bytes),
      hash,
    });

    cachePlaygroundPreviewGeometries(cache, 'a', [geometry('a', 3)]);
    cachePlaygroundPreviewGeometries(cache, 'b', [geometry('b', 3)]);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cachePlaygroundPreviewGeometries(cache, 'oversized', [geometry('large', 6)])).toBe(false);
    expect(cache.get('oversized')).toBeUndefined();
  });
});
