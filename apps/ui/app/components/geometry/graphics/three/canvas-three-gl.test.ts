import { describe, expect, it, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  createTauRenderer: vi.fn(),
}));

vi.mock('#components/geometry/graphics/three/tau-renderer.js', () => ({
  createTauRenderer: hoisted.createTauRenderer,
}));

describe('createTauR3fGlProp', () => {
  beforeEach(() => {
    hoisted.createTauRenderer.mockReset();
    hoisted.createTauRenderer.mockImplementation(async () => ({
      init: vi.fn(async () => {
        //
      }),
    }));
  });

  it('delegates WebGPU canvases to createTauRenderer viewport presets', async () => {
    const { createTauR3fGlProp } = await import('#components/geometry/graphics/three/canvas-three-gl.js');
    const glFactory = createTauR3fGlProp('webgpu');

    expect(glFactory).toBeTypeOf('function');

    const canvas = document.createElement('canvas');
    await (glFactory as (defaults: Record<string, unknown>) => Promise<unknown>)({
      canvas,
      alpha: true,
    });

    expect(hoisted.createTauRenderer).toHaveBeenCalledTimes(1);
    expect(hoisted.createTauRenderer).toHaveBeenCalledWith('viewport', 'webgpu', canvas);
  });

  it('delegates WebGL canvases to createTauRenderer viewport presets', async () => {
    const { createTauR3fGlProp } = await import('#components/geometry/graphics/three/canvas-three-gl.js');
    const glFactory = createTauR3fGlProp('webgl');

    expect(glFactory).toBeTypeOf('function');

    const canvas = document.createElement('canvas');
    await (glFactory as (defaults: Record<string, unknown>) => Promise<unknown>)({
      canvas,
      alpha: true,
    });

    expect(hoisted.createTauRenderer).toHaveBeenCalledTimes(1);
    expect(hoisted.createTauRenderer).toHaveBeenCalledWith('viewport', 'webgl', canvas);
  });
});
