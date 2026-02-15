import { useRef } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';

// ── Lighting constants ─────────────────────────────────────────────────────
// All tuning values live at module scope for easy adjustment.

/** Ambient fill -- provides base diffuse illumination so surfaces are visible. */
const ambientIntensity = 0.3;

/** Camera-relative directional -- even orbit-following fill light. */
const cameraDirectionalIntensity = 0.7;

/** Fixed directional key light from above-front -- creates angle-dependent specular highlights. */
const fixedKeyIntensity = 3;

/** Environment cubemap resolution (px). Higher = sharper specular reflections. */
const envResolution = 512;

// Studio preset Lightformer intensities ──────────────────────────────────────
// The environment map provides reflections and additional specular contribution.

/** Key panel (above) -- primary environment specular source. */
const studioKeyIntensity = 8;
/** Fill panel (front-left) -- secondary specular on front-facing surfaces. */
const studioFillIntensity = 4;
/** Rim panel (behind-right) -- edge definition through rim highlights. */
const studioRimIntensity = 2;
/** Ground panel (below) -- subtle underside fill to lift deep shadows. */
const studioGroundIntensity = 0.8;

// Neutral preset Lightformer intensities ─────────────────────────────────────
const neutralKeyIntensity = 0.6;
const neutralGroundIntensity = 0.2;

type LightsProperties = {
  readonly enableMatcap?: boolean;
  readonly sceneRadius?: number;
  readonly environmentPreset?: 'studio' | 'neutral' | 'soft' | 'performance';
};

/**
 * Professional CAD lighting setup with environment-based studio lighting.
 *
 * Uses a combination of:
 * - Fixed directional key light for angle-dependent specular highlights
 * - Camera-relative directional for consistent orbit illumination
 * - `<Environment>` with `<Lightformer>` children for realistic PBR reflections
 *
 * All Lightformer positions and scales are expressed as multiples of `sceneRadius`
 * so lighting adapts to model size (a 5mm watch gear and a 5m building frame both
 * receive proportionally sized soft panels).
 *
 * When matcap is enabled, the environment is skipped entirely since
 * `MeshMatcapMaterial` ignores environment maps.
 */
export function Lights({
  enableMatcap = false,
  sceneRadius = 0,
  environmentPreset = 'studio',
}: LightsProperties): React.JSX.Element {
  const { camera } = useThree();
  const cameraLightReference = useRef<THREE.DirectionalLight>(null);

  // Camera-relative fill: follows the camera so base illumination is consistent during orbit
  useFrame(() => {
    if (cameraLightReference.current) {
      // Position the light slightly above and to the right of the camera
      cameraLightReference.current.position.copy(camera.position);
      cameraLightReference.current.position.add(new THREE.Vector3(1, 2, 0).applyQuaternion(camera.quaternion));
      cameraLightReference.current.target.position.set(0, 0, 0);
      cameraLightReference.current.target.updateMatrixWorld();
    }
  });

  // Clamp sceneRadius to avoid zero/tiny values before geometry loads
  const r = Math.max(sceneRadius, 1);

  const showEnvironment = !enableMatcap && (environmentPreset === 'studio' || environmentPreset === 'neutral');

  return (
    <>
      {/* Base ambient fill -- always present for minimum illumination */}
      <ambientLight intensity={ambientIntensity} />

      {/* Camera-relative directional -- even fill during orbit */}
      <directionalLight ref={cameraLightReference} intensity={cameraDirectionalIntensity} color="white" />

      {/* Fixed key light from above-front -- produces angle-dependent specular highlights */}
      <directionalLight intensity={fixedKeyIntensity} color="white" position={[-r, r * 4, r * 4]} />

      {showEnvironment ? (
        <Environment resolution={envResolution}>
          {environmentPreset === 'studio' ? (
            <>
              {/* Large soft key panel above */}
              <Lightformer
                form="rect"
                intensity={studioKeyIntensity}
                position={[0, r * 3, 0]}
                rotation={[Math.PI / 2, 0, 0]}
                scale={[r * 6, r * 6, 1]}
              />
              {/* Fill panel from front-left */}
              <Lightformer
                form="rect"
                intensity={studioFillIntensity}
                position={[-r * 3, r * 1.5, r * 3]}
                rotation={[0, Math.PI / 4, 0]}
                scale={[r * 3, r * 3, 1]}
              />
              {/* Rim/accent panel from behind-right */}
              <Lightformer
                form="rect"
                intensity={studioRimIntensity}
                position={[r * 3, r * 0.5, -r * 3]}
                rotation={[0, -Math.PI / 4, 0]}
                scale={[r * 3, r * 2, 1]}
              />
              {/* Ground fill from below */}
              <Lightformer
                form="rect"
                intensity={studioGroundIntensity}
                position={[0, -r * 3, 0]}
                rotation={[-Math.PI / 2, 0, 0]}
                scale={[r * 6, r * 6, 1]}
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
