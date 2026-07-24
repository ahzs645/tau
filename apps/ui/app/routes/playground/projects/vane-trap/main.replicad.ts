/**
 * Blue Vane Trap — Replicad port of `main.scad`, alongside the raw
 * `opencascade.js` port in `main.occt.ts`.
 *
 * Same model, same construction order, same kernel underneath (Replicad is a
 * layer over OpenCASCADE): this variant exists to compare the two authoring
 * levels. Everything the raw port needed a hand-written `lib/occt-utils.ts` for
 * — frusta, centred boxes, transforms, boolean helpers, and a swept helical
 * thread — is expressed here with the library's own API, so the only project
 * code left is the model itself.
 *
 * Faithfulness note (carried over from the OCCT port): the original places both
 * the thread mask and the key-slot cuts where they intersect nothing, so — like
 * the OpenSCAD render — they have no visible effect. They are reproduced anyway
 * to keep the variants structurally identical.
 */
import { draw, makeBaseBox, makeCylinder, sketchHelix } from 'replicad';
import type { Shape3D } from 'replicad';

export const defaultParams = {
  jarThreadOuterDiameter: 86.6,
  jarThreadPitch: 3.175,
  jarThreadLength: 8,
  funnelTopDiameter: 120,
  funnelBottomDiameter: 50,
  funnelHeight: 40,
  wallThickness: 2,
  vaneHeight: 140,
  vaneWidth: 130,
  vaneThickness: 2,
  slotClearance: 0.25,
  keyHeight: 8,
};

type Params = typeof defaultParams;

export default function main(params: Params = defaultParams): Shape3D {
  const p = { ...defaultParams, ...params };
  return funnel(p).fuse(vaneAssembly(p).translate([0, 0, p.funnelHeight - p.keyHeight / 2]));
}

/** Conical frustum along +Z from the origin — OpenSCAD's `cylinder(r1, r2, h)`. */
function frustum(bottomRadius: number, topRadius: number, height: number): Shape3D {
  return draw([0, 0])
    .lineTo([bottomRadius, 0])
    .lineTo([topRadius, height])
    .lineTo([0, height])
    .close()
    .sketchOnPlane('XZ')
    .revolve([0, 0, 1]);
}

/** `cube(size, center = true)` at a point — replicad boxes are centred in x/y but not z. */
function boxAt(center: readonly [number, number, number], dx: number, dy: number, dz: number): Shape3D {
  return makeBaseBox(dx, dy, dz).translate([center[0], center[1], center[2] - dz / 2]);
}

/** `funnel_only()` — cone shell with collar, hollowed, thread mask and key slots cut. */
function funnel(p: Params): Shape3D {
  const keyWidth = p.vaneWidth / 2 + 4;
  const keyDepth = p.vaneThickness + 1;

  let shape = funnelShell(p).cut(funnelInterior(p)).cut(jarThreadMask(p));
  for (const angleDeg of [0, 90, 180, 270]) {
    shape = shape.cut(
      boxAt([0, p.funnelTopDiameter / 2 - 0.1, p.funnelHeight - p.keyHeight], keyWidth, keyDepth, p.keyHeight).rotate(
        angleDeg,
        [0, 0, 0],
        [0, 0, 1],
      ),
    );
  }

  return shape;
}

/** Outer cone (`hull()` of the two rim disks) plus the jar collar below z = 0. */
function funnelShell(p: Params): Shape3D {
  // The collar reaches a hair past z = 0 into the cone: exactly coincident
  // seams in a fuse can poison later cuts (see the porting notes).
  const seamOverlap = 0.01;
  return frustum(p.funnelTopDiameter / 2, p.funnelBottomDiameter / 2 + p.wallThickness, p.funnelHeight + 0.5).fuse(
    makeCylinder(p.jarThreadOuterDiameter / 2 + p.wallThickness, p.jarThreadLength + seamOverlap, [
      0,
      0,
      -p.jarThreadLength,
    ]),
  );
}

/** Interior cavity cone. */
function funnelInterior(p: Params): Shape3D {
  return frustum(p.funnelTopDiameter / 2 - p.wallThickness, p.funnelBottomDiameter / 2, p.funnelHeight + 0.5);
}

/** `make_jar_threads()` — female thread mask (BOSL2 `thread_helix`, 15° flanks). */
function jarThreadMask(p: Params): Shape3D {
  const depth = p.jarThreadPitch * 0.35;
  const turns = (p.jarThreadLength + 2) / p.jarThreadPitch;
  return helicalRidge({
    baseRadius: (p.jarThreadOuterDiameter + 0.3) / 2,
    pitch: p.jarThreadPitch,
    length: turns * p.jarThreadPitch,
    depth,
    flankAngleDeg: 15,
    apexWidth: p.jarThreadPitch * 0.25,
  }).translate([0, 0, -0.1]);
}

type HelicalRidgeOptions = {
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
 *
 * `sketchHelix` gives an exact analytic helix and `sweepSketch` places the
 * profile on the plane normal to the spine start, so the whole helper is the
 * trapezoid profile plus one sweep — no spine sampling, no manual Frenet
 * bookkeeping, and no shape lifetimes to manage.
 */
function helicalRidge(options: HelicalRidgeOptions): Shape3D {
  const { baseRadius, pitch, length, depth } = options;
  const flankAngleDeg = options.flankAngleDeg ?? 30;
  const apexWidth = options.apexWidth ?? pitch / 8;
  const rootWidth = apexWidth + 2 * depth * Math.tan((flankAngleDeg * Math.PI) / 180);
  // Sink the root slightly under the surface so booleans against the core are watertight.
  const rootInset = Math.min(0.2, depth * 0.25);

  const ridge = sketchHelix(pitch, length, baseRadius).sweepSketch(
    (plane, origin) =>
      draw([-rootInset, -rootWidth / 2])
        .lineTo([depth, -apexWidth / 2])
        .lineTo([depth, apexWidth / 2])
        .lineTo([-rootInset, rootWidth / 2])
        .close()
        .sketchOnPlane(plane, origin),
    { frenet: true },
  );

  // Trim the ridge run-out flush with the z = [0, length] band.
  return ridge.intersect(makeCylinder(baseRadius + depth + 1, length));
}

/** `single_vane()` — flat plate with the interlock slot cut from the bottom. */
function singleVane(p: Params): Shape3D {
  const slotWidth = p.vaneThickness + p.slotClearance;
  const slotDepth = p.vaneHeight / 2;
  return boxAt([0, 0, p.vaneHeight / 2], p.vaneThickness, p.vaneWidth, p.vaneHeight).cut(
    boxAt([0, 0, slotDepth / 2], slotWidth, p.vaneWidth + 2, slotDepth),
  );
}

/** Two identical vanes crossed at 90°. */
function vaneAssembly(p: Params): Shape3D {
  return singleVane(p).fuse(singleVane(p).rotate(90, [0, 0, 0], [0, 0, 1]));
}
