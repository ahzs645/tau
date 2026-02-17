import * as THREE from 'three';
import {
  calculateFovFromAngle,
  calculateFovDistanceCompensation,
  tanEpsilon,
} from '#components/geometry/graphics/three/utils/math.utils.js';

/**
 * Calculates a 3D position from spherical coordinates.
 * Converts distance (radius), horizontal angle (phi), and vertical angle (theta) into x, y, z coordinates.
 * Supports X-up, Y-up, and Z-up coordinate systems by checking THREE.Object3D.DEFAULT_UP.
 */
function calculatePositionFromSphericalCoordinates({
  distance,
  horizontalAngle,
  verticalAngle,
}: {
  distance: number;
  horizontalAngle: number;
  verticalAngle: number;
}): THREE.Vector3 {
  const cosTheta = Math.cos(verticalAngle);
  const sinTheta = Math.sin(verticalAngle);

  // Determine which axis is up by checking THREE.Object3D.DEFAULT_UP
  const isXaxisUp = THREE.Object3D.DEFAULT_UP.x === 1;
  const isYaxisUp = THREE.Object3D.DEFAULT_UP.y === 1;

  if (isXaxisUp) {
    // X-up: X is the vertical axis, Y and Z are horizontal
    const x = distance * sinTheta;
    const y = distance * cosTheta * Math.cos(horizontalAngle);
    const z = distance * cosTheta * Math.sin(horizontalAngle);
    return new THREE.Vector3(x, y, z);
  }

  if (isYaxisUp) {
    // Y-up: Y is the vertical axis, X and Z are horizontal (Z negated to match coordinate handedness)
    const x = distance * cosTheta * Math.cos(horizontalAngle);
    const y = distance * sinTheta;
    const z = -distance * cosTheta * Math.sin(horizontalAngle);
    return new THREE.Vector3(x, y, z);
  }

  // Z-up: Z is the vertical axis, X and Y are horizontal
  const x = distance * cosTheta * Math.cos(horizontalAngle);
  const y = distance * cosTheta * Math.sin(horizontalAngle);
  const z = distance * sinTheta;
  return new THREE.Vector3(x, y, z);
}

/**
 * Updates only the camera FOV based on angle, adjusting distance to maintain perceived size.
 * Does NOT reset camera position or viewing angle - preserves user's current view.
 */
export function updateCameraFov({
  camera,
  cameraFovAngle,
  invalidate,
}: {
  camera: THREE.Camera;
  cameraFovAngle: number;
  invalidate: () => void;
}): void {
  if (!(camera instanceof THREE.PerspectiveCamera)) {
    console.error('updateCameraFov requires PerspectiveCamera');
    return;
  }

  // Store old FOV before changing
  const oldFov = camera.fov;

  // Calculate and apply the new FOV
  const newFov = calculateFovFromAngle(cameraFovAngle);
  camera.fov = newFov;

  // Adjust camera distance to maintain perceived size.
  // This keeps objects the same apparent size when FOV changes.
  if (camera.position.lengthSq() >= tanEpsilon) {
    const currentDistance = camera.position.length();
    const newDistance = calculateFovDistanceCompensation(oldFov, newFov, currentDistance);

    if (newDistance !== currentDistance) {
      const direction = camera.position.clone().normalize();
      camera.position.copy(direction.multiplyScalar(newDistance));
    }
  }

  camera.updateProjectionMatrix();
  invalidate();
}

/**
 * Resets the camera to a standard position and orientation based on geometry dimensions
 * Adjusts for FOV to maintain consistent framing regardless of perspective setting
 */
export function resetCamera({
  camera,
  geometryRadius,
  geometryCenter,
  rotation,
  perspective,
  setSceneRadius,
  invalidate,
  enableConfiguredAngles,
  cameraFovAngle,
  controls,
}: {
  camera: THREE.Camera;
  geometryRadius: number;
  /**
   * The center of the geometry's bounding box. The camera will orbit around
   * and look at this point rather than the world origin, allowing geometry
   * to remain at its absolute coordinates.
   */
  geometryCenter: THREE.Vector3;
  rotation: { side: number; vertical: number };
  perspective: {
    offsetRatio: number;
    zoomLevel: number;
    nearPlane: number;
    minimumFarPlane: number;
    farPlaneRadiusMultiplier: number;
  };
  setSceneRadius: (radius: number) => void;
  invalidate: () => void;
  enableConfiguredAngles?: boolean;
  cameraFovAngle: number;
  controls?: { target: THREE.Vector3; update: () => void } | undefined;
}): void {
  if (!(camera instanceof THREE.PerspectiveCamera)) {
    console.error('resetCamera requires PerspectiveCamera');
    return;
  }

  // If the geometry radius is less than or requal to 0, we didn't get an object to render.
  // Leaving it at 0 or less results in undefined camera behavior, so we set it to 1000.
  const adjustedGeometryRadius = geometryRadius <= 0 ? 1000 : geometryRadius;

  const useConfiguredAngles = enableConfiguredAngles ?? true;

  // Calculate and apply the FOV
  const calculatedFov = calculateFovFromAngle(cameraFovAngle);
  camera.fov = calculatedFov;

  // Calculate the effective FOV that will be active after this reset, due to perspective.zoomLevel
  let effectiveFovForAdjustment = calculatedFov;
  if (useConfiguredAngles) {
    effectiveFovForAdjustment =
      THREE.MathUtils.RAD2DEG *
      2 *
      Math.atan(Math.tan((THREE.MathUtils.DEG2RAD * calculatedFov) / 2) / perspective.zoomLevel);
  }

  const standardFov = 60;
  // Distance compensation ratio: pass distance=1 to get the pure tan(std/2)/tan(eff/2) ratio
  const adjustedOffsetRatio =
    perspective.offsetRatio * calculateFovDistanceCompensation(standardFov, effectiveFovForAdjustment, 1);
  const newDistance = adjustedGeometryRadius * adjustedOffsetRatio;

  if (useConfiguredAngles) {
    // Use configured rotation angles (side and vertical) for positioning
    // Offset from the geometry center so the camera orbits around it
    const offset = calculatePositionFromSphericalCoordinates({
      distance: newDistance,
      horizontalAngle: rotation.side,
      verticalAngle: rotation.vertical,
    });
    camera.position.copy(geometryCenter).add(offset);
  } else if (camera.position.distanceToSquared(geometryCenter) >= 1e-9) {
    // Maintain current viewing direction if not at center, only adjust distance
    const currentDirection = camera.position.clone().sub(geometryCenter).normalize();
    camera.position.copy(geometryCenter).add(currentDirection.multiplyScalar(newDistance));
  } else {
    // Fallback for non-configured angle mode: If at center or too close, use configured angles to set an initial safe direction.
    const offset = calculatePositionFromSphericalCoordinates({
      distance: newDistance,
      horizontalAngle: rotation.side,
      verticalAngle: rotation.vertical,
    });
    camera.position.copy(geometryCenter).add(offset);
  }

  camera.zoom = perspective.zoomLevel;
  camera.near = perspective.nearPlane;
  camera.far = Math.max(perspective.minimumFarPlane, adjustedGeometryRadius * perspective.farPlaneRadiusMultiplier);

  // Aim the camera at the geometry center
  camera.lookAt(geometryCenter);

  // Update orbit controls target so the user orbits around the geometry center
  if (controls) {
    controls.target.copy(geometryCenter);
    controls.update();
  }

  // Update the scene radius
  setSceneRadius(geometryRadius);

  camera.updateProjectionMatrix();
  invalidate();
}
