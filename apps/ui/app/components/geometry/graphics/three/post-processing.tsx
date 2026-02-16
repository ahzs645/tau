import { EffectComposer, N8AO } from '@react-three/postprocessing';
import { useGraphicsSelector } from '#hooks/use-graphics.js';

/**
 * Conditionally renders the EffectComposer with N8AO ambient occlusion.
 * When disabled, the EffectComposer unmounts and SceneOverlay auto-adapts
 * to render the full scene itself via `state.internal.priority` detection.
 *
 * N8AO is configured with `screenSpaceRadius={true}`, which means `aoRadius`
 * is measured in **pixels** (not world units). This makes the ambient occlusion
 * effect scale-independent -- models of any size receive visually consistent AO
 * without needing access to `sceneRadius`. If `screenSpaceRadius` were `false`,
 * `aoRadius` would need to be proportional to the scene bounding sphere radius
 * (typically 1-2 orders of magnitude smaller than the scene scale).
 */
export function PostProcessing(): React.JSX.Element | undefined {
  const enablePostProcessing = useGraphicsSelector((state) => state.context.enablePostProcessing);

  if (!enablePostProcessing) {
    return undefined;
  }

  return (
    <EffectComposer stencilBuffer multisampling={4}>
      <N8AO screenSpaceRadius aoRadius={24} intensity={1} distanceFalloff={0.2} />
    </EffectComposer>
  );
}
