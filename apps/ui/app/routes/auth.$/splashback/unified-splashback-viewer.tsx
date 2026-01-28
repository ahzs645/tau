import { useRef, useState, useEffect, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Center, OrbitControls, PerspectiveCamera } from '@react-three/drei';
import type { Group } from 'three';
import type { Geometry } from '@taucad/types';
import { MorphingPoints } from '#routes/auth.$/splashback/morphing-points.js';
import { SplitMorphingPoints } from '#routes/auth.$/splashback/split-morphing-points.js';
import { PreviewLights } from '#routes/auth.$/splashback/preview-lights.js';
import { updateCrossfade, startCrossfade } from '#routes/auth.$/splashback/crossfade-animation.js';
import { usePreloadedMeshes } from '#routes/auth.$/splashback/use-preloaded-meshes.js';
import type { LoadedMesh } from '#routes/auth.$/splashback/use-preloaded-meshes.js';
import type { SampledPoints } from '#routes/auth.$/splashback/point-sampler.js';
import {
  gear12Teeth as gear12TeethConstant,
  gear8Teeth as gear8TeethConstant,
  assemblySplitRatio as assemblySplitRatioConstant,
} from '#routes/auth.$/splashback/auth-splashback.constants.js';
import { cn } from '#utils/ui.utils.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Phase of the splashback animation.
 */
export type SplashbackPhase =
  | 'loading'
  | 'gear12'
  | 'preparingMorph'
  | 'morphing'
  | 'crossfading'
  | 'gear8'
  | 'preparingMorph2'
  | 'morphingToAssembly'
  | 'crossfadingToAssembly'
  | 'assembly'
  | 'fading';

type UnifiedSplashbackViewerProperties = {
  /** Current phase of the animation */
  readonly phase: SplashbackPhase;
  /** Gear12 geometry (GLTF format) */
  readonly gear12Geometry?: Geometry;
  /** Gear8 geometry (GLTF format) */
  readonly gear8Geometry?: Geometry;
  /** Sampled points from gear12 for morphing */
  readonly gear12Points?: SampledPoints;
  /** Sampled points from gear8 for morphing */
  readonly gear8Points?: SampledPoints;
  /** Sampled points for gear12 at assembly position (for split morph) */
  readonly assemblyGear12Points?: SampledPoints;
  /** Sampled points for gear8 at assembly position (for split morph) */
  readonly assemblyGear8Points?: SampledPoints;
  /** Split ratio for assembly morph (0.6 = 60% to gear12, 40% to gear8) */
  readonly assemblySplitRatio?: number;
  /** Duration of crossfade animation in ms */
  readonly crossfadeDuration?: number;
  /** Additional CSS classes */
  readonly className?: string;
  /** Called when user interacts with the viewer */
  readonly onInteraction?: () => void;
  /** Called when morph animation completes (gear12 -> gear8) */
  readonly onMorphComplete?: () => void;
  /** Called when crossfade completes (gear12->gear8), with final rotation */
  readonly onCrossfadeComplete?: (finalRotationY: number) => void;
  /** Called when morph2 animation completes (gear8 -> assembly) */
  readonly onMorph2Complete?: () => void;
  /** Called when phase transition animation completes */
  readonly onPhaseTransitionComplete?: () => void;
};

// ============================================================================
// Constants
// ============================================================================

/** Auto-rotation speed in radians per second */
const autoRotateSpeed = 0.5;

/** Gear colors - using constants */
const gear12Color = '#14b8a6'; // Teal
const gear8Color = '#5B8FD9'; // Blue

/**
 * Gear assembly constants calculated from circularPitch = 5
 */
const circularPitch = 5;
const gear12Teeth = gear12TeethConstant;
const gear8Teeth = gear8TeethConstant;
const pitchRadius12 = (gear12Teeth * circularPitch) / (2 * Math.PI);
const pitchRadius8 = (gear8Teeth * circularPitch) / (2 * Math.PI);
const centerOffset = (pitchRadius12 - pitchRadius8) / 2;
const gearRatio = gear12Teeth / gear8Teeth;
const phaseOffset8 = (1.9 * Math.PI) / gear8Teeth;
const initialXaxisRotation = Math.PI / 12;
const initialYaxisRotation = (Math.PI / 4) * 2.5;

// ============================================================================
// Internal Scene Components
// ============================================================================

type PointCloudContentProperties = {
  readonly sourcePoints: SampledPoints;
  readonly targetPoints: SampledPoints;
  readonly sourceColor: string;
  readonly targetColor: string;
  readonly isVisible: boolean;
  readonly opacity?: number;
  readonly onMorphComplete?: (finalRotationY: number) => void;
};

/**
 * Renders the morphing point cloud.
 */
function PointCloudContent({
  sourcePoints,
  targetPoints,
  sourceColor,
  targetColor,
  isVisible,
  opacity = 1,
  onMorphComplete,
}: PointCloudContentProperties): React.JSX.Element | undefined {
  if (!isVisible) {
    return undefined;
  }

  return (
    <MorphingPoints
      sourcePoints={sourcePoints}
      targetPoints={targetPoints}
      targetProgress={1}
      animationSpeed={1.5}
      sourceColor={sourceColor}
      targetColor={targetColor}
      pointSize={1.5}
      explosionStrength={3}
      opacity={opacity}
      onMorphComplete={onMorphComplete}
    />
  );
}

// ============================================================================
// Main Scene Content
// ============================================================================

type SceneContentProperties = {
  readonly phase: SplashbackPhase;
  readonly gear12Points?: SampledPoints;
  readonly gear8Points?: SampledPoints;
  readonly assemblyGear12Points?: SampledPoints;
  readonly assemblyGear8Points?: SampledPoints;
  readonly assemblySplitRatio?: number;
  readonly crossfadeDuration: number;
  // Preloaded meshes (loaded eagerly, not phase-dependent)
  readonly gear12Mesh?: LoadedMesh;
  readonly gear8Mesh?: LoadedMesh;
  readonly assemblyGear12Mesh?: LoadedMesh;
  readonly assemblyGear8Mesh?: LoadedMesh;
  readonly onMorphComplete?: () => void;
  readonly onCrossfadeComplete?: (finalRotationY: number) => void;
  readonly onMorph2Complete?: () => void;
  readonly onPhaseTransitionComplete?: () => void;
};

// eslint-disable-next-line complexity -- complex logic
function SceneContent({
  phase,
  gear12Points,
  gear8Points,
  assemblyGear12Points,
  assemblyGear8Points,
  assemblySplitRatio = assemblySplitRatioConstant,
  crossfadeDuration,
  // Preloaded meshes (already loaded, no async loading needed)
  gear12Mesh,
  gear8Mesh,
  assemblyGear12Mesh,
  assemblyGear8Mesh,
  onMorphComplete,
  onCrossfadeComplete,
  onMorph2Complete,
  onPhaseTransitionComplete,
}: SceneContentProperties): React.JSX.Element {
  const rotatingGroupRef = useRef<Group>(null);
  const currentRotationYaxisRef = useRef(0);

  // Crossfade state refs (gear12 -> gear8)
  const crossfadeProgressRef = useRef(0);
  const crossfadeIsActiveRef = useRef(false);
  const crossfadeHasSentCompleteRef = useRef(false);
  const [crossfadeOpacity, setCrossfadeOpacity] = useState({ pointCloud: 1, mesh: 0 });

  // Split morph crossfade state refs (gear8 -> assembly)
  const splitCrossfadeProgressRef = useRef(0);
  const splitCrossfadeIsActiveRef = useRef(false);
  const splitCrossfadeHasSentCompleteRef = useRef(false);
  const [splitCrossfadeOpacity, setSplitCrossfadeOpacity] = useState({ pointCloud: 1, mesh: 0 });

  // Refs for counter-rotation of assembly meshes
  const assemblyGear12RotationRef = useRef<Group>(null);
  const assemblyGear8RotationRef = useRef<Group>(null);

  // Shared rotation accumulator for seamless point cloud -> mesh transition
  // Both the split point cloud and assembly meshes use this same value
  const assemblyRotationRef = useRef(0);

  // Split morph progress for animating assembly tilt
  const splitMorphProgressRef = useRef(0);
  const splitTiltRef = useRef<Group>(null);

  // Derive visibility from phase
  const showGear12 = phase === 'gear12' || phase === 'preparingMorph';
  const showPointCloud = phase === 'morphing' || phase === 'crossfading' || crossfadeIsActiveRef.current;
  const showGear8Mesh =
    phase === 'crossfading' || phase === 'gear8' || phase === 'preparingMorph2' || crossfadeIsActiveRef.current;
  const showSplitPointCloud =
    phase === 'morphingToAssembly' || phase === 'crossfadingToAssembly' || splitCrossfadeIsActiveRef.current;
  // Assembly meshes shown during crossfade AND assembly phases (they become the permanent display)
  const showAssemblyMeshes =
    phase === 'crossfadingToAssembly' ||
    phase === 'assembly' ||
    phase === 'fading' ||
    splitCrossfadeIsActiveRef.current;
  // Track if we're in the counter-rotating assembly phase (not just crossfading)
  const isAssemblyRotating = phase === 'assembly' || phase === 'fading';

  // Start crossfade when phase transitions to crossfading (mesh is already preloaded)
  useEffect(() => {
    if (gear8Mesh && phase === 'crossfading' && !crossfadeIsActiveRef.current) {
      startCrossfade({
        progressRef: crossfadeProgressRef,
        isActiveRef: crossfadeIsActiveRef,
        hasSentCompleteRef: crossfadeHasSentCompleteRef,
      });
    }
  }, [gear8Mesh, phase]);

  // Start split crossfade when phase transitions to crossfadingToAssembly (meshes are already preloaded)
  useEffect(() => {
    if (
      assemblyGear12Mesh &&
      assemblyGear8Mesh &&
      phase === 'crossfadingToAssembly' &&
      !splitCrossfadeIsActiveRef.current
    ) {
      startCrossfade({
        progressRef: splitCrossfadeProgressRef,
        isActiveRef: splitCrossfadeIsActiveRef,
        hasSentCompleteRef: splitCrossfadeHasSentCompleteRef,
      });
    }
  }, [assemblyGear12Mesh, assemblyGear8Mesh, phase]);

  // Handle morph complete
  const handleMorphComplete = useCallback(
    (finalRotationY: number) => {
      currentRotationYaxisRef.current = finalRotationY;
      onMorphComplete?.();
    },
    [onMorphComplete],
  );

  // Handle morph2 complete (gear8 -> assembly)
  const handleMorph2Complete = useCallback(
    (finalRotationY: number) => {
      currentRotationYaxisRef.current = finalRotationY;
      onMorph2Complete?.();
    },
    [onMorph2Complete],
  );

  // Handle split morph progress change (for animating assembly tilt)
  const handleSplitMorphProgress = useCallback((progress: number) => {
    splitMorphProgressRef.current = progress;
  }, []);

  // Reset split morph progress when entering morphingToAssembly phase
  // This ensures the tilt starts from 0 on each animation loop
  useEffect(() => {
    if (phase === 'morphingToAssembly') {
      splitMorphProgressRef.current = 0;
    }
  }, [phase]);

  // Animation loop
  useFrame((_, delta) => {
    if (!rotatingGroupRef.current) {
      return;
    }

    // Auto-rotate the entire scene (including assembly)
    currentRotationYaxisRef.current += autoRotateSpeed * delta;
    rotatingGroupRef.current.rotation.y = currentRotationYaxisRef.current;

    // Crossfade animation (gear12 -> gear8)
    const gear8Opacity = updateCrossfade(
      {
        progressRef: crossfadeProgressRef,
        isActiveRef: crossfadeIsActiveRef,
        hasSentCompleteRef: crossfadeHasSentCompleteRef,
      },
      delta,
      crossfadeDuration,
      () => {
        onCrossfadeComplete?.(currentRotationYaxisRef.current);
      },
    );

    if (gear8Opacity) {
      setCrossfadeOpacity({ pointCloud: gear8Opacity.source, mesh: gear8Opacity.target });
      if (gear8Mesh) {
        gear8Mesh.material.opacity = gear8Opacity.target;
      }
    }

    // Split crossfade animation (gear8 -> assembly)
    const assemblyOpacity = updateCrossfade(
      {
        progressRef: splitCrossfadeProgressRef,
        isActiveRef: splitCrossfadeIsActiveRef,
        hasSentCompleteRef: splitCrossfadeHasSentCompleteRef,
      },
      delta,
      crossfadeDuration,
      () => {
        onPhaseTransitionComplete?.();
      },
    );

    if (assemblyOpacity) {
      setSplitCrossfadeOpacity({ pointCloud: assemblyOpacity.source, mesh: assemblyOpacity.target });
      if (assemblyGear12Mesh) {
        assemblyGear12Mesh.material.opacity = assemblyOpacity.target;
      }

      if (assemblyGear8Mesh) {
        assemblyGear8Mesh.material.opacity = assemblyOpacity.target;
      }
    }

    // Accumulate rotation for assembly (both point cloud and meshes use this)
    // Start accumulating once the split point cloud appears
    const isAssemblyAnimating = showSplitPointCloud || isAssemblyRotating;

    if (isAssemblyAnimating) {
      const rotationSpeed = 0.3;
      assemblyRotationRef.current += rotationSpeed * delta;
    }

    // Apply shared rotation to assembly meshes
    if (assemblyGear12RotationRef.current && assemblyGear8RotationRef.current) {
      assemblyGear12RotationRef.current.rotation.z = assemblyRotationRef.current;
      assemblyGear8RotationRef.current.rotation.z = -assemblyRotationRef.current * gearRatio + phaseOffset8;
    }

    // Animate assembly tilt based on split morph progress
    // Only animate X (forward tilt) - Y is kept static to avoid rapid spin
    // Y rotation is just a viewing angle preference; auto-rotate handles Y orientation
    if (splitTiltRef.current) {
      const tiltProgress = splitMorphProgressRef.current;
      splitTiltRef.current.rotation.x = initialXaxisRotation * tiltProgress;
      splitTiltRef.current.rotation.y = initialYaxisRotation; // Static, not animated
    }
  });

  return (
    <group ref={rotatingGroupRef}>
      {/* Coordinate system correction */}
      <group rotation={[Math.PI, 0, 0]}>
        {/* Gear12 mesh - preloaded, visibility controlled by phase */}
        {showGear12 && gear12Mesh ? <primitive object={gear12Mesh.scene} /> : undefined}

        {/* Point cloud for morphing (gear12 -> gear8) */}
        {showPointCloud && gear12Points && gear8Points ? (
          <PointCloudContent
            sourcePoints={gear12Points}
            targetPoints={gear8Points}
            sourceColor={gear12Color}
            targetColor={gear8Color}
            isVisible={showPointCloud}
            opacity={crossfadeIsActiveRef.current ? crossfadeOpacity.pointCloud : 1}
            onMorphComplete={handleMorphComplete}
          />
        ) : undefined}

        {/* Gear8 mesh for crossfade and display - preloaded */}
        {showGear8Mesh && gear8Mesh ? <primitive object={gear8Mesh.scene} /> : undefined}
      </group>

      {/* Split point cloud for morphing (gear8 -> assembly) - tilt animated via splitTiltRef */}
      {showSplitPointCloud && gear8Points && assemblyGear12Points && assemblyGear8Points ? (
        <group ref={splitTiltRef}>
          <group rotation={[Math.PI, 0, 0]}>
            <SplitMorphingPoints
              sourcePoints={gear8Points}
              targetPointsA={assemblyGear12Points}
              targetPointsB={assemblyGear8Points}
              splitRatio={assemblySplitRatio}
              targetProgress={1}
              animationSpeed={1.5}
              sourceColor={gear8Color}
              targetColorA={gear12Color}
              targetColorB={gear8Color}
              pointSize={1.5}
              explosionStrength={3}
              opacity={splitCrossfadeIsActiveRef.current ? splitCrossfadeOpacity.pointCloud : 1}
              sharedRotationRef={assemblyRotationRef}
              gearRatio={gearRatio}
              gear12OffsetX={-pitchRadius12 + centerOffset}
              gear8OffsetX={pitchRadius8 + centerOffset}
              gear8PhaseOffset={phaseOffset8}
              onMorphComplete={handleMorph2Complete}
              onProgressChange={handleSplitMorphProgress}
            />
          </group>
        </group>
      ) : undefined}

      {/* Assembly meshes - preloaded, used for both crossfade and final display with counter-rotation */}
      {showAssemblyMeshes && assemblyGear12Mesh && assemblyGear8Mesh ? (
        <group rotation={[initialXaxisRotation, initialYaxisRotation, 0]}>
          <group rotation={[Math.PI, 0, 0]}>
            {/* Gear 12 - positioned to the left, counter-rotates during assembly phase */}
            <group ref={assemblyGear12RotationRef} position={[-pitchRadius12 + centerOffset, 0, 0]}>
              <primitive object={assemblyGear12Mesh.scene} />
            </group>

            {/* Gear 8 - positioned to the right with phase offset, counter-rotates during assembly phase */}
            <group
              ref={assemblyGear8RotationRef}
              position={[pitchRadius8 + centerOffset, 0, 0]}
              rotation={[0, 0, phaseOffset8]}
            >
              <primitive object={assemblyGear8Mesh.scene} />
            </group>
          </group>
        </group>
      ) : undefined}
    </group>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Unified splashback viewer with a single persistent Canvas.
 *
 * Features:
 * - Single WebGL context for all phases
 * - Seamless transitions between gear12 -> point cloud -> gear8 -> assembly
 * - Split point cloud morph from gear8 to assembly
 * - Shared rotation group for synchronized animation
 * - Phase-based visibility control
 */
export function UnifiedSplashbackViewer({
  phase,
  gear12Geometry,
  gear8Geometry,
  gear12Points,
  gear8Points,
  assemblyGear12Points,
  assemblyGear8Points,
  assemblySplitRatio,
  crossfadeDuration = 50,
  className,
  onInteraction,
  onMorphComplete,
  onCrossfadeComplete,
  onMorph2Complete,
  onPhaseTransitionComplete,
}: UnifiedSplashbackViewerProperties): React.JSX.Element {
  const dpr = Math.min(globalThis.devicePixelRatio, 2);

  // Preload all meshes eagerly when geometries become available
  // These persist across animation loops and are ready before morph completes
  const { gear12Mesh, gear8Mesh, assemblyGear12Mesh, assemblyGear8Mesh } = usePreloadedMeshes({
    gear12Geometry,
    gear8Geometry,
  });

  return (
    <Canvas
      gl={{
        antialias: true,
        alpha: true,
        logarithmicDepthBuffer: true,
      }}
      dpr={dpr}
      className={cn('bg-transparent', className)}
    >
      <PerspectiveCamera makeDefault position={[0, 0, 40]} fov={45} />

      <PreviewLights />

      <Center>
        <SceneContent
          phase={phase}
          gear12Points={gear12Points}
          gear8Points={gear8Points}
          assemblyGear12Points={assemblyGear12Points}
          assemblyGear8Points={assemblyGear8Points}
          assemblySplitRatio={assemblySplitRatio}
          crossfadeDuration={crossfadeDuration}
          gear12Mesh={gear12Mesh}
          gear8Mesh={gear8Mesh}
          assemblyGear12Mesh={assemblyGear12Mesh}
          assemblyGear8Mesh={assemblyGear8Mesh}
          onMorphComplete={onMorphComplete}
          onCrossfadeComplete={onCrossfadeComplete}
          onMorph2Complete={onMorph2Complete}
          onPhaseTransitionComplete={onPhaseTransitionComplete}
        />
      </Center>

      <OrbitControls enableZoom={false} enablePan={false} onChange={onInteraction} />
    </Canvas>
  );
}
