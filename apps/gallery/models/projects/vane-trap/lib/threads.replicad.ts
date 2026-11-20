/**
 * Helical thread helpers for the Replicad variant of this project.
 *
 * Same construction as the raw `opencascade.js` helpers in `threads.ts` — sweep
 * a trapezoidal thread profile along a helix, then trim the run-out flush — but
 * expressed with Replicad's own API: `makeHelix` supplies an exact analytic
 * helix and `genericSweep` does the sweep, so there is no spine sampling and no
 * shape lifetimes to manage.
 *
 * Verified against the raw helpers by `packages/testing/scripts/compare-threads.ts`:
 * identical ridge, rod and nut volumes, and zero interference between a male
 * rod and the female thread cut with the matching clearance.
 */
import { assembleWire, genericSweep, makeCylinder, makeHelix, makeLine } from 'replicad';
import type { Point, Shape3D } from 'replicad';

export type HelicalRidgeOptions = {
  /** Radius of the cylindrical surface the ridge sits on (thread root radius). */
  baseRadius: number;
  pitch: number;
  /** Axial length of the threaded band; the ridge is trimmed flush to [0, length]. */
  length: number;
  /** Radial height of the ridge above `baseRadius`. */
  depth: number;
  /** Angle of each thread flank from the plane perpendicular to the axis. ISO metric = 30. */
  flankAngleDeg?: number;
  /** Axial width of the flat at the thread crest. ISO metric = pitch / 8. */
  apexWidth?: number;
};

/**
 * The helical thread ridge alone — BOSL2's `thread_helix()`. Fuse it onto a rod
 * for external threads, or subtract it from a bore wall for internal ones.
 */
export function helicalRidge(options: HelicalRidgeOptions): Shape3D {
  const { baseRadius, pitch, length, depth } = options;
  const flankAngleDeg = options.flankAngleDeg ?? 30;
  const apexWidth = options.apexWidth ?? pitch / 8;
  const rootWidth = apexWidth + 2 * depth * Math.tan((flankAngleDeg * Math.PI) / 180);
  // Sink the root slightly under the surface so booleans against the core are watertight.
  const rootInset = Math.min(0.2, depth * 0.25);

  // The profile is built in the plane that contains the axis (XZ at the helix
  // start), not in the plane normal to the spine. `sweepSketch`'s callback hands
  // back the normal plane, which tilts the profile by the lead angle — and the
  // lead angle depends on radius, so a male and female thread of the same
  // nominal pitch end up with slightly different flanks and interfere. Sweeping
  // an axial-plane profile with `genericSweep` matches how the OCCT helpers
  // (and BOSL2) define a thread.
  const corners: Point[] = [
    [baseRadius - rootInset, 0, -rootWidth / 2],
    [baseRadius + depth, 0, -apexWidth / 2],
    [baseRadius + depth, 0, apexWidth / 2],
    [baseRadius - rootInset, 0, rootWidth / 2],
  ];
  const profile = assembleWire(
    corners.map((corner, index) => makeLine(corner, corners[(index + 1) % corners.length]!)),
  );
  const ridge = genericSweep(profile, makeHelix(pitch, length, baseRadius), { frenet: true });

  // Trim the ridge run-out flush with the z = [0, length] band.
  return ridge.intersect(makeCylinder(baseRadius + depth + 1, length));
}

export type ThreadedRodOptions = {
  /** Nominal major (crest) diameter, e.g. 14 for M14. */
  majorDiameter: number;
  length: number;
  pitch: number;
  /** Extra radial clearance, like BOSL2's `$slop`. */
  clearance?: number;
};

/**
 * ISO 60° threaded rod along +Z from the origin — BOSL2's `threaded_rod()`.
 * The same solid is the internal-thread mask: subtract it from a body to cut a
 * female thread (`threaded_rod(internal=true)`).
 */
export function threadedRod(options: ThreadedRodOptions): Shape3D {
  const clearance = options.clearance ?? 0;
  // ISO 68-1 metric profile: H = 0.866 p, thread engagement depth 5/8 H.
  const depth = 0.5413 * options.pitch;
  const coreRadius = options.majorDiameter / 2 - depth + clearance;
  return makeCylinder(coreRadius, options.length).fuse(
    helicalRidge({
      baseRadius: coreRadius,
      pitch: options.pitch,
      length: options.length,
      depth,
    }),
  );
}
