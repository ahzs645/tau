/**
 * Shared constants for the auth splashback animation.
 */

// ============================================================================
// Gear Configuration
// ============================================================================

/** Number of teeth on the first gear (12-tooth) */
export const gear12Teeth = 12;

/** Number of teeth on the second gear (8-tooth) */
export const gear8Teeth = 8;

/** Gear ratio for counter-rotation (gear12Teeth / gear8Teeth) */
export const gearRatio = gear12Teeth / gear8Teeth;

// ============================================================================
// Animation Parameters
// ============================================================================

/** Number of particles for morphing animation */
export const morphPointCount = 3000;

/** Default split ratio for assembly morph (60% to gear12, 40% to gear8) */
export const assemblySplitRatio = 0.6;

// ============================================================================
// Colors
// ============================================================================

/** Primary color for gear12 (teal) */
export const gear12Color = '#14b8a6';

/** Primary color for gear8 (blue) */
export const gear8Color = '#5B8FD9';
