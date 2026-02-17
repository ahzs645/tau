import type { CanvasProps } from '@react-three/fiber';
import { Canvas } from '@react-three/fiber';
import { useState } from 'react';
import { Scene } from '#components/geometry/graphics/three/scene.js';
import { SceneOverlay } from '#components/geometry/graphics/three/scene-overlay.js';
import { PostProcessing } from '#components/geometry/graphics/three/post-processing.js';
import type { StageOptions } from '#components/geometry/graphics/three/stage.js';
import { Grid } from '#components/geometry/graphics/three/grid.js';
import { AxesHelper } from '#components/geometry/graphics/three/react/axes-helper.js';
import { ActorBridge } from '#components/geometry/graphics/three/actor-bridge.js';
import { cn } from '#utils/ui.utils.js';

export type ThreeViewerProperties = {
  readonly enableGizmo?: boolean;
  readonly enableGrid?: boolean;
  readonly enableAxes?: boolean;
  readonly enableZoom?: boolean;
  readonly enablePan?: boolean;
  readonly enableDamping?: boolean;
  readonly upDirection?: 'x' | 'y' | 'z';
  readonly className?: string;
  readonly enableCentering?: boolean;
  readonly stageOptions?: StageOptions;
  readonly zoomSpeed?: number;
  readonly gizmoContainer?: HTMLElement | string;
};

export type ThreeContextProperties = CanvasProps & ThreeViewerProperties;

export function ThreeProvider({
  children,
  enableGizmo = false,
  enableGrid = false,
  enableAxes = false,
  enableZoom = false,
  enablePan = false,
  enableDamping = false,
  upDirection = 'z',
  enableCentering = false,
  className,
  stageOptions,
  zoomSpeed = 2,
  gizmoContainer,
  ...properties
}: ThreeContextProperties): React.JSX.Element {
  const dpr = Math.min(globalThis.devicePixelRatio, 2);
  const [isCanvasReady, setIsCanvasReady] = useState(false);

  return (
    <Canvas
      gl={{
        // Enable logarithmic depth buffer for better precision at low field of view,
        // eliminating visual artifacts on the object.
        logarithmicDepthBuffer: true,
        antialias: true,
        // Enable stencil buffer for stencil-based cross-section rendering (Section View component)
        stencil: true,
      }}
      dpr={dpr}
      frameloop="demand"
      className={cn('bg-background', className)}
      onCreated={({ gl }) => {
        // Neutral ACES exposure -- depth contrast comes from AO and targeted directional lights.
        gl.toneMappingExposure = 1;
        setIsCanvasReady(true);
      }}
      {...properties}
    >
      <Scene
        enableGizmo={enableGizmo}
        enableCentering={enableCentering}
        enableDamping={enableDamping}
        enableZoom={enableZoom}
        enablePan={enablePan}
        upDirection={upDirection}
        stageOptions={stageOptions}
        zoomSpeed={zoomSpeed}
        gizmoContainer={gizmoContainer}
      >
        {children}
      </Scene>
      <PostProcessing />
      <SceneOverlay>
        {enableAxes ? <AxesHelper /> : null}
        {enableGrid ? <Grid /> : null}
      </SceneOverlay>
      {isCanvasReady ? <ActorBridge /> : null}
    </Canvas>
  );
}
