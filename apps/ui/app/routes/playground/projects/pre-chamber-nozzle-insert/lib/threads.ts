/**
 * Helical thread helpers for the OpenCASCADE variant of this project.
 *
 * The construction follows the approach proven by cq_warehouse's IsoThread
 * (https://github.com/gumyr/cq_warehouse, Apache-2.0): sweep a trapezoidal
 * thread profile along a helix and boolean it with the core. Here the helix
 * is a sampled BSpline spine swept with `BRepOffsetAPI_MakePipeShell` in
 * Frenet mode, then trimmed flush at both ends — the equivalent of BOSL2's
 * `blunt_start=false` thread run-out.
 */
import {
  BRepBuilderAPI_MakeEdge,
  BRepBuilderAPI_MakeWire,
  BRepBuilderAPI_MakePolygon,
  BRepOffsetAPI_MakePipeShell,
  GeomAPI_PointsToBSpline,
  NCollection_Array1_gp_Pnt,
  gp_Pnt,
} from 'opencascade.js';
import type { TopoDS_Shape } from 'opencascade.js';
import { cylinder, fuse, intersect } from './occt-utils.js';

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
 * The helical thread ridge alone — BOSL2's `thread_helix()`. Fuse it onto a
 * rod for external threads, or subtract it from a bore wall for internal ones.
 */
export function helicalRidge(options: HelicalRidgeOptions): TopoDS_Shape {
  const { baseRadius, pitch, length, depth } = options;
  const flankAngleDeg = options.flankAngleDeg ?? 30;
  const apexWidth = options.apexWidth ?? pitch / 8;
  const rootWidth = apexWidth + 2 * depth * Math.tan((flankAngleDeg * Math.PI) / 180);
  // Sink the root slightly under the surface so booleans against the core are watertight.
  const rootInset = Math.min(0.2, depth * 0.25);

  const turns = length / pitch;
  const samplesPerTurn = 48;
  const totalSamples = Math.max(2, Math.ceil(turns * samplesPerTurn)) + 1;
  const points = new NCollection_Array1_gp_Pnt(1, totalSamples);
  for (let index = 1; index <= totalSamples; index += 1) {
    const t = (index - 1) / (totalSamples - 1);
    const angle = 2 * Math.PI * turns * t;
    const point = new gp_Pnt(baseRadius * Math.cos(angle), baseRadius * Math.sin(angle), length * t);
    points.SetValue(index, point);
    point.delete();
  }

  const approximation = new GeomAPI_PointsToBSpline(points, 3, 8, 4 /* GeomAbs_C2 */, 1e-4);
  const spineEdge = new BRepBuilderAPI_MakeEdge(approximation.Curve());
  const spineWire = new BRepBuilderAPI_MakeWire(spineEdge.Edge());

  // Trapezoid cross-section in the XZ plane at the helix start (r, 0, 0),
  // where the spine tangent is ~+Y.
  const profile = new BRepBuilderAPI_MakePolygon();
  const profilePoints: ReadonlyArray<readonly [number, number]> = [
    [baseRadius - rootInset, -rootWidth / 2],
    [baseRadius + depth, -apexWidth / 2],
    [baseRadius + depth, apexWidth / 2],
    [baseRadius - rootInset, rootWidth / 2],
  ];
  for (const [radius, z] of profilePoints) {
    const point = new gp_Pnt(radius, 0, z);
    profile.Add(point);
    point.delete();
  }
  profile.Close();

  const pipe = new BRepOffsetAPI_MakePipeShell(spineWire.Wire());
  pipe.SetMode(true); // Frenet trihedron follows the helix twist
  pipe.Add(profile.Wire(), false, false);
  pipe.Build();
  if (!pipe.IsDone()) {
    throw new Error('helicalRidge: thread sweep failed to build');
  }

  pipe.MakeSolid();
  const ridge = pipe.Shape();
  pipe.delete();
  profile.delete();
  spineWire.delete();
  spineEdge.delete();
  approximation.delete();
  points.delete();

  // Trim the ridge run-out flush with the z = [0, length] band.
  return intersect(ridge, cylinder(baseRadius + depth + 1, length));
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
 * The same solid is the internal-thread mask: subtract it from a body to cut
 * a female thread (`threaded_rod(internal=true)`).
 */
export function threadedRod(options: ThreadedRodOptions): TopoDS_Shape {
  const clearance = options.clearance ?? 0;
  // ISO 68-1 metric profile: H = 0.866 p, thread engagement depth 5/8 H.
  const depth = 0.5413 * options.pitch;
  const coreRadius = options.majorDiameter / 2 - depth + clearance;
  return fuse(
    cylinder(coreRadius, options.length),
    helicalRidge({
      baseRadius: coreRadius,
      pitch: options.pitch,
      length: options.length,
      depth,
    }),
  );
}
