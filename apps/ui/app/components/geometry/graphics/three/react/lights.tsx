import { useRef } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import { calculateFovLightingCompensation } from '#components/geometry/graphics/three/utils/math.utils.js';

// ── Lighting constants ─────────────────────────────────────────────────────
// All tuning values live at module scope for easy adjustment.

/** Ambient fill -- provides base illumination floor so no surface is fully dark. */
const ambientIntensity = 0.05;

/**
 * Camera-relative headlamp -- directional light with stable world-up placement
 * plus a camera-right skew so the specular lobe shifts toward upper-right.
 *
 * Reduced from 0.5 since the camera-relative environment now provides directional
 * variation. The headlamp is retained primarily as part of the FOV diffuse
 * compensation system (its intensity is boosted at low FOV).
 */
const headlampIntensity = 0.8;
/** Headlamp offsets (multipliers of sceneRadius). */
const headlampRightOffset = -0.1;
const headlampUpOffset = 2.1;
const headlampTargetRightSkew = 0.2;
const headlampTargetUpSkew = 0.1;

/**
 * Scene-level environment intensity (base value) -- the primary illumination source.
 * The environment rotates with the camera (camera-relative) so that lighting is
 * consistent regardless of orbit angle. This base value is scaled per-frame by the
 * FOV compensation factor.
 */
const sceneEnvironmentIntensity = 0.9;

/** Environment cubemap resolution (px). Higher = sharper specular reflections. */
const envResolution = 512;

// Studio preset Lightformer intensities ──────────────────────────────────────
// Asymmetric camera-space rig matching Onshape's observed pattern.
// Key upper-left, fill right, top overhead, ground below, back-fill behind.

/** Key panel (right-upper in camera space) -- brightest light, creates NE-bright gradient. */
const studioKeyIntensity = 4;
/** Left-upper fill (left-upper in camera space) -- illuminates left-facing L sections (WNW/NW-left). */
const studioLeftFillIntensity = 1.2;
/** Top panel (overhead in camera space) -- subtle overhead accent on sloped surfaces. */
const studioTopIntensity = 0.25;
/** Ground panel (below in camera space) -- bright for bottom-view luminosity. */
const studioGroundIntensity = 1.5;
/** Specular highlight panel (upper-right for bottom face) -- creates focused off-center specular on flat faces. */
const studioBackFillIntensity = 8;

/** Scratch vectors used inside useFrame to avoid allocations. */
const _scratchVec3 = new THREE.Vector3();
const _scratchVec3A = new THREE.Vector3();
const _scratchVec3B = new THREE.Vector3();
const _scratchVec3C = new THREE.Vector3();
const _scratchQuaternion = new THREE.Quaternion();
const _scratchEuler = new THREE.Euler();
// Neutral preset Lightformer intensities ─────────────────────────────────────
const neutralKeyIntensity = 0.6;
const neutralGroundIntensity = 0.2;

type UpDirection = 'x' | 'y' | 'z';

type LightsProperties = {
  readonly enableMatcap?: boolean;
  readonly sceneRadius?: number;
  readonly environmentPreset?: 'studio' | 'neutral' | 'soft' | 'performance';
  readonly upDirection?: UpDirection;
};

/**
 * Professional CAD lighting setup matching Onshape's rendering style.
 *
 * Design principles:
 * 1. **Camera-locked environment** — `scene.environmentRotation` is driven from
 *    the inverse camera world quaternion each frame so all Lightformers stay
 *    fully camera-bound (yaw/pitch/roll).
 *
 * 2. **Asymmetric camera-space lightformers** — Key panel upper-left, fill right,
 *    top overhead, ground below, and back-fill behind camera. This matches Onshape's
 *    observed lighting pattern (upper-left brightest, lower-right darkest).
 *
 * 3. **FOV compensation** — As FOV decreases toward orthographic, specular highlights
 *    wash out (parallel view rays → uniform reflection). A multi-lever system scales
 *    down `scene.environmentIntensity` at low FOV while boosting headlamp and ambient
 *    to compensate diffuse loss. No material changes.
 *
 * 4. **Camera-space headlamp** — A subtle directional light offset in camera-up
 *    and camera-right directions so the highlight remains biased toward screen
 *    upper-right.
 *
 * 5. **Scale-adaptive** — All Lightformer positions and scales are expressed as
 *    multiples of `sceneRadius` so lighting adapts to model size.
 */
export function Lights({
  enableMatcap = false,
  sceneRadius = 0,
  environmentPreset = 'studio',
  upDirection = 'z',
}: LightsProperties): React.JSX.Element {
  const { camera, scene } = useThree();
  const cameraLightReference = useRef<THREE.DirectionalLight>(null);
  const ambientReference = useRef<THREE.AmbientLight>(null);

  // Clamp sceneRadius to avoid zero/tiny values before geometry loads
  const r = Math.max(sceneRadius, 1);

  // Keep clamped radius accessible in useFrame without re-subscribing
  const radiusRef = useRef(r);
  radiusRef.current = r;

  // Per-frame updates:
  // 1. Read camera FOV and compute FOV-dependent compensation factors.
  // 2. Apply compensated environment intensity.
  // 3. Rotate environment to follow camera (camera-locked lighting).
  // 4. Apply compensated headlamp + ambient intensities.
  // 5. Position the headlamp above camera with rightward skew.
  useFrame(() => {
    // Read the actual camera FOV (may differ from slider due to zoom)
    const currentFov = (camera as THREE.PerspectiveCamera).fov;
    const compensation = calculateFovLightingCompensation(currentFov);

    // Primary: reduce environment intensity at low FOV (dims specular wash)
    scene.environmentIntensity = sceneEnvironmentIntensity * compensation.envFactor;

    // Camera-locked environment: apply full world->camera cancellation so every
    // Lightformer remains camera-bound (including roll), not just azimuth-bound.
    //
    // Three.js internally negates all Euler components of environmentRotation
    // (WebGLMaterials.js "accommodate left-handed frame"), so we pre-negate.
    //
    // Choose an extraction order aligned to configured up axis for robustness.
    const eulerOrder: THREE.EulerOrder = upDirection === 'y' ? 'YXZ' : upDirection === 'z' ? 'ZXY' : 'XZY';
    camera.getWorldQuaternion(_scratchQuaternion).invert();
    _scratchEuler.setFromQuaternion(_scratchQuaternion, eulerOrder);
    scene.environmentRotation.set(-_scratchEuler.x, -_scratchEuler.y, -_scratchEuler.z, eulerOrder);

    // Compensate diffuse loss with ambient boost
    if (ambientReference.current) {
      ambientReference.current.intensity = ambientIntensity * compensation.ambientFactor;
    }

    if (cameraLightReference.current) {
      // Compensate diffuse loss with headlamp boost
      cameraLightReference.current.intensity = headlampIntensity * compensation.headlampFactor;

      const currentRadius = radiusRef.current;

      // Camera basis vectors in world space:
      // - local +X: camera-right
      // - local +Y: camera-up
      _scratchVec3A.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      _scratchVec3B.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

      // Use pure camera-space offsets to keep directional lighting invariant
      // under azimuth rotations around the configured world up axis.
      _scratchVec3.copy(camera.position);
      _scratchVec3.addScaledVector(_scratchVec3B, currentRadius * headlampUpOffset);
      _scratchVec3.addScaledVector(_scratchVec3A, currentRadius * headlampRightOffset);
      cameraLightReference.current.position.copy(_scratchVec3);

      // Aim in camera space (forward with slight lower-left bias) so directional
      // response stays consistent across per-viewport orbit/target variations.
      camera.getWorldDirection(_scratchVec3C);
      _scratchVec3C.normalize();

      cameraLightReference.current.target.position.copy(camera.position);
      cameraLightReference.current.target.position.addScaledVector(_scratchVec3C, currentRadius * 2);
      cameraLightReference.current.target.position.addScaledVector(
        _scratchVec3A,
        -currentRadius * headlampTargetRightSkew,
      );
      cameraLightReference.current.target.position.addScaledVector(
        _scratchVec3B,
        -currentRadius * headlampTargetUpSkew,
      );
      cameraLightReference.current.target.updateMatrixWorld();
    }
  });

  const showEnvironment = !enableMatcap && (environmentPreset === 'studio' || environmentPreset === 'neutral');

  return (
    <>
      {/* Base ambient fill -- always present for minimum illumination */}
      <ambientLight ref={ambientReference} intensity={ambientIntensity} />

      {/* Headlamp -- positioned above camera in world space for top-down gradients */}
      <directionalLight ref={cameraLightReference} intensity={headlampIntensity} color="white" />

      {showEnvironment ? (
        <Environment resolution={envResolution}>
          {environmentPreset === 'studio' ? (
            <>
              {/* ── Key panel (right-upper in camera space) ── */}
              {/* Brightest side light. Positioned primarily to the right of the
                  camera with moderate upward offset. Creates the NE-bright
                  gradient (NNE, ENE lit) while keeping NNW dark. */}
              <Lightformer
                form="rect"
                intensity={studioKeyIntensity}
                position={[r * 4, r * 1.5, r]}
                rotation={[Math.PI / 8, -Math.PI / 3, 0]}
                scale={[r * 4, r * 4, 1]}
              />
              {/* ── Left-upper fill (left-upper in camera space) ── */}
              {/* Illuminates left-facing L sections (WNW = NW-left) that the
                  rightward key cannot reach. Env_x dominant negative with moderate
                  +env_y so WNW (env_y=0.38) gets more than WSW (env_y=-0.38). */}
              <Lightformer
                form="rect"
                intensity={studioLeftFillIntensity}
                position={[-r * 3, r, r * 0.5]}
                rotation={[Math.PI / 8, Math.PI / 3, 0]}
                scale={[r * 4, r * 4, 1]}
              />
              {/* ── Top panel (overhead in camera space) ── */}
              {/* Reduced overhead accent — kept low to avoid over-brightening
                  NNW (D section) which has high env_y normal component. */}
              <Lightformer
                form="rect"
                intensity={studioTopIntensity}
                position={[0, r * 3, 0]}
                rotation={[Math.PI / 2, 0, 0]}
                scale={[r * 3, r * 3, 1]}
              />
              {/* ── Ground panel (below-right in camera space) ── */}
              {/* Bright ground for bottom-view luminosity. Offset in +X so that
                  the bottom-face specular shifts toward the right (matching the
                  asymmetric rig's "brighter on right" pattern). */}
              <Lightformer
                form="rect"
                intensity={studioGroundIntensity}
                position={[r * 2, -r * 3, 0]}
                rotation={[-Math.PI / 2, 0, 0]}
                scale={[r * 6, r * 6, 1]}
              />
              {/* ── Specular highlight panel (upper-right in camera space) ── */}
              {/* Positioned in the (+X, -Y, +Z) octant to create a focused specular
                  highlight in the upper-right area of bottom-facing surfaces when
                  viewed from below. In Z-up screen coords for the bottom face:
                  +X → screen right, -Y → screen top, +Z → close to the reflection
                  pole. Equal X and -Y offsets place the specular at 45° toward the
                  top-right corner. Negligible contribution to front/side face
                  speculars (~61° from front reflection direction). */}
              <Lightformer
                form="rect"
                intensity={studioBackFillIntensity}
                position={[r * 2, -r * 3, r * 4]}
                scale={[r * 2, r * 2, 1]}
              />
            </>
          ) : (
            <>
              {/* Neutral preset: reduced intensity, minimal reflections */}
              <Lightformer
                form="rect"
                intensity={neutralKeyIntensity}
                position={[0, r * 3, 0]}
                rotation={[Math.PI / 2, 0, 0]}
                scale={[r * 6, r * 6, 1]}
              />
              <Lightformer
                form="rect"
                intensity={neutralGroundIntensity}
                position={[0, -r * 3, 0]}
                rotation={[-Math.PI / 2, 0, 0]}
                scale={[r * 6, r * 6, 1]}
              />
            </>
          )}
        </Environment>
      ) : null}

      {/* Soft preset: hemisphere + ambient only, no environment map */}
      {!enableMatcap && environmentPreset === 'soft' ? <hemisphereLight args={['#ffffff', '#444444', 0.8]} /> : null}

      {/* Performance preset: minimal lights, no environment (equivalent to legacy setup) */}
      {!enableMatcap && environmentPreset === 'performance' ? (
        <>
          <hemisphereLight args={['#ffffff', '#444444', 1]} />
          <directionalLight color="white" intensity={2} position={[-1, -3, 5]} />
          <directionalLight color="white" intensity={2} position={[1, 3, 5]} />
        </>
      ) : null}
    </>
  );
}
