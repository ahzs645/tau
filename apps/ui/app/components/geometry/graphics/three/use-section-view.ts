import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { createStripedMaterial } from '#components/geometry/graphics/three/materials/striped-material.js';
import { useGraphicsSelector } from '#hooks/use-graphics.js';

export type SectionViewState = {
  /** The computed clipping plane for the active section view. */
  readonly plane: THREE.Plane;
  /** The capping material used for the cross-section surface. */
  readonly cappingMaterial: THREE.ShaderMaterial;
  /** Whether the section view is currently active and has a selected plane. */
  readonly isActive: boolean;
  /** The ID of the selected section view plane, if any. */
  readonly selectedId: string | undefined;
  /** Whether clipping lines are enabled. */
  readonly enableLines: boolean;
  /** Whether the clipping mesh (capping surface) is enabled. */
  readonly enableMesh: boolean;
};

const defaultPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

/**
 * Reads section view state from the graphics context and computes the derived
 * THREE.Plane and capping material. Fully self-contained -- no external refs
 * or props required.
 *
 * The capping material is automatically disposed when its dependencies change
 * and on unmount to prevent GPU resource leaks.
 */
export function useSectionView(): SectionViewState {
  const isSectionViewActive = useGraphicsSelector((state) => state.context.isSectionViewActive);
  const selectedSectionViewId = useGraphicsSelector((state) => state.context.selectedSectionViewId);
  const sectionViewRotation = useGraphicsSelector((state) => state.context.sectionViewRotation);
  const sectionViewDirection = useGraphicsSelector((state) => state.context.sectionViewDirection);
  const sectionViewPivot = useGraphicsSelector((state) => state.context.sectionViewPivot);
  const availableSectionViews = useGraphicsSelector((state) => state.context.availableSectionViews);
  const enableClippingLines = useGraphicsSelector((state) => state.context.enableClippingLines);
  const enableClippingMesh = useGraphicsSelector((state) => state.context.enableClippingMesh);
  const gridSizesComputed = useGraphicsSelector((state) => state.context.gridSizesComputed);

  // Compute the clipping plane from the selected section view configuration
  const plane = useMemo(() => {
    if (!selectedSectionViewId) {
      return defaultPlane;
    }

    const selectedPlane = availableSectionViews.find((p) => p.id === selectedSectionViewId);
    if (!selectedPlane) {
      return defaultPlane;
    }

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

  // Create striped material for the capping surface.
  // Tracked via ref so the previous material can be disposed when deps change or on unmount.
  const cappingMaterialRef = useRef<THREE.ShaderMaterial | undefined>(undefined);

  const cappingMaterial = useMemo(() => {
    cappingMaterialRef.current?.dispose();

    const stripeSpacing = gridSizesComputed.largeSize * 0.1;
    const stripeWidth = stripeSpacing * 0.2;

    const material = createStripedMaterial({
      stripeFrequency: stripeSpacing,
      stripeWidth,
    });

    cappingMaterialRef.current = material;
    return material;
  }, [gridSizesComputed.largeSize]);

  // Dispose capping material on unmount
  useEffect(() => {
    return () => {
      cappingMaterialRef.current?.dispose();
    };
  }, []);

  return {
    plane,
    cappingMaterial,
    isActive: Boolean(isSectionViewActive && selectedSectionViewId),
    selectedId: selectedSectionViewId,
    enableLines: enableClippingLines,
    enableMesh: enableClippingMesh,
  };
}
