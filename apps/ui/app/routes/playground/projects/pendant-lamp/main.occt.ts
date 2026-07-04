/**
 * Pleated Pendant Lamp — OpenCASCADE port of `Main.scad`.
 *
 * The OpenSCAD pleats are `rotate_extrude()` of a translated circle — which
 * is exactly a torus in BRep. The shade is a thin sphere shell with top and
 * bottom openings; the optional brims are revolved rectangles, i.e. tubes.
 * The `$fn = 100` tessellation knob disappears entirely: every surface here
 * is an exact sphere, torus, or cylinder.
 */
import type { TopoDS_Shape } from 'opencascade.js';
import { cut, cylinder, fuse, sphereAt, torusAt, translate } from './lib/occt-utils.js';

export const defaultParams = {
  radius: 100,
  thickness: 0.8,
  pleatGap: 2.8,
  pleatHeight: 1.2,
  pleatOffset: -1,
  openingDiameter: 80,
  shadeDepth: 15,
  shadeThickness: 2,
  topBrim: false,
  bottomBrim: true,
  pleatsInside: false,
};

type Params = typeof defaultParams;

export default function main(params: Params = defaultParams): TopoDS_Shape {
  const p = { ...defaultParams, ...params };
  const openingRadius = p.openingDiameter / 2;
  // z of the sphere surface at the opening rim: radius * cos(asin(openingRadius / radius)).
  const openingZ = Math.sqrt(Math.max(0, p.radius ** 2 - openingRadius ** 2));

  const pleats = pleatRings(p, openingRadius);
  const openings = [topOpeningCutter(p, openingRadius), bottomOpeningCutter(p, openingRadius)];
  const innerSphere = sphereAt([0, 0, 0], (p.radius - p.thickness) * 2);

  let shade: TopoDS_Shape;
  if (p.pleatsInside) {
    // Hollow shell with openings first, pleats added on the inside after.
    const shell = cut(sphereAt([0, 0, 0], p.radius * 2), innerSphere, ...openings);
    shade = pleats.length > 0 ? fuse(shell, ...pleats) : shell;
  } else {
    // Pleated exterior first, then openings, then hollow interior.
    const pleated =
      pleats.length > 0 ? fuse(sphereAt([0, 0, 0], p.radius * 2), ...pleats) : sphereAt([0, 0, 0], p.radius * 2);
    shade = cut(pleated, ...openings, innerSphere);
  }

  const brims: TopoDS_Shape[] = [];
  if (p.topBrim) {
    brims.push(brimRing(openingRadius, p.shadeThickness, -p.shadeDepth, openingZ));
  }

  if (p.bottomBrim) {
    brims.push(brimRing(openingRadius, p.shadeThickness, p.shadeDepth, -openingZ));
  }

  return brims.length > 0 ? fuse(shade, ...brims) : shade;
}

/** One torus per pleat row, skipping rows that would collide with the openings. */
function pleatRings(p: Params, openingRadius: number): TopoDS_Shape[] {
  const rings: TopoDS_Shape[] = [];
  for (let z = -p.radius; z <= p.radius; z += p.pleatGap) {
    const sliceRadius = Math.sqrt(Math.max(0, p.radius ** 2 - z * z));
    if (sliceRadius <= openingRadius + p.pleatHeight * 2) {
      continue;
    }

    const majorRadius = sliceRadius + p.pleatOffset;
    if (majorRadius > p.pleatHeight) {
      rings.push(torusAt([0, 0, z], majorRadius, p.pleatHeight));
    }
  }

  return rings;
}

/** `cylinder(h = radius + thickness, r = openingRadius)` from z = 0 upward. */
function topOpeningCutter(p: Params, openingRadius: number): TopoDS_Shape {
  return cylinder(openingRadius, p.radius + p.thickness);
}

/** Same cylinder translated down by its own height — the bottom opening. */
function bottomOpeningCutter(p: Params, openingRadius: number): TopoDS_Shape {
  return translate(cylinder(openingRadius, p.radius + p.thickness), [0, 0, -(p.radius + p.thickness)]);
}

/**
 * Shade-holder ring: `rotate_extrude()` of a rectangle straddling the
 * opening radius — a tube of the given wall thickness extending `depth`
 * from the rim (negative depth extends downward).
 */
function brimRing(openingRadius: number, wallThickness: number, depth: number, atZ: number): TopoDS_Shape {
  const outer = cylinder(openingRadius, Math.abs(depth));
  const inner = cylinder(openingRadius - wallThickness, Math.abs(depth));
  const tube = cut(outer, inner);
  return translate(tube, [0, 0, depth < 0 ? atZ + depth : atZ]);
}
