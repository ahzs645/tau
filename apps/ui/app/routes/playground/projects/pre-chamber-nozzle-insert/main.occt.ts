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
import {
  cone,
  cutSequentially,
  cylinder,
  drillCylindricalHole,
  fuse,
  healedFuse,
  regularPrism,
  rotateZ,
  segmentedCone,
  translate,
} from './lib/occt-utils.js';
import { threadedRod, threadedRodWithExtendedCore } from './lib/threads.js';

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
  const bodyWithCenterBore = cutSequentially(positiveBody(p), centerBoreCutter(p));
  const bodyWithSideHoles = drillSideHoles(bodyWithCenterBore, p);
  return cutSequentially(bodyWithSideHoles, ...rearSubtractiveFeatures(p));
}

function positiveBody(p: Params): TopoDS_Shape {
  const hexHeight = p.overallLength - p.noseLength - p.threadedLength - p.collarHeight;
  // OpenSCAD's hex `cylinder(d, $fn=6)` takes the vertex-to-vertex diameter;
  // across-flats = √3 · radius.
  const hexVertexRadius = p.hexAcrossFlats / Math.sqrt(3);
  // BOSL2 `blunt_start=false` generates about one extra pitch and clips back to
  // the nominal band, avoiding a raw sweep cap at the thread/cone boundary.
  const externalThreadRunout = p.externalThreadPitch;
  // Stacked parts overlap by a hair instead of touching face-to-face:
  // exactly coincident seams in the fuse poison later cuts (tool material
  // leaks into the result around the seam).
  const seamOverlap = 0.01;
  const threadedBase = healedFuse(
    // Split the analytic conical surface into a few face domains so OCCT can
    // cut the three oblique nozzle ports without leaving tool artifacts. Keep
    // the patch seams between the 0/120/240-degree side-hole cutters.
    segmentedCone(p.noseTipFlatDiameter / 2, p.externalThreadMajorDiameter / 2, p.noseLength, {
      seamOffsetTurns: -1 / 6,
    }),
    // M14x1.25 external threaded body.
    translate(
      threadedRodWithExtendedCore({
        majorDiameter: p.externalThreadMajorDiameter,
        length: p.threadedLength,
        pitch: p.externalThreadPitch,
        startOverrun: externalThreadRunout,
        endOverrun: externalThreadRunout,
        coreLength: p.overallLength - p.noseLength,
      }),
      [0, 0, p.noseLength],
    ),
  );

  return fuse(
    threadedBase,
    // Round collar immediately below the hex.
    translate(cylinder(p.collarDiameter / 2, p.collarHeight + seamOverlap), [
      0,
      0,
      p.noseLength + p.threadedLength - seamOverlap,
    ]),
    // Hex end.
    translate(rotateZ(regularPrism(hexVertexRadius, hexHeight + seamOverlap, 6), 30), [
      0,
      0,
      p.noseLength + p.threadedLength + p.collarHeight - seamOverlap,
    ]),
  );
}

function rearSubtractiveFeatures(p: Params): TopoDS_Shape[] {
  const internalThreadStartZ = p.overallLength - p.internalThreadDepth;
  const internalThreadRunout = p.internalThreadPitch;

  return [
    // Rear bore lead-in chamfer.
    translate(cone((p.internalThreadMajorDiameter + 1.7) / 2, (p.internalThreadMajorDiameter + 0.3) / 2, 1.4), [
      0,
      0,
      p.overallLength - 1.1,
    ]),
    // Rear M10x1.0 internal thread mask (`threaded_rod(internal=true)`).
    translate(
      threadedRod({
        majorDiameter: p.internalThreadMajorDiameter,
        length: p.internalThreadDepth + 2 * eps,
        pitch: p.internalThreadPitch,
        startOverrun: internalThreadRunout,
        endOverrun: internalThreadRunout,
      }),
      [0, 0, internalThreadStartZ - eps],
    ),
  ];
}

function centerBoreCutter(p: Params): TopoDS_Shape {
  const internalThreadStartZ = p.overallLength - p.internalThreadDepth;
  const preChamberEndZ = internalThreadStartZ + 0.6;

  return healedFuse(
    translate(rotateZ(cylinder(p.axialHoleDiameter / 2, p.preChamberStartZ + 2 * eps), 60), [0, 0, -eps]),
    translate(rotateZ(cylinder(p.preChamberDiameter / 2, preChamberEndZ - p.preChamberStartZ), 60), [
      0,
      0,
      p.preChamberStartZ,
    ]),
  );
}

function drillSideHoles(base: TopoDS_Shape, p: Params): TopoDS_Shape {
  let result = drillAngledRadialHole(base, p, p.sideLargeHoleDiameter, 0);
  result = drillAngledRadialHole(result, p, p.sideSmallHoleDiameter, 120);
  return drillAngledRadialHole(result, p, p.sideSmallHoleDiameter, 240);
}

function drillAngledRadialHole(base: TopoDS_Shape, p: Params, diameter: number, azimuthDeg: number): TopoDS_Shape {
  const elevationDeg = -p.sideHoleTiltDeg;
  const elevationRad = (elevationDeg * Math.PI) / 180;
  const azimuthRad = (azimuthDeg * Math.PI) / 180;
  const direction = [
    Math.cos(elevationRad) * Math.cos(azimuthRad),
    Math.cos(elevationRad) * Math.sin(azimuthRad),
    Math.sin(elevationRad),
  ] as const;
  return drillCylindricalHole(base, [0, 0, p.sideHoleZ], direction, diameter / 2);
}
