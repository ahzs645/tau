import React from 'react';
import type { ReactNode } from 'react';
import type * as THREE from 'three';
import { PerspectiveCamera } from '@react-three/drei';
import { Lights } from '#components/geometry/graphics/three/react/lights.js';
import { SectionView } from '#components/geometry/graphics/three/react/section-view.js';
import { useSectionView } from '#components/geometry/graphics/three/use-section-view.js';
import { useGeometryBounds } from '#components/geometry/graphics/three/use-geometry-bounds.js';
import { useCameraFraming } from '#components/geometry/graphics/three/use-camera-framing.js';
import { useGraphicsSelector } from '#hooks/use-graphics.js';

export type StageOptions = {
  /**
   * The ratio of the scene's radius to offset the camera from the center. Adjusting this value will change the applied perspective of the scene.
   */
  offsetRatio?: number;
  /**
   * The near plane of the camera.
   */
  nearPlane?: number;
  /**
   * The minimum far plane of the camera.
   */
  minimumFarPlane?: number;
  /**
   * The multiplier for the camera's far plane.
   */
  farPlaneRadiusMultiplier?: number;
  /**
   * The zoom level of the camera.
   */
  zoomLevel?: number;
  rotation?: {
    /**
     * The initial z-axis rotation of the camera in radians.
     */
    side?: number;

    /**
     * The initial xy-plane rotation of the camera in radians.
     */
    vertical?: number;
  };
};

// Default configuration constants
export const defaultStageOptions = {
  offsetRatio: 2,
  nearPlane: 1e-3,
  minimumFarPlane: 10_000_000_000,
  farPlaneRadiusMultiplier: 5,
  zoomLevel: 1,
  rotation: {
    side: -Math.PI / 4, // Default rotation is 45 degrees counter-clockwise
    vertical: Math.PI / 6, // Default rotation is 30 degrees upwards
  },
} as const satisfies StageOptions;

type StageProperties = {
  readonly children: ReactNode;
  readonly enableCentering?: boolean;
  readonly stageOptions?: StageOptions;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'id'>;

export function Stage({
  children,
  enableCentering = false,
  stageOptions = defaultStageOptions,
  ...properties
}: StageProperties): React.JSX.Element {
  const outer = React.useRef<THREE.Group>(null);
  const inner = React.useRef<THREE.Group>(null);

  const enableMatcap = useGraphicsSelector((state) => state.context.enableMatcap);
  const environmentPreset = useGraphicsSelector((state) => state.context.environmentPreset);
  const upDirection = useGraphicsSelector((state) => state.context.upDirection);

  // Section view (clipping plane + capping material)
  const sectionView = useSectionView();

  // Geometry bounds tracking (per-frame bounding sphere + optional centering)
  const { geometryRadius, geometryCenter } = useGeometryBounds(inner, outer, { enableCentering });

  // Camera framing policy (auto-reset on significant geometry changes)
  useCameraFraming(geometryRadius, geometryCenter, stageOptions);

  return (
    <group {...properties}>
      <PerspectiveCamera makeDefault />
      <group ref={outer}>
        <SectionView
          plane={sectionView.plane}
          enableSection={sectionView.isActive}
          enableLines={sectionView.enableLines}
          enableMesh={sectionView.enableMesh}
          cappingMaterial={sectionView.cappingMaterial}
        >
          <group ref={inner}>{children}</group>
        </SectionView>
      </group>
      <Lights
        enableMatcap={enableMatcap}
        environmentPreset={environmentPreset}
        sceneRadius={geometryRadius}
        upDirection={upDirection}
      />
    </group>
  );
}
