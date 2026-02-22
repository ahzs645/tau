/* eslint-disable @typescript-eslint/no-unnecessary-condition -- TODO: review these types, some are actually required */
import { useThree, useFrame } from '@react-three/fiber';
import type { GizmoAxisOptions, GizmoOptions } from 'three-viewport-gizmo';
import { ViewportGizmo } from 'three-viewport-gizmo';
import { useEffect, useCallback, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons';
import type { ReactNode } from 'react';
import { useColor } from '#hooks/use-color.js';
import { Theme, useTheme } from '#hooks/use-theme.js';
import { createViewportGizmoCubeAxes } from '#components/geometry/graphics/three/controls/viewport-gizmo-cube-axes.js';
import { useGraphicsSelector } from '#hooks/use-graphics.js';
import {
  syncGizmoFov,
  resolveGizmoContainer,
  createGizmoCanvas,
  createGizmoRenderer,
  disposeGizmoResources,
} from '#components/geometry/graphics/three/utils/gizmo.utils.js';

type ViewportGizmoCubeProps = {
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
   * Useful for triggering recreation when coordinate systems or other external state changes.
   *
   * @example
   * ```tsx
   * <ViewportGizmoCube dependencies={[enableYupRotation]} />
   * ```
   */
  readonly dependencies?: readonly unknown[];
};

const className = 'viewport-gizmo-cube';
const emptyDependencies: readonly unknown[] = [];

export function ViewportGizmoCube({
  size = 96,
  container,
  dependencies = emptyDependencies,
}: ViewportGizmoCubeProps): ReactNode {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const gl = useThree((state) => state.gl);
  const controls = useThree((state) => state.controls) as OrbitControls;
  const scene = useThree((state) => state.scene);
  const invalidate = useThree((state) => state.invalidate);

  const { serialized } = useColor();
  const { theme } = useTheme();

  // Subscribe to the viewport FOV from the per-view graphics machine
  const cameraFovAngle = useGraphicsSelector((state) => state.context.cameraFovAngle);

  // Keep a ref to the current angle so the creation effect can read it without
  // adding cameraFovAngle as a dependency (which would cause expensive recreation)
  const cameraFovAngleRef = useRef(cameraFovAngle);
  cameraFovAngleRef.current = cameraFovAngle;

  // Ref to the live gizmo instance for the FOV sync effect
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- React ref
  const gizmoRef = useRef<ViewportGizmo | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- React ref
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  const handleChange = useCallback((): void => {
    invalidate();
  }, [invalidate]);

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

    const faceConfig = {
      color: theme === Theme.DARK ? 0x33_33_33 : 0xdd_dd_dd,
      labelColor: theme === Theme.DARK ? 0xff_ff_ff : 0x00_00_00,
      hover: {
        color: serialized.hex,
      },
    } as const satisfies GizmoAxisOptions;
    const edgeConfig = {
      color: theme === Theme.DARK ? 0x55_55_55 : 0xee_ee_ee,
      opacity: 1,
      hover: {
        color: serialized.hex,
      },
    } as const satisfies GizmoAxisOptions;
    const cornerConfig = {
      ...faceConfig,
      color: theme === Theme.DARK ? 0x33_33_33 : 0xdd_dd_dd,
      hover: {
        color: serialized.hex,
      },
    } as const satisfies GizmoAxisOptions;

    // Configure the gizmo options
    const gizmoConfig: GizmoOptions = {
      type: 'rounded-cube',
      placement: 'bottom-right',
      size,
      font: {
        weight: 'normal',
        family: 'monospace',
      },
      radius: 0.3,
      offset: {
        bottom: 0,
        right: 0,
      },
      className,
      resolution: 256,
      container: containerToUse,
      corners: cornerConfig,
      edges: edgeConfig,
      right: faceConfig,
      top: faceConfig,
      front: faceConfig,
      back: faceConfig,
      left: faceConfig,
      bottom: faceConfig,
    };

    // Create the gizmo
    const gizmo = new ViewportGizmo(camera, renderer, gizmoConfig);
    gizmoRef.current = gizmo;
    rendererRef.current = renderer;

    // Synchronize the gizmo's internal camera FOV with the current viewport FOV
    syncGizmoFov(gizmo, cameraFovAngleRef.current);

    // Add event listeners for the gizmo
    gizmo.addEventListener('change', handleChange);

    gizmo.scale.multiplyScalar(0.7);
    gizmo.add(
      createViewportGizmoCubeAxes({
        axesSize: 2.1,
        rendererSize: size,
        xAxisColor: 'red',
        yAxisColor: 'green',
        zAxisColor: 'rgb(37, 78, 136)',
        xLabelColor: 'red',
        yLabelColor: 'green',
        zLabelColor: 'rgb(37, 78, 136)',
        lineWidth: 2,
      }),
    );

    // Attach the controls to enable proper interaction
    gizmo.attachControls(controls);

    // Cleanup function
    return () => {
      // Clear refs so the useFrame and FOV sync effect cannot operate on disposed objects
      gizmoRef.current = null;
      rendererRef.current = null;

      disposeGizmoResources(gizmo, renderer, canvas, handleChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dependencies array is user-provided for custom recreation triggers
  }, [camera, gl, controls, scene, serialized.hex, theme, size, handleChange, container, ...dependencies]);

  // Demand-based gizmo rendering: only render when the R3F frame loop fires (on invalidation)
  useFrame(() => {
    if (rendererRef.current && gizmoRef.current) {
      rendererRef.current.toneMapping = THREE.NoToneMapping;
      gizmoRef.current.render();
    }
  });

  // Real-time FOV sync: update the gizmo's internal camera when the viewport FOV changes.
  // This is a separate effect to avoid expensive gizmo recreation on every slider tick.
  useEffect(() => {
    if (gizmoRef.current) {
      syncGizmoFov(gizmoRef.current, cameraFovAngle);
    }
  }, [cameraFovAngle]);

  return null;
}
