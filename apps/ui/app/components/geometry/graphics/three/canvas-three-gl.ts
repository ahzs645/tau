import type { CanvasProps, Renderer as FiberCompatibleGl } from '@react-three/fiber';
import type { ResolvedGraphicsBackend } from '#constants/editor.constants.js';
import { createTauRenderer } from '#components/geometry/graphics/three/tau-renderer.js';

/**
 * R3F `gl` factory / props for {@link ResolvedGraphicsBackend}.
 *
 * Builds renderers via {@link createTauRenderer} with the **`viewport`** use case (MSAA,
 * WebGL log-depth / WebGPU reversed-Z — see `tau-renderer.ts`).
 */
/* oxlint-disable unicorn-js/prevent-abbreviations -- name mirrors R3F `<Canvas gl={...}>` ergonomics */
export function createTauR3fGlProp(graphicsBackend: ResolvedGraphicsBackend): CanvasProps['gl'] {
  if (graphicsBackend === 'webgpu') {
    return async (defaults) => {
      const renderer = await createTauRenderer('viewport', 'webgpu', defaults.canvas as HTMLCanvasElement);
      return renderer as FiberCompatibleGl;
    };
  }

  return async (defaults) => {
    const renderer = await createTauRenderer('viewport', 'webgl', defaults.canvas as HTMLCanvasElement);
    return renderer as FiberCompatibleGl;
  };
}
/* oxlint-enable unicorn-js/prevent-abbreviations */
