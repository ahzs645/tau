/**
 * Pre-chamber / jet-nozzle insert — OpenCASCADE port of
 * `prechamber_nozzle_insert_BOSL2_threads.scad` (corrected dimension preset).
 *
 * The M14x1.25 external and M10x1.0 internal threads are real helical BRep
 * geometry from `lib/threads.ts` — the OCCT analogue of BOSL2's
 * `threaded_rod()` — so the STEP export carries true thread surfaces.
 * Z = 0 is the conical nozzle tip; +Z runs toward the hex.
 */
import type { TopoDS_Shape } from 'opencascade.js';
import { cone, cut, cylinder, fuse, regularPrism, rotateY, rotateZ, translate } from './lib/occt-utils.js';
import { threadedRod } from './lib/threads.js';

export const defaultParams = {
  overallLength: 35,
  noseLength: 7,
  threadedLength: 21.5,
  collarHeight: 2.8,
  collarDiameter: 18.542,
  hexAcrossFlats: 15.875,
  externalThreadMajorDiameter: 14,
  externalThreadPitch: 1.25,
  internalThreadMajorDiameter: 10,
  internalThreadPitch: 1,
  internalThreadDepth: 19,
  noseTipFlatDiameter: 5.8,
  preChamberDiameter: 5.5,
  preChamberStartZ: 2.2,
  axialHoleDiameter: 2.5,
  sideLargeHoleDiameter: 2.5,
  sideSmallHoleDiameter: 1,
  sideHoleZ: 4.2,
  sideHoleCutLength: 14,
  /** Tilt from horizontal; positive tilts the outside opening toward the tip. */
  sideHoleTiltDeg: 30,
};

type Params = typeof defaultParams;

const eps = 0.03;

export default function main(params: Params = defaultParams): TopoDS_Shape {
  const p = { ...defaultParams, ...params };
  return cut(positiveBody(p), ...subtractiveFeatures(p));
}

function positiveBody(p: Params): TopoDS_Shape {
  const hexHeight = p.overallLength - p.noseLength - p.threadedLength - p.collarHeight;
  // OpenSCAD's hex `cylinder(d, $fn=6)` takes the vertex-to-vertex diameter;
  // across-flats = √3 · radius.
  const hexVertexRadius = p.hexAcrossFlats / Math.sqrt(3);

  return fuse(
    // Conical nozzle end.
    cone(p.noseTipFlatDiameter / 2, p.externalThreadMajorDiameter / 2, p.noseLength),
    // M14x1.25 external threaded body.
    translate(
      threadedRod({
        majorDiameter: p.externalThreadMajorDiameter,
        length: p.threadedLength,
        pitch: p.externalThreadPitch,
      }),
      [0, 0, p.noseLength],
    ),
    // Round collar immediately below the hex.
    translate(cylinder(p.collarDiameter / 2, p.collarHeight), [0, 0, p.noseLength + p.threadedLength]),
    // Hex end.
    translate(rotateZ(regularPrism(hexVertexRadius, hexHeight, 6), 30), [
      0,
      0,
      p.noseLength + p.threadedLength + p.collarHeight,
    ]),
  );
}

function subtractiveFeatures(p: Params): TopoDS_Shape[] {
  const internalThreadStartZ = p.overallLength - p.internalThreadDepth;
  const preChamberEndZ = internalThreadStartZ + 0.6;

  return [
    // 2.5 mm axial tip/orifice hole.
    translate(cylinder(p.axialHoleDiameter / 2, p.preChamberStartZ + 2 * eps), [0, 0, -eps]),
    // Internal pre-chamber behind the axial tip orifice.
    translate(cylinder(p.preChamberDiameter / 2, preChamberEndZ - p.preChamberStartZ), [0, 0, p.preChamberStartZ]),
    // Rear M10x1.0 internal thread mask (`threaded_rod(internal=true)`).
    translate(
      threadedRod({
        majorDiameter: p.internalThreadMajorDiameter,
        length: p.internalThreadDepth + 2 * eps,
        pitch: p.internalThreadPitch,
      }),
      [0, 0, internalThreadStartZ - eps],
    ),
    // Angled side holes in the conical nozzle end: one large, two small.
    angledRadialHole(p, p.sideLargeHoleDiameter, 0),
    angledRadialHole(p, p.sideSmallHoleDiameter, 120),
    angledRadialHole(p, p.sideSmallHoleDiameter, 240),
    // Rear bore lead-in chamfer.
    translate(cone((p.internalThreadMajorDiameter + 1.7) / 2, (p.internalThreadMajorDiameter + 0.3) / 2, 1.4), [
      0,
      0,
      p.overallLength - 1.1,
    ]),
  ];
}

/**
 * Side-hole cutter starting near the pre-chamber and exiting outward, tilted
 * from horizontal so the outside opening sits toward the tip.
 */
function angledRadialHole(p: Params, diameter: number, azimuthDeg: number): TopoDS_Shape {
  const elevationDeg = -p.sideHoleTiltDeg;
  const bore = translate(cylinder(diameter / 2, p.sideHoleCutLength + 0.6), [0, 0, -0.6]);
  return rotateZ(translate(rotateY(bore, 90 - elevationDeg), [0, 0, p.sideHoleZ]), azimuthDeg);
}
