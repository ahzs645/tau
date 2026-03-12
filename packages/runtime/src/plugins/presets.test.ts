import { describe, it, expect } from 'vitest';
import { presets } from '#plugins/presets.js';

describe('presets.all', () => {
  it('should return all 7 kernel plugins with correct IDs', () => {
    const { kernels } = presets.all();

    expect(kernels).toHaveLength(7);

    const ids = kernels.map((k) => k.id);
    expect(ids).toEqual(['openscad', 'zoo', 'replicad', 'opencascade', 'manifold', 'jscad', 'tau']);
  });

  it('should return all 4 middleware plugins with correct IDs', () => {
    const { middleware } = presets.all();

    expect(middleware).toHaveLength(4);

    const ids = middleware.map((m) => m.id);
    expect(ids).toEqual(['parameterCache', 'geometryCache', 'gltfCoordinateTransform', 'gltfEdgeDetection']);
  });

  it('should return 1 bundler plugin with esbuild ID and default extensions', () => {
    const { bundlers } = presets.all();

    expect(bundlers).toHaveLength(1);
    expect(bundlers[0]!.id).toBe('esbuild');
    expect(bundlers[0]!.extensions).toEqual(['ts', 'js', 'tsx', 'jsx']);
  });

  it('should include a non-empty moduleUrl on every plugin', () => {
    const { kernels, middleware, bundlers } = presets.all();

    for (const plugin of [...kernels, ...middleware, ...bundlers]) {
      expect(plugin.moduleUrl).toEqual(expect.any(String));
      expect(plugin.moduleUrl.length).toBeGreaterThan(0);
    }
  });

  it('should return fresh objects on each call', () => {
    const first = presets.all();
    const second = presets.all();

    expect(first.kernels).not.toBe(second.kernels);
    expect(first.middleware).not.toBe(second.middleware);
    expect(first.bundlers).not.toBe(second.bundlers);
  });
});
