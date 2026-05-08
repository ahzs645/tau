/**
 * Shared utilities for viewport gizmo components.
 *
 * Extracts common logic (canvas/renderer creation, FOV synchronization,
 * container resolution, resource cleanup) so that the individual gizmo
 * components only need to declare their configuration differences.
 */

import type { ViewportGizmo } from 'three-viewport-gizmo';
import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { ResolvedGraphicsBackend } from '#constants/editor.constants.js';
import { createTauRenderer } from '#components/geometry/graphics/three/tau-renderer.js';
import {
  calculateGizmoFovFromAngle,
  calculateFovDistanceCompensation,
  gizmoBaseFov,
  gizmoBaseDistance,
  gizmoDepthMargin,
  gizmoFocusOffset,
} from '#components/geometry/graphics/three/utils/math.utils.js';

/** Renderer used by the overlay `ViewportGizmo` instances. */
export type GizmoRenderer = THREE.WebGLRenderer | InstanceType<typeof WebGPURenderer>;

// ── FOV synchronization ─────────────────────────────────────────────────────

/**
 * Synchronize the gizmo's internal camera FOV with the viewport camera FOV.
 *
 * The `three-viewport-gizmo` library creates its own internal PerspectiveCamera
 * (accessed via the private `_camera` property) with hardcoded defaults (FOV=26,
 * distance=7). This function updates that internal camera so the gizmo shows the
 * same perspective as the main viewport, while compensating the camera distance to
 * keep the gizmo cube at a consistent apparent size.
 *
 * NOTE: `_camera` is a non-public property. If the library ever exposes a public
 * FOV API, this should be migrated. The runtime `instanceof` guard ensures a
 * silent no-op if the internal structure changes.
 */
export function syncGizmoFov(gizmo: ViewportGizmo, cameraFovAngle: number): void {
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing private _camera property; no public FOV API exists
  const internalCamera = (gizmo as unknown as { _camera: THREE.PerspectiveCamera })._camera;
  if (!(internalCamera instanceof THREE.PerspectiveCamera)) {
    return;
  }

  const gizmoFov = calculateGizmoFovFromAngle(cameraFovAngle);
  const newDistance = calculateFovDistanceCompensation(gizmoBaseFov, gizmoFov, gizmoBaseDistance, gizmoFocusOffset);

  internalCamera.fov = gizmoFov;
  internalCamera.position.set(0, 0, newDistance);
  internalCamera.near = Math.max(0.01, newDistance - gizmoDepthMargin);
  internalCamera.far = newDistance + gizmoDepthMargin;
  internalCamera.updateProjectionMatrix();
}

// ── Container resolution ────────────────────────────────────────────────────

/**
 * Resolve the gizmo container element from a string selector, an element
 * reference, or fall back to the renderer's parent element.
 *
 * @returns The resolved container, or `undefined` if none could be found.
 */
export function resolveGizmoContainer(
  container: HTMLElement | string | undefined,
  glDomElement: HTMLCanvasElement,
): HTMLElement | undefined {
  if (typeof container === 'string') {
    return document.querySelector<HTMLElement>(container) ?? undefined;
  }

  return container ?? glDomElement.parentElement ?? undefined;
}

// ── Canvas & renderer creation ──────────────────────────────────────────────

/**
 * Create and configure a canvas element for a viewport gizmo overlay.
 *
 * The canvas is absolutely positioned at bottom-right with a z-index of 10,
 * matching the convention used by all gizmo variants.
 */
export function createGizmoCanvas(className: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = className;
  canvas.style.position = 'absolute';
  canvas.style.bottom = '0';
  canvas.style.right = '0';
  canvas.style.zIndex = '10';
  return canvas;
}

export function disposeStandaloneGizmoRenderer(renderer: GizmoRenderer): void {
  if ('forceContextLoss' in renderer && typeof renderer.forceContextLoss === 'function') {
    renderer.forceContextLoss();
  }

  renderer.dispose();
}

export async function createGizmoRendererForBackend(
  canvas: HTMLCanvasElement,
  size: number,
  backend: ResolvedGraphicsBackend,
): Promise<GizmoRenderer> {
  const renderer = await createTauRenderer('gizmo', backend, canvas);
  renderer.setSize(size, size);
  const dpr = Math.min(globalThis.devicePixelRatio, 2);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x00_00_00, 0);
  return renderer;
}

// ── Resource cleanup ────────────────────────────────────────────────────────

/**
 * Dispose all resources created for a viewport gizmo.
 *
 * Removes event listeners, disposes the gizmo and renderer, removes the
 * canvas from the DOM, and forces WebGL context loss to prevent GPU context
 * exhaustion where applicable (WebGPU has no analogous API).
 */
export function disposeGizmoResources({
  gizmo,
  renderer,
  canvas,
  handleChange,
}: {
  gizmo: ViewportGizmo;
  renderer: GizmoRenderer;
  canvas: HTMLCanvasElement;
  handleChange: () => void;
}): void {
  gizmo.removeEventListener('change', handleChange);
  gizmo.removeEventListener('hoverchange', handleChange);
  gizmo.dispose();

  if (canvas.parentElement) {
    canvas.remove();
  }

  disposeStandaloneGizmoRenderer(renderer);
}
