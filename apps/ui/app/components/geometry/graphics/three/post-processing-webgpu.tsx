import type { ReactNode } from 'react';
import { useLayoutEffect, useRef } from 'react';
import { RenderPipeline as ThreeRenderPipeline, UnsignedByteType } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import {
  builtinAOContext,
  colorToDirection,
  directionToColor,
  mrt,
  normalView,
  pass,
  sample,
  screenUV,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import type { PerspectiveCamera as ThreePerspectiveCamera } from 'three';
import { useFrame, useThree } from '@react-three/fiber';

type PostProcessingPipelineResources = Readonly<{
  post: InstanceType<typeof ThreeRenderPipeline>;
  aoNode: { dispose(): void };
}>;

/**
 * WebGPU-only: GTAO post pipeline (depth + normal pre-pass → GTAO → lit scene pass with AO context).
 * Priority-1 `useFrame` drives `RenderPipeline.render()` so R3F suppresses default `gl.render`.
 *
 * **AA strategy.** Anti-aliasing comes from hardware MSAA on the `WebGPURenderer`
 * (`createTauRenderer('viewport', 'webgpu', …)` sets `antialias: true`).
 * TRAA was removed because the viewport runs `frameloop='demand'`: temporal AA cannot accumulate
 * while the scene is idle, and a single un-converged TRAA frame surfaces as edge graininess.
 * The pre-pass therefore omits a velocity MRT — only depth + normals are needed for GTAO.
 *
 * Does **not** monkey-patch `gl.render` — Three's pipeline calls `renderer.render` internally.
 */
function PostProcessingWebGpuActive(): ReactNode {
  const { gl, scene, camera } = useThree();
  const pipelineRef = useRef<PostProcessingPipelineResources | undefined>(undefined);

  useLayoutEffect(() => {
    const gpuRenderer = gl as unknown as WebGPURenderer;
    const perspectiveCamera = camera as ThreePerspectiveCamera;

    const prePass = pass(scene, perspectiveCamera);
    prePass.transparent = false;
    prePass.setMRT(
      mrt({
        output: directionToColor(normalView),
      }),
    );

    const prePassNormalTexture = prePass.getTexture('output');
    prePassNormalTexture.type = UnsignedByteType;

    const prePassDepth = prePass.getTextureNode('depth');

    const prePassNormal = sample((uv) => colorToDirection(prePass.getTextureNode().sample(uv)));

    const aoNode = ao(prePassDepth, prePassNormal, perspectiveCamera);
    aoNode.resolutionScale = 0.5;
    aoNode.useTemporalFiltering = true;
    aoNode.radius.value = 0.09;
    aoNode.thickness.value = 1;
    aoNode.samples.value = 16;
    aoNode.distanceFallOff.value = 1;

    const scenePass = pass(scene, perspectiveCamera);
    scenePass.contextNode = builtinAOContext(aoNode.getTextureNode().sample(screenUV).r);

    const post = new ThreeRenderPipeline(gpuRenderer);
    post.outputNode = scenePass;

    pipelineRef.current = { post, aoNode };

    return (): void => {
      pipelineRef.current = undefined;
      post.dispose();
      aoNode.dispose();
    };
  }, [gl, scene, camera]);

  useFrame(() => {
    pipelineRef.current?.post.render();
  }, 1);

  return null;
}

// eslint-disable-next-line @typescript-eslint/naming-convention -- WebGPU acronym matches three.js / browser API naming
export function PostProcessingWebGPU(): ReactNode {
  const { gl } = useThree();

  if (!('isWebGPURenderer' in gl) || !gl.isWebGPURenderer) {
    return null;
  }

  return <PostProcessingWebGpuActive />;
}
