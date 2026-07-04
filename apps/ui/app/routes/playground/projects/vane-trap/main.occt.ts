/**
 * Blue Vane Trap — OpenCASCADE port of `main.scad` (the "assembly" view).
 *
 * The funnel cone is two frusta (the original's `hull()` of thin end disks),
 * the vanes are slotted boxes, and the jar-thread mask comes from
 * `lib/threads.ts`. Faithfulness note: the original places both the thread
 * mask and the key-slot cuts where they intersect nothing (the mask floats
 * inside the already-hollow cone, the key slots sit outside the tapered
 * wall), so — like the OpenSCAD render — they have no visible effect. They
 * are reproduced anyway to keep the two variants structurally identical.
 */
import type { TopoDS_Shape } from 'opencascade.js';
import { boxAt, cone, cut, cylinder, fuse, rotateZ, translate } from './lib/occt-utils.js';
import { helicalRidge } from './lib/threads.js';

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

export default function main(params: Params = defaultParams): TopoDS_Shape {
  const p = { ...defaultParams, ...params };
  return fuse(funnel(p), translate(vaneAssembly(p), [0, 0, p.funnelHeight - p.keyHeight / 2]));
}

/** `funnel_only()` — cone shell with collar, hollowed, thread mask and key slots cut. */
function funnel(p: Params): TopoDS_Shape {
  const keyWidth = p.vaneWidth / 2 + 4;
  const keyDepth = p.vaneThickness + 1;

  const keySlots = [0, 90, 180, 270].map((angleDeg) =>
    rotateZ(
      boxAt([0, p.funnelTopDiameter / 2 - 0.1, p.funnelHeight - p.keyHeight], keyWidth, keyDepth, p.keyHeight),
      angleDeg,
    ),
  );

  return cut(funnelShell(p), funnelInterior(p), jarThreadMask(p), ...keySlots);
}

/** Outer cone (`hull()` of the two rim disks) plus the jar collar below z = 0. */
function funnelShell(p: Params): TopoDS_Shape {
  // The collar reaches a hair past z = 0 into the cone: exactly coincident
  // seams in a fuse can poison later cuts (see the porting notes).
  const seamOverlap = 0.01;
  return fuse(
    cone(p.funnelTopDiameter / 2, p.funnelBottomDiameter / 2 + p.wallThickness, p.funnelHeight + 0.5),
    translate(cylinder(p.jarThreadOuterDiameter / 2 + p.wallThickness, p.jarThreadLength + seamOverlap), [
      0,
      0,
      -p.jarThreadLength,
    ]),
  );
}

/** Interior cavity cone. */
function funnelInterior(p: Params): TopoDS_Shape {
  return cone(p.funnelTopDiameter / 2 - p.wallThickness, p.funnelBottomDiameter / 2, p.funnelHeight + 0.5);
}

/** `make_jar_threads()` — female thread mask (BOSL2 `thread_helix`, 15° flanks). */
function jarThreadMask(p: Params): TopoDS_Shape {
  const depth = p.jarThreadPitch * 0.35;
  const turns = (p.jarThreadLength + 2) / p.jarThreadPitch;
  return translate(
    helicalRidge({
      baseRadius: (p.jarThreadOuterDiameter + 0.3) / 2,
      pitch: p.jarThreadPitch,
      length: turns * p.jarThreadPitch,
      depth,
      flankAngleDeg: 15,
      apexWidth: p.jarThreadPitch * 0.25,
    }),
    [0, 0, -0.1],
  );
}

/** `single_vane()` — flat plate with the interlock slot cut from the bottom. */
function singleVane(p: Params): TopoDS_Shape {
  const slotWidth = p.vaneThickness + p.slotClearance;
  const slotDepth = p.vaneHeight / 2;
  return cut(
    boxAt([0, 0, p.vaneHeight / 2], p.vaneThickness, p.vaneWidth, p.vaneHeight),
    boxAt([0, 0, slotDepth / 2], slotWidth, p.vaneWidth + 2, slotDepth),
  );
}

/** Two identical vanes crossed at 90°. */
function vaneAssembly(p: Params): TopoDS_Shape {
  return fuse(singleVane(p), rotateZ(singleVane(p), 90));
}
