/**
 * Helical thread helpers for the OpenCASCADE variant of this project.
 *
 * The construction follows the approach proven by cq_warehouse's IsoThread
 * (https://github.com/gumyr/cq_warehouse, Apache-2.0): sweep a trapezoidal
 * thread profile along a helix and boolean it with the core. The helix is a
 * true analytic helix — a straight line in the parameter space of a
 * `Geom_CylindricalSurface` (u = angle, v = axial height), so the spine is
 * defined exactly instead of fitted through sampled points — swept with
 * `BRepOffsetAPI_MakePipeShell` in Frenet mode. BOSL2-style non-blunt starts
 * are modeled by sweeping past the nominal band and then trimming back to it,
 * so the visible end is a cut through an ongoing helix rather than the pipe
 * shell's raw cap.
 *
 * A helix is transcendental, so OCCT still stores the swept faces as B-splines
 * (it has no analytic helicoid surface type); the win over a sampled spine is an
 * exact path with no sampling error and no `samplesPerTurn` knob whose value
 * traded off boolean/export robustness against smoothness.
 */
import {
  BRepBuilderAPI_MakeEdge,
  BRepBuilderAPI_MakeWire,
  BRepBuilderAPI_MakePolygon,
  BRepLib,
  BRepOffsetAPI_MakePipeShell,
  Geom2d_Line,
  Geom_CylindricalSurface,
  gp_Ax3,
  gp_Dir,
  gp_Dir2d,
  gp_Pnt,
  gp_Pnt2d,
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
  /** Extra helix generated before z=0 before trimming, matching BOSL2's non-blunt thread run-out. */
  startOverrun?: number;
  /** Extra helix generated after z=length before trimming, matching BOSL2's non-blunt thread run-out. */
  endOverrun?: number;
};

/**
 * The helical thread ridge alone — BOSL2's `thread_helix()`. Fuse it onto a
 * rod for external threads, or subtract it from a bore wall for internal ones.
 */
export function helicalRidge(options: HelicalRidgeOptions): TopoDS_Shape {
  const { baseRadius, pitch, length, depth } = options;
  const flankAngleDeg = options.flankAngleDeg ?? 30;
  const apexWidth = options.apexWidth ?? pitch / 8;
  const startOverrun = options.startOverrun ?? 0;
  const endOverrun = options.endOverrun ?? 0;
  const spineStartZ = -startOverrun;
  const spineLength = length + startOverrun + endOverrun;
  const rootWidth = apexWidth + 2 * depth * Math.tan((flankAngleDeg * Math.PI) / 180);
  // Sink the root slightly under the surface so booleans against the core are watertight.
  const rootInset = Math.min(0.2, depth * 0.25);

  // Exact helix: a straight line in the (u, v) parameter space of a cylinder of
  // radius `baseRadius`, where u is the angle and v the axial height. Advancing
  // u by 2π advances v by one pitch, so the pcurve direction is (2π/pitch, 1).
  // `BRepLib.BuildCurve3d` realises the 3D edge the pipe shell follows.
  const helixOrigin = new gp_Pnt(0, 0, 0);
  const helixAxisDir = new gp_Dir(0, 0, 1);
  const helixRefDir = new gp_Dir(1, 0, 0);
  const helixAxes = new gp_Ax3(helixOrigin, helixAxisDir, helixRefDir);
  const cylinderSurface = new Geom_CylindricalSurface(helixAxes, baseRadius);
  const pcurveStart = new gp_Pnt2d((2 * Math.PI * spineStartZ) / pitch, spineStartZ);
  const pcurveDir = new gp_Dir2d((2 * Math.PI) / pitch, 1);
  const pcurve = new Geom2d_Line(pcurveStart, pcurveDir);
  // gp_Dir2d normalises its direction, so the edge parameter runs in (u, v) arc
  // length: one unit of v costs `pcurveMagnitude` of parameter.
  const pcurveMagnitude = Math.hypot((2 * Math.PI) / pitch, 1);
  const spineEdge = new BRepBuilderAPI_MakeEdge(pcurve, cylinderSurface, 0, spineLength * pcurveMagnitude);
  BRepLib.BuildCurve3d(spineEdge.Edge());
  const spineWire = new BRepBuilderAPI_MakeWire(spineEdge.Edge());
  helixOrigin.delete();
  helixAxisDir.delete();
  helixRefDir.delete();
  helixAxes.delete();
  pcurveStart.delete();
  pcurveDir.delete();

  // Trapezoid cross-section in the radial/Z plane at the helix start.
  const profile = new BRepBuilderAPI_MakePolygon();
  const startAngle = (2 * Math.PI * spineStartZ) / pitch;
  const radialX = Math.cos(startAngle);
  const radialY = Math.sin(startAngle);
  const profilePoints: ReadonlyArray<readonly [number, number]> = [
    [baseRadius - rootInset, -rootWidth / 2],
    [baseRadius + depth, -apexWidth / 2],
    [baseRadius + depth, apexWidth / 2],
    [baseRadius - rootInset, rootWidth / 2],
  ];
  for (const [radius, z] of profilePoints) {
    const point = new gp_Pnt(radius * radialX, radius * radialY, spineStartZ + z);
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
  pcurve.delete();
  cylinderSurface.delete();

  // Trim the over-generated helix flush with the z = [0, length] band.
  return intersect(ridge, cylinder(baseRadius + depth + 1, length));
}

export type ThreadedRodOptions = {
  /** Nominal major (crest) diameter, e.g. 14 for M14. */
  majorDiameter: number;
  length: number;
  pitch: number;
  /** Extra radial clearance, like BOSL2's `$slop`. */
  clearance?: number;
  /** Extra helix generated before z=0 before trimming. Use one pitch for BOSL2 `blunt_start=false`. */
  startOverrun?: number;
  /** Extra helix generated after z=length before trimming. Use one pitch for BOSL2 `blunt_start=false`. */
  endOverrun?: number;
};

export type ThreadedRodWithExtendedCoreOptions = ThreadedRodOptions & {
  /** Length of the root cylinder under and beyond the visible threaded band. */
  coreLength: number;
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
      startOverrun: options.startOverrun,
      endOverrun: options.endOverrun,
    }),
  );
}

/**
 * External threaded rod whose root cylinder continues beyond the visible
 * thread. This keeps collar/hex fuses from creating an internal disk at the
 * end of the threaded band while preserving the helical ridge run-out.
 */
export function threadedRodWithExtendedCore(options: ThreadedRodWithExtendedCoreOptions): TopoDS_Shape {
  const clearance = options.clearance ?? 0;
  const depth = 0.5413 * options.pitch;
  const coreRadius = options.majorDiameter / 2 - depth + clearance;

  return fuse(
    cylinder(coreRadius, Math.max(options.length, options.coreLength)),
    helicalRidge({
      baseRadius: coreRadius,
      pitch: options.pitch,
      length: options.length,
      depth,
      startOverrun: options.startOverrun,
      endOverrun: options.endOverrun,
    }),
  );
}
