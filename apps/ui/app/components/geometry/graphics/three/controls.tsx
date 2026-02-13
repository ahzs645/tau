import { OrbitControls } from '@react-three/drei';
import React from 'react';
import type * as THREE from 'three';
import { ViewportGizmoCube } from '#components/geometry/graphics/three/controls/viewport-gizmo-cube.js';
import { SectionViewControls } from '#components/geometry/graphics/three/react/section-view-controls.js';
import { MeasureTool } from '#components/geometry/graphics/three/react/measure-tool.js';
import { useGraphics, useGraphicsSelector } from '#hooks/use-graphics.js';

type ControlsProperties = {
  /**
   * @description Whether to enable the gizmo for the viewport.
   */
  readonly enableGizmo: boolean;
  /**
   * @description Whether to enable damping for the camera.
   */
  readonly enableDamping: boolean;
  /**
   * @description Whether to enable zooming for the camera.
   */
  readonly enableZoom: boolean;
  /**
   * @description Whether to enable panning for the camera.
   */
  readonly enablePan: boolean;
  /**
   * @description The speed of the camera zoom.
   */
  readonly zoomSpeed: number;
  /**
   * A container element or selector to append the gizmo to.
   */
  readonly gizmoContainer?: HTMLElement | string;
};

export const Controls = React.memo(function ({
  enableGizmo,
  enableDamping,
  enableZoom,
  enablePan,
  zoomSpeed,
  gizmoContainer,
}: ControlsProperties) {
  const graphicsActor = useGraphics();
  const isActive = useGraphicsSelector((state) => state.context.isSectionViewActive);
  const selectedPlaneId = useGraphicsSelector((state) => state.context.selectedSectionViewId);
  const rotation = useGraphicsSelector((state) => state.context.sectionViewRotation);
  const pivot = useGraphicsSelector((state) => state.context.sectionViewPivot);
  const availablePlanes = useGraphicsSelector((state) => state.context.availableSectionViews);
  const planeName = useGraphicsSelector((state) => state.context.planeName);
  const hoveredSectionViewId = useGraphicsSelector((state) => state.context.hoveredSectionViewId);
  const upDirection = useGraphicsSelector((state) => state.context.upDirection);

  // Handlers to send events to xstate
  const handleSelectPlane = (planeId: 'xy' | 'xz' | 'yz' | 'yx' | 'zx' | 'zy'): void => {
    const id = planeId.toLowerCase() as 'xy' | 'xz' | 'yz' | 'yx' | 'zx' | 'zy';
    const isInverse = id === 'yx' || id === 'zx' || id === 'zy';
    const base: 'xy' | 'xz' | 'yz' = ((): 'xy' | 'xz' | 'yz' => {
      if (id === 'xy' || id === 'yx') {
        return 'xy';
      }

      if (id === 'xz' || id === 'zx') {
        return 'xz';
      }

      return 'yz';
    })();
    const newDir: 1 | -1 = isInverse ? -1 : 1;
    graphicsActor.send({ type: 'selectSectionView', payload: base });
    graphicsActor.send({ type: 'setSectionViewDirection', payload: newDir });
  };

  const handleSetRotation = (eulerRotation: THREE.Euler): void => {
    graphicsActor.send({
      type: 'setSectionViewRotation',
      payload: [eulerRotation.x, eulerRotation.y, eulerRotation.z],
    });
  };

  const handleSetPivot = (value: [number, number, number]): void => {
    graphicsActor.send({ type: 'setSectionViewPivot', payload: value });
  };

  const handleHover = (planeId: 'xy' | 'xz' | 'yz' | 'yx' | 'zx' | 'zy' | undefined): void => {
    graphicsActor.send({ type: 'setHoveredSectionView', payload: planeId });
  };

  return (
    <>
      <OrbitControls
        makeDefault
        zoomSpeed={zoomSpeed}
        enablePan={enablePan}
        enableDamping={enableDamping}
        enableZoom={enableZoom}
      />
      <MeasureTool />
      <SectionViewControls
        isActive={isActive}
        selectedPlaneId={selectedPlaneId}
        availablePlanes={availablePlanes}
        rotation={rotation}
        pivot={pivot}
        planeName={planeName}
        hoveredSectionViewId={hoveredSectionViewId}
        upDirection={upDirection}
        onSelectPlane={handleSelectPlane}
        onHover={handleHover}
        onSetRotation={handleSetRotation}
        onSetPivot={handleSetPivot}
      />
      {enableGizmo ? <ViewportGizmoCube container={gizmoContainer} dependencies={[upDirection]} /> : null}
    </>
  );
});
