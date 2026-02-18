import type { CanvasProps } from '@react-three/fiber';
import { Canvas } from '@react-three/fiber';
import { useCallback, useEffect, useState } from 'react';
import { Scene } from '#components/geometry/graphics/three/scene.js';
import { SceneOverlay } from '#components/geometry/graphics/three/scene-overlay.js';
import { PostProcessing } from '#components/geometry/graphics/three/post-processing.js';
import type { StageOptions } from '#components/geometry/graphics/three/stage.js';
import { Grid } from '#components/geometry/graphics/three/grid.js';
import { AxesHelper } from '#components/geometry/graphics/three/react/axes-helper.js';
import { ActorBridge } from '#components/geometry/graphics/three/actor-bridge.js';
import { cn } from '#utils/ui.utils.js';
import { useWebglContextRef } from '#hooks/use-webgl-context-tracker.js';
import { WebglContextLostFallback } from '#components/geometry/graphics/three/webgl-context-lost-fallback.js';
import { WebglLimitFallback } from '#components/geometry/cad/webgl-fallback.js';

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
  const [isContextLost, setIsContextLost] = useState(false);

  // Read the actor snapshot once at mount to decide whether we can create a
  // new WebGL context.  This is intentionally NON-reactive -- we never
  // subscribe to count changes.  A reactive subscription in the parent
  // (CadViewer) or here would cause an infinite re-render loop because
  // acquire/release events (sent during effect mount/cleanup) would
  // synchronously flip `isAtLimit`, triggering mount -> acquire -> re-render ->
  // unmount -> release -> re-render -> mount ... ad infinitum.
  //
  // `webglRef` is `undefined` when no `<WebglContextTrackerProvider>` is
  // mounted above this component (e.g. single-viewer pages like the landing
  // page, converter, preview, etc.).  In that case we skip tracking entirely.
  const webglRef = useWebglContextRef();

  // eslint-disable-next-line react/hook-use-state -- one-time snapshot, setter intentionally unused
  const [isOverLimit] = useState(() => {
    if (!webglRef) {
      return false;
    }

    const snap = webglRef.getSnapshot();
    return snap.context.count >= snap.context.limit;
  });

  useEffect(() => {
    if (!webglRef || isOverLimit) {
      return;
    }

    webglRef.send({ type: 'acquire' });
    return () => {
      webglRef.send({ type: 'release' });
    };
  }, [webglRef, isOverLimit]);

  // Remount the Canvas to recover from context loss or to retry after the
  // WebGL context limit was reached.  Changing the key forces React to
  // unmount the old instance and mount a fresh one that re-evaluates the
  // snapshot.
  const [canvasKey, setCanvasKey] = useState(0);
  const handleRetry = useCallback(() => {
    setIsContextLost(false);
    setIsCanvasReady(false);
    setCanvasKey((previous) => previous + 1);
  }, []);

  if (isOverLimit) {
    return <WebglLimitFallback onRetry={handleRetry} />;
  }

  if (isContextLost) {
    return <WebglContextLostFallback onRetry={handleRetry} />;
  }

  return (
    <Canvas
      key={canvasKey}
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

        // Listen for WebGL context loss events on the underlying canvas element.
        // preventDefault() tells the browser we intend to handle restoration ourselves.
        const canvas = gl.domElement;
        canvas.addEventListener('webglcontextlost', (event) => {
          event.preventDefault();
          setIsContextLost(true);
        });

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
