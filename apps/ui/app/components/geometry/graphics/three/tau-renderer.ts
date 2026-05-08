import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import type { ResolvedGraphicsBackend } from '#constants/editor.constants.js';

/** WebGL renderer instantiated by Tau helpers. */
export type TauWebGlRenderer = THREE.WebGLRenderer;

/** WebGPU renderer instantiated by Tau helpers. */
export type TauWebGpuRenderer = InstanceType<typeof WebGPURenderer>;

/** Union returned from {@link createTauRenderer}. */
export type TauRendererInstance = TauWebGlRenderer | TauWebGpuRenderer;

/**
 * Tau-owned renderer presets for disparate surfaces:
 *
 * - **`viewport`** — Interactive CAD `<Canvas>`: MSAA on for both backends — WebGPU adds reversed-Z + GTAO,
 *   WebGL adds log-depth + N8AO and `powerPreference: 'high-performance'` (matches @react-three/fiber defaults
 *   for object-form `gl` props; factory `gl` must set it explicitly). TRAA/temporal AA is intentionally absent because the viewport runs
 *   `frameloop='demand'` (see `docs/policy/graphics-backend-policy.md`) and temporal effects cannot
 *   converge while the scene is idle, so static frames must be AA-clean from a single render.
 * - **`offscreen`** — Shared/doc bitmap path: MSAA + log-depth + stencil; WebGL omits preserve-buffer (bitmap transfer).
 * - **`screenshot`** — Headless clones + readback path: matches offscreen presets and adds **`preserveDrawingBuffer`** on WebGL where pixels are sampled from the framebuffer.
 * - **`gizmo`** — Small overlay cube: MSAA enabled; excludes log-depth and stencil (tiny fixed viewing volume).
 *
 * @see `docs/policy/graphics-backend-policy.md`
 */
export type TauRendererUseCase = 'viewport' | 'offscreen' | 'gizmo' | 'screenshot';

async function initWebGpuIfNeeded(renderer: TauWebGpuRenderer): Promise<void> {
  await renderer.init();
}

/**
 * Instantiate a Tau-normalised Three.js renderer for the given GPU backend and UI surface.
 *
 * @param useCase - Viewport / offscreen / screenshot / gizmo preset (see {@link TauRendererUseCase}).
 * @param backend - `'webgl'` or `'webgpu'`.
 * @param canvas - Backing canvas (`OffscreenCanvas` callers rely on the same cast path as upstream Three.js typings).
 */
export async function createTauRenderer(
  useCase: TauRendererUseCase,
  backend: ResolvedGraphicsBackend,
  canvas: HTMLCanvasElement | OffscreenCanvas,
): Promise<TauRendererInstance> {
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- Offscreen-backed bitmap path matches upstream typing
  const backingCanvas = canvas as HTMLCanvasElement;

  if (backend === 'webgpu') {
    const options: ConstructorParameters<typeof WebGPURenderer>[0] = {
      canvas: backingCanvas,
      alpha: true,
    };

    if (useCase === 'viewport') {
      Object.assign(options, {
        antialias: true,
        reversedDepthBuffer: true,
        logarithmicDepthBuffer: false,
        stencil: true,
      } satisfies Partial<ConstructorParameters<typeof WebGPURenderer>[0]>);
    } else if (useCase === 'offscreen' || useCase === 'screenshot') {
      Object.assign(options, {
        antialias: true,
        logarithmicDepthBuffer: true,
        stencil: true,
      } satisfies Partial<ConstructorParameters<typeof WebGPURenderer>[0]>);
    } else {
      Object.assign(options, {
        antialias: true,
      } satisfies Partial<ConstructorParameters<typeof WebGPURenderer>[0]>);
    }

    const renderer = new WebGPURenderer(options);
    await initWebGpuIfNeeded(renderer);
    return renderer;
  }

  const webGlOptions: THREE.WebGLRendererParameters = {
    canvas: backingCanvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  };

  if (useCase === 'viewport' || useCase === 'offscreen' || useCase === 'screenshot') {
    Object.assign(webGlOptions, {
      stencil: true,
    } satisfies THREE.WebGLRendererParameters);
  }

  if (useCase === 'viewport' || useCase === 'offscreen' || useCase === 'screenshot') {
    Object.assign(webGlOptions, {
      logarithmicDepthBuffer: true,
    } satisfies THREE.WebGLRendererParameters);
  }

  if (useCase === 'screenshot') {
    Object.assign(webGlOptions, {
      preserveDrawingBuffer: true,
    } satisfies THREE.WebGLRendererParameters);
  }

  return new THREE.WebGLRenderer(webGlOptions);
}
