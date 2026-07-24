/**
 * Pleated Pendant Lamp — Replicad port of `Main.scad`, alongside the raw
 * `opencascade.js` port in `main.occt.ts`.
 *
 * Same construction as that port: exact spheres, tori and cylinders rather than
 * the original's `$fn = 100` tessellation. Replicad has no torus primitive, so
 * each pleat is a revolved circle — which is literally what the OpenSCAD source
 * writes (`rotate_extrude() translate([major, 0]) circle(minor)`).
 */
import { drawCircle, makeCylinder, makeSphere } from 'replicad';
import type { Shape3D } from 'replicad';

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

export default function main(params: Params = defaultParams): Shape3D {
  const p = { ...defaultParams, ...params };
  const openingRadius = p.openingDiameter / 2;
  // z of the sphere surface at the opening rim: radius * cos(asin(openingRadius / radius)).
  const openingZ = Math.sqrt(Math.max(0, p.radius ** 2 - openingRadius ** 2));

  const pleats = pleatRings(p, openingRadius);
  const openings = [topOpeningCutter(p, openingRadius), bottomOpeningCutter(p, openingRadius)];
  const innerSphere = makeSphere(p.radius - p.thickness);

  let shade: Shape3D;
  if (p.pleatsInside) {
    // Hollow shell with openings first, pleats added on the inside after.
    shade = cutAll(makeSphere(p.radius).cut(innerSphere), openings);
    shade = fuseAll(shade, pleats);
  } else {
    // Pleated exterior first, then openings, then hollow interior.
    shade = cutAll(fuseAll(makeSphere(p.radius), pleats), [...openings, innerSphere]);
  }

  const brims: Shape3D[] = [];
  if (p.topBrim) {
    brims.push(brimRing(openingRadius, p.shadeThickness, -p.shadeDepth, openingZ));
  }

  if (p.bottomBrim) {
    brims.push(brimRing(openingRadius, p.shadeThickness, p.shadeDepth, -openingZ));
  }

  return fuseAll(shade, brims);
}

const fuseAll = (base: Shape3D, tools: readonly Shape3D[]): Shape3D =>
  tools.reduce((shape, tool) => shape.fuse(tool), base);

const cutAll = (base: Shape3D, tools: readonly Shape3D[]): Shape3D =>
  tools.reduce((shape, tool) => shape.cut(tool), base);

/** Torus around +Z centred at `z` — `rotate_extrude() translate([major, 0]) circle(minor)`. */
function torusAt(z: number, majorRadius: number, minorRadius: number): Shape3D {
  return drawCircle(minorRadius).translate(majorRadius, 0).sketchOnPlane('XZ').revolve([0, 0, 1]).translate([0, 0, z]);
}

/** One torus per pleat row, skipping rows that would collide with the openings. */
function pleatRings(p: Params, openingRadius: number): Shape3D[] {
  const rings: Shape3D[] = [];
  for (let z = -p.radius; z <= p.radius; z += p.pleatGap) {
    const sliceRadius = Math.sqrt(Math.max(0, p.radius ** 2 - z * z));
    if (sliceRadius <= openingRadius + p.pleatHeight * 2) {
      continue;
    }

    const majorRadius = sliceRadius + p.pleatOffset;
    if (majorRadius > p.pleatHeight) {
      rings.push(torusAt(z, majorRadius, p.pleatHeight));
    }
  }

  return rings;
}

/** `cylinder(h = radius + thickness, r = openingRadius)` from z = 0 upward. */
function topOpeningCutter(p: Params, openingRadius: number): Shape3D {
  return makeCylinder(openingRadius, p.radius + p.thickness);
}

/** Same cylinder translated down by its own height — the bottom opening. */
function bottomOpeningCutter(p: Params, openingRadius: number): Shape3D {
  return makeCylinder(openingRadius, p.radius + p.thickness, [0, 0, -(p.radius + p.thickness)]);
}

/**
 * Shade-holder ring: `rotate_extrude()` of a rectangle straddling the opening
 * radius — a tube of the given wall thickness extending `depth` from the rim
 * (negative depth extends downward).
 */
function brimRing(openingRadius: number, wallThickness: number, depth: number, atZ: number): Shape3D {
  const height = Math.abs(depth);
  const z = depth < 0 ? atZ + depth : atZ;
  return makeCylinder(openingRadius, height, [0, 0, z]).cut(
    makeCylinder(openingRadius - wallThickness, height, [0, 0, z]),
  );
}
