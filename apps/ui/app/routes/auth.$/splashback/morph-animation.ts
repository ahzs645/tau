import type { MutableRefObject } from 'react';

/** Threshold for considering morph animation complete */
export const morphCompleteThreshold = 0.01;

/**
 * State for managing a morph animation.
 */
export type MorphAnimationState = {
  /** Current progress ref (0 to 1) */
  progressRef: MutableRefObject<number>;
  /** Whether the animation has reached the target */
  hasReachedTargetRef: MutableRefObject<boolean>;
  /** Previous target value for detecting changes */
  previousTargetRef: MutableRefObject<number>;
};

/**
 * Linear interpolation between two values.
 */
export function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

/**
 * Updates morph animation state for one frame.
 *
 * @param state - The morph animation state refs
 * @param targetProgress - The target progress value (0 to 1)
 * @param delta - Frame delta time in seconds
 * @param animationSpeed - Speed multiplier for the animation
 * @param onComplete - Optional callback when animation reaches target
 * @returns The current progress value
 */
export function updateMorphAnimation({
  state,
  targetProgress,
  delta,
  animationSpeed,
  onComplete,
}: {
  state: MorphAnimationState;
  targetProgress: number;
  delta: number;
  animationSpeed: number;
  onComplete?: (progress: number) => void;
}): number {
  // Animate progress towards target using lerp
  state.progressRef.current = lerp(state.progressRef.current, targetProgress, animationSpeed * delta);

  // Clamp to exact values when very close
  if (Math.abs(state.progressRef.current - targetProgress) < 0.001) {
    state.progressRef.current = targetProgress;
  }

  const progress = state.progressRef.current;

  // Check if we've reached the target
  const distanceToTarget = Math.abs(progress - targetProgress);

  if (!state.hasReachedTargetRef.current && distanceToTarget < morphCompleteThreshold) {
    state.hasReachedTargetRef.current = true;
    onComplete?.(progress);
  }

  return progress;
}

/**
 * Resets the animation state when target changes.
 * Call this in a useEffect that watches targetProgress.
 */
export function resetMorphAnimationOnTargetChange(state: MorphAnimationState, targetProgress: number): void {
  if (state.previousTargetRef.current !== targetProgress) {
    state.hasReachedTargetRef.current = false;
    state.previousTargetRef.current = targetProgress;
  }
}
