import React, { useMemo, useCallback } from 'react';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import { PerspectiveCamera } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useCameraReset } from '#components/geometry/graphics/three/use-camera-reset.js';
import { Lights } from '#components/geometry/graphics/three/react/lights.js';
import { SectionView } from '#components/geometry/graphics/three/react/section-view.js';
import { createStripedMaterial } from '#components/geometry/graphics/three/materials/striped-material.js';
import { useGraphics, useGraphicsSelector } from '#hooks/use-graphics.js';

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

const significantRadiusChangeRatio = 0.1;

// Reusable temporaries for per-frame bounding calculations (avoids GC pressure)
const _box3 = new THREE.Box3();
const _centerPoint = new THREE.Vector3();
const _sphere = new THREE.Sphere();

// Default configuration constants
export const defaultStageOptions = {
  offsetRatio: 1.5,
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

  const cameraFovAngle = useGraphicsSelector((state) => state.context.cameraFovAngle);
  const enableMatcap = useGraphicsSelector((state) => state.context.enableMatcap);
  const geometryKey = useGraphicsSelector((state) => state.context.geometryKey);
  const environmentPreset = useGraphicsSelector((state) => state.context.environmentPreset);
  const upDirection = useGraphicsSelector((state) => state.context.upDirection);

  const isSectionViewActive = useGraphicsSelector((state) => state.context.isSectionViewActive);
  const selectedSectionViewId = useGraphicsSelector((state) => state.context.selectedSectionViewId);
  // Translation is derived from pivot for display; Stage uses pivot directly
  const sectionViewRotation = useGraphicsSelector((state) => state.context.sectionViewRotation);
  const sectionViewDirection = useGraphicsSelector((state) => state.context.sectionViewDirection);
  const sectionViewPivot = useGraphicsSelector((state) => state.context.sectionViewPivot);
  const availableSectionViews = useGraphicsSelector((state) => state.context.availableSectionViews);
  const enableClippingLines = useGraphicsSelector((state) => state.context.enableClippingLines);
  const enableClippingMesh = useGraphicsSelector((state) => state.context.enableClippingMesh);
  const gridSizesComputed = useGraphicsSelector((state) => state.context.gridSizesComputed);

  // Build THREE.Plane for the SectionView component
  const sectionView = useMemo(() => {
    if (!selectedSectionViewId) {
      // Default plane when nothing is selected
      return new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    }

    const selectedPlane = availableSectionViews.find((plane) => plane.id === selectedSectionViewId);
    if (!selectedPlane) {
      return new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    }

    // Start with the base normal from the selected plane
    const normal = new THREE.Vector3(...selectedPlane.normal);

    // Apply rotation to the normal if rotation is set
    const [rotX, rotY, rotZ] = sectionViewRotation;
    if (rotX !== 0 || rotY !== 0 || rotZ !== 0) {
      const euler = new THREE.Euler(rotX, rotY, rotZ);
      normal.applyEuler(euler);
    }

    // Apply direction after rotation
    normal.multiplyScalar(-sectionViewDirection);

    // Compute plane constant from the world-space pivot point: n·p + c = 0
    // => c = -n·p. Using pivot as source of truth ensures the plane remains
    // anchored during rotations and flips while keeping display translation stable.
    const constant = -normal.dot(new THREE.Vector3(...sectionViewPivot));

    return new THREE.Plane(normal, constant);
  }, [selectedSectionViewId, sectionViewPivot, sectionViewRotation, sectionViewDirection, availableSectionViews]);

  // Create striped material for capping surface
  const cappingMaterial = useMemo(() => {
    // Use a larger multiplier (5x largeSize) to reduce visual noise from dense stripes
    const stripeSpacing = gridSizesComputed.largeSize * 0.1;
    // Width should be proportional to spacing for good visibility (10% of spacing)
    const stripeWidth = stripeSpacing * 0.2;

    return createStripedMaterial({
      stripeFrequency: stripeSpacing,
      stripeWidth,
    });
  }, [gridSizesComputed.largeSize]);

  // State for camera reset functionality
  const originalDistanceReference = React.useRef<number | undefined>(undefined);
  const isInitialResetDoneRef = React.useRef<boolean>(false);

  const [{ geometryRadius, sceneRadius }, set] = React.useState<{
    // The radius of the scene. Used to determine if the camera needs to be updated
    sceneRadius: number | undefined;
    // The radius of the geometry.
    geometryRadius: number;
  }>({
    sceneRadius: undefined,
    geometryRadius: 0,
  });

  const { offsetRatio, nearPlane, minimumFarPlane, farPlaneRadiusMultiplier, zoomLevel, rotation } = useMemo(() => {
    return {
      ...defaultStageOptions,
      ...stageOptions,
      rotation: { ...defaultStageOptions.rotation, ...stageOptions.rotation },
    };
  }, [stageOptions]);

  // Function to set scene radius
  const setSceneRadius = useCallback((radius: number) => {
    set((previous) => ({
      ...previous,
      sceneRadius: radius,
    }));
  }, []);

  // Use the camera reset hook
  const resetCamera = useCameraReset({
    geometryRadius,
    rotation: {
      side: rotation.side,
      vertical: rotation.vertical,
    },
    perspective: {
      offsetRatio,
      zoomLevel,
      nearPlane,
      minimumFarPlane,
      farPlaneRadiusMultiplier,
    },
    setSceneRadius,
    originalDistanceReference,
    cameraFovAngle,
  });

  // Track geometry key changes to avoid expensive per-frame scene traversal.
  // When geometryKey is provided, bounds are only recomputed when geometry changes
  // and until the radius stabilizes, then skipped entirely during orbit/pan/zoom.
  const lastGeometryKeyRef = React.useRef<string | undefined>(undefined);
  const boundsStableRef = React.useRef(false);

  useFrame(() => {
    if (outer.current) {
      outer.current.updateWorldMatrix(true, true);
    }

    if (!inner.current) {
      return;
    }

    // When geometryKey is provided, invalidate stability when it changes
    if (geometryKey !== lastGeometryKeyRef.current) {
      lastGeometryKeyRef.current = geometryKey;
      boundsStableRef.current = false;
    }

    // Skip expensive scene traversal once bounds have stabilized
    if (boundsStableRef.current) {
      return;
    }

    _box3.setFromObject(inner.current);

    // Don't mark stable or update state when the bounding box is empty
    // (geometry hasn't loaded yet -- GltfMesh parses GLTF asynchronously)
    if (_box3.isEmpty()) {
      return;
    }

    if (enableCentering) {
      _box3.getCenter(_centerPoint);
      if (outer.current) {
        outer.current.position.set(
          outer.current.position.x - _centerPoint.x,
          outer.current.position.y - _centerPoint.y,
          outer.current.position.z - _centerPoint.z,
        );
      }
    }

    _box3.getBoundingSphere(_sphere);

    // Only update state when the radius has actually changed to avoid unnecessary re-renders
    set((previous) => {
      if (previous.geometryRadius === _sphere.radius) {
        // Radius converged -- bounds are stable, stop polling
        boundsStableRef.current = true;
        return previous;
      }

      return { geometryRadius: _sphere.radius, sceneRadius: previous.sceneRadius };
    });
  });

  // Sync the real bounding-sphere radius to the graphics machine so other
  // components (and downstream consumers of geometryRadius) get the actual value
  // computed from the Three.js scene graph, not a placeholder.
  const graphicsActor = useGraphics();
  React.useEffect(() => {
    if (geometryRadius > 0) {
      graphicsActor.send({ type: 'sceneRadiusUpdated', radius: geometryRadius });
    }
  }, [graphicsActor, geometryRadius]);

  /**
   * Position the camera based on the scene's bounding box.
   */
  React.useLayoutEffect(() => {
    // If the scene radius is undefined, we need to initialize the camera, so we default to true.
    // Force update when camera type changes
    const changeRatio = sceneRadius === undefined ? 0 : Math.abs((geometryRadius - sceneRadius) / sceneRadius);
    const isSignificantChange = sceneRadius === undefined ? true : changeRatio > significantRadiusChangeRatio;

    if (isSignificantChange) {
      if (isInitialResetDoneRef.current) {
        resetCamera({ enableConfiguredAngles: false }); // Subsequent resets without XY rotation
      } else {
        resetCamera(); // Initial reset with rotation
        isInitialResetDoneRef.current = true;
      }
    }
  }, [resetCamera, sceneRadius, geometryRadius]);

  return (
    <group {...properties}>
      <PerspectiveCamera makeDefault />
      <group ref={outer}>
        <SectionView
          plane={sectionView}
          enableSection={Boolean(isSectionViewActive && selectedSectionViewId)}
          enableLines={enableClippingLines}
          enableMesh={enableClippingMesh}
          cappingMaterial={cappingMaterial}
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
