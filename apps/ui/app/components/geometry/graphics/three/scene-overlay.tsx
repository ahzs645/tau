import type { ReactNode } from 'react';
import { useMemo } from 'react';
import * as THREE from 'three';
import { createPortal, useFrame } from '@react-three/fiber';

type SceneOverlayFrameLoopProps = Readonly<{
  overlayScene: THREE.Scene;
}>;

/**
 * Runs the depth-restore / main-scene / overlay renders at R3F priority `2`.
 * Mounted only when the overlay subtree has geometry to draw so we do not hold a
 * positive-priority subscriber when overlay children are absent (fixes blank CAD when
 * both grid and axes are disabled — see audit R4).
 */
function SceneOverlayFrameLoop({ overlayScene }: SceneOverlayFrameLoopProps): ReactNode {
  const depthOnlyMaterial = useMemo(() => {
    const mat = new THREE.MeshBasicMaterial();
    mat.colorWrite = false;
    return mat;
  }, []);

  useFrame((state) => {
    const { gl, scene, camera } = state;
    const previousAutoClear = gl.autoClear;
    gl.autoClear = false;

    // `internal.priority` is the count of subscribed `useFrame` callbacks with
    // `priority > 0`, not an EffectComposer/WebGPU sentinel. When it is strictly
    // greater than `1`, at least two positive-priority owners exist — typically
    // WebGL `@react-three/postprocessing` `EffectComposer` or WebGPU
    // `PostProcessingWebGPU` (priority `1`), plus this overlay (priority `2`).
    if (state.internal.priority > 1) {
      // Another owner already drew colour (`composer.render`, `RenderPipeline.render`, …).
      // Restore scene depth with a lightweight override pass before drawing the overlay.
      const previousOverrideMaterial = scene.overrideMaterial;
      scene.overrideMaterial = depthOnlyMaterial;
      gl.render(scene, camera);
      scene.overrideMaterial = previousOverrideMaterial;
    } else {
      // Sole positive-priority subscriber: R3F has disabled its default terminal
      // `gl.render(scene, camera)` — we must shade the full main scene ourselves.
      gl.autoClear = true;
      gl.render(scene, camera);
      gl.autoClear = false;
    }

    gl.render(overlayScene, camera);

    gl.autoClear = previousAutoClear;
  }, 2);

  return null;
}

type SceneOverlayProperties = Readonly<{
  children: ReactNode;
  /**
   * When `false`, omit the priority-2 subscriber entirely so CAD still renders via
   * R3F's default pipeline when overlay children are omitted (axes + grid off).
   */
  overlayActive: boolean;
}>;

/**
 * Renders children in a separate THREE.Scene composited above the viewport output.
 *
 * Keeps overlays (Grid, AxesHelper) outside N8AO / GTAO stacks so ambient occlusion does
 * not darken them.
 *
 * When {@link SceneOverlayProperties.overlayActive} is `true`, registers at R3F
 * **`renderPriority = 2`**, ordered after priority-**1** viewport post-processing
 * (WebGL **`EffectComposer`**, WebGPU **`RenderPipeline`** via `PostProcessingWebGPU`).
 *
 * `frameloop` / demand-render conventions for the parent `<Canvas>` are policy-bound in
 * **`docs/policy/graphics-backend-policy.md`** §7.
 */
export function SceneOverlay({ children, overlayActive }: SceneOverlayProperties): React.JSX.Element {
  const overlayScene = useMemo(() => new THREE.Scene(), []);

  return (
    <>
      {createPortal(children, overlayScene)}
      {overlayActive ? <SceneOverlayFrameLoop overlayScene={overlayScene} /> : null}
    </>
  );
}
