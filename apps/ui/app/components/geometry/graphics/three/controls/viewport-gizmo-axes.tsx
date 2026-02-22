/* eslint-disable @typescript-eslint/no-unnecessary-condition -- TODO: review these types, some are actually required */
import { useThree, useFrame } from '@react-three/fiber';
import type { GizmoOptions } from 'three-viewport-gizmo';
import { ViewportGizmo } from 'three-viewport-gizmo';
import { useEffect, useCallback, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons';
import type { ReactNode } from 'react';
import { useColor } from '#hooks/use-color.js';
import { useTheme } from '#hooks/use-theme.js';
import {
  resolveGizmoContainer,
  createGizmoCanvas,
  createGizmoRenderer,
  disposeGizmoResources,
} from '#components/geometry/graphics/three/utils/gizmo.utils.js';

type ViewportGizmoAxesProps = {
  readonly size?: number;
  /**
   * A container element or selector to append the gizmo to.
   *
   * When provided, the gizmo will be appended to this container instead of the renderer's parent.
   */
  readonly container?: HTMLElement | string;
  /**
   * Optional dependencies array that will be appended to the effect dependencies.
   * When any of these values change, the gizmo will be disposed and recreated.
   */
  readonly dependencies?: readonly unknown[];
};

const className = 'viewport-gizmo-axes';
const emptyDependencies: readonly unknown[] = [];

export function ViewportGizmoAxes({
  size = 96,
  container,
  dependencies = emptyDependencies,
}: ViewportGizmoAxesProps): ReactNode {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const gl = useThree((state) => state.gl);
  const controls = useThree((state) => state.controls) as OrbitControls;
  const scene = useThree((state) => state.scene);
  const invalidate = useThree((state) => state.invalidate);

  const { serialized } = useColor();
  const { theme } = useTheme();

  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- React ref
  const gizmoRef = useRef<ViewportGizmo | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- React ref
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  const handleChange = useCallback((): void => {
    invalidate();
  }, [invalidate]);

  // Demand-based gizmo rendering: only render when the R3F frame loop fires (on invalidation)
  useFrame(() => {
    if (rendererRef.current && gizmoRef.current) {
      rendererRef.current.toneMapping = THREE.NoToneMapping;
      gizmoRef.current.render();
    }
  });

  // Create DOM overlay for gizmo
  useEffect(() => {
    // Early return if we don't have the required components
    if (!camera || !gl || !controls) {
      return;
    }

    const canvas = createGizmoCanvas(className);

    const containerToUse = resolveGizmoContainer(container, gl.domElement);
    if (!containerToUse) {
      return;
    }

    containerToUse.append(canvas);

    const renderer = createGizmoRenderer(canvas, size);

    // Configure the gizmo options
    const gizmoConfig: GizmoOptions = {
      type: 'sphere',
      placement: 'bottom-right',
      size,
      resolution: 256,
      className,
      container: containerToUse,
      font: {
        weight: 'normal',
        family: 'monospace',
      },
      offset: {
        bottom: 0,
        right: 0,
      },
    };

    // Create the gizmo
    const gizmo = new ViewportGizmo(camera, renderer, gizmoConfig);
    gizmoRef.current = gizmo;
    rendererRef.current = renderer;

    // Add event listeners for the gizmo
    gizmo.addEventListener('change', handleChange);

    gizmo.scale.multiplyScalar(0.7);

    // Attach the controls to enable proper interaction
    gizmo.attachControls(controls);

    // Cleanup function
    return () => {
      // Clear refs so the useFrame callback cannot operate on disposed objects
      gizmoRef.current = null;
      rendererRef.current = null;

      disposeGizmoResources(gizmo, renderer, canvas, handleChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dependencies array is user-provided for custom recreation triggers
  }, [camera, gl, controls, scene, serialized.hex, theme, size, handleChange, container, ...dependencies]);

  return null;
}
