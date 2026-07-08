/**
 * Parametric Gel Comb — OpenCASCADE port of `main.scad`.
 *
 * A faithful BRep translation of the OpenSCAD original. The model is a set of
 * 2D profiles extruded and unioned: the bar and downward teeth are lower-left
 * anchored rounded rectangles (`rounded_rect_2d`), the upper slots are fully
 * rounded obrounds, the angled end hooks are extruded polygons, and the raised
 * front/back ridge bands are thin slabs clipped to the bar face. Independent
 * `barThickness`/`toothThickness` are preserved, so the teeth stay thinner than
 * the bar just like the source.
 *
 * Deviations, both cosmetic and within OpenSCAD's own `$fn` tolerance:
 * - The hook corners' 0.4 mm molded radius (`offset(r) offset(-r)`) is dropped;
 *   the hooks are sharp polygons.
 * - `text()` labels are off by default; when enabled they render through the
 *   single-stroke stencil font in `lib/text.ts` (the OCCT wasm build ships no
 *   font engine), upper-cased.
 */
import type { TopoDS_Shape } from 'opencascade.js';
import { box, cut, fuse, intersect, polygonPrism, roundedRectPrism, translate } from './lib/occt-utils.js';
import type { Vec2 } from './lib/occt-utils.js';
import { strokeText } from './lib/text.js';

export const defaultParams = {
  // Teeth
  toothCount: 38,
  toothLength: 20,
  toothWidth: 3,
  toothThickness: 0.7,
  toothGap: 1.5,
  toothCornerRadius: 0.35,

  // Main body
  barThickness: 1,
  sideOverhang: 3.7,
  barHeight: 18,
  bodyCornerRadius: 0.6,

  // Rounded gaps/slots above the teeth
  slotCount: 2,
  slotHeight: 3,
  slotWidthManual: 0,
  slotGap: 4,
  slotSideMargin: 6,
  slotCenterY: 9.8,

  // Side hooks / small angled end teeth
  showSideHooks: true,
  hookWidth: 2.2,
  hookDrop: 6,
  hookAttachHeight: 1.2,
  hookRadius: 0.4,
  leftHookAngleDegrees: 8,
  rightHookAngleDegrees: 8,
  hookTipOutwardExtra: 0,

  // Raised ridge bands
  showFrontRidges: true,
  showBackRidges: false,
  frontRidgeThickness: 0.2,
  backRidgeThickness: 0.2,
  topRidgeHeight: 1,
  bottomRidgeHeight: 1,
  bottomRidgeGapFromTeeth: 1,
  ridgeXOverhang: 0,
  clipRidgesToCombBody: true,

  // Raised front text (off by default)
  showLabels: false,
  labelRaise: 0.25,
  labelSize: 4,
  labelY: 14.1,
  leftLabel: '',
  middleLabel: 'BIO-RAD',
  rightLabel: '1.0mm',
};

type Params = typeof defaultParams;

// Exactly coincident seams in a fuse can poison booleans (see the porting notes
// in docs/research/openscad-opencascade-project-variants.md), so parts that
// stack face-to-face get a hair of interpenetration instead of touching.
const seamOverlap = 0.01;

const tanDeg = (degrees: number): number => Math.tan((degrees * Math.PI) / 180);

export default function main(params: Params = defaultParams): TopoDS_Shape {
  const p = { ...defaultParams, ...params };
  return gelComb(p);
}

/** Values derived from the parameters — the OpenSCAD "Calculated geometry" block. */
type Derived = {
  toothPitch: number;
  teethSpan: number;
  barWidth: number;
  slotWidth: number;
  slotStartX: number;
  slotY: number;
  slotRadius: number;
  ridgeWidth: number;
};

function derive(p: Params): Derived {
  const toothPitch = p.toothWidth + p.toothGap;
  const teethSpan = p.toothCount * p.toothWidth + (p.toothCount - 1) * p.toothGap;
  const barWidth = teethSpan + 2 * p.sideOverhang;
  const autoSlotWidth =
    p.slotCount > 0 ? (barWidth - 2 * p.slotSideMargin - (p.slotCount - 1) * p.slotGap) / p.slotCount : 0;
  const slotWidth = p.slotWidthManual > 0 ? p.slotWidthManual : autoSlotWidth;
  const slotGroupWidth = p.slotCount * slotWidth + (p.slotCount - 1) * p.slotGap;
  const slotStartX = p.slotWidthManual > 0 ? -slotGroupWidth / 2 : -barWidth / 2 + p.slotSideMargin;
  const slotY = p.slotCenterY - p.slotHeight / 2;
  const slotRadius = p.slotHeight / 2;
  const ridgeWidth = barWidth + 2 * p.ridgeXOverhang;
  return { toothPitch, teethSpan, barWidth, slotWidth, slotStartX, slotY, slotRadius, ridgeWidth };
}

/**
 * `gel_comb()` — bar (minus slots) + downward teeth + hooks + raised details.
 *
 * Every piece is handed to ONE fuse as an individual solid, with the bar face
 * as the base. The teeth (1.5 mm gaps) and the two ridge bands are mutually
 * disjoint, so pre-fusing any group would build a `TopoDS_Compound`, and this
 * OCCT build silently drops components when a compound is a boolean operand
 * (see the porting notes). Each tooth/hook/band/label instead overlaps the bar
 * directly, so the single union is one connected, watertight solid.
 */
function gelComb(p: Params): TopoDS_Shape {
  const d = derive(p);
  const parts: TopoDS_Shape[] = [barFace(p, d), ...teeth(p, d)];

  if (p.showFrontRidges && p.frontRidgeThickness > 0) {
    // Sits on the +Z face, sunk a hair into the bar for a clean union.
    parts.push(...ridgeBands(p, d, p.barThickness - seamOverlap, p.frontRidgeThickness + seamOverlap));
  }

  if (p.showBackRidges && p.backRidgeThickness > 0) {
    // Sits on the −Z face, going outward in negative Z.
    parts.push(...ridgeBands(p, d, -p.backRidgeThickness, p.backRidgeThickness + seamOverlap));
  }

  if (p.showLabels) {
    parts.push(...labelSolids(p, d));
  }

  return fuse(...parts);
}

/** `linear_extrude(bar_thickness) bar_face_2d()` — the upper bar with the slots bored through. */
function barFace(p: Params, d: Derived): TopoDS_Shape {
  const outline = translate(roundedRectPrism(d.barWidth, p.barHeight, p.bodyCornerRadius, p.barThickness), [
    -d.barWidth / 2,
    0,
    0,
  ]);
  return cut(outline, ...slotCutters(p, d, -seamOverlap, p.barThickness + 2 * seamOverlap));
}

/**
 * `linear_extrude(tooth_thickness) teeth_outline_2d()` — the downward teeth plus
 * the angled end hooks, returned as individual solids (see {@link gelComb}).
 * Each tooth's +0.1 mm extra height overlaps the bar at y = 0 so the union
 * connects it to the body.
 */
function teeth(p: Params, d: Derived): TopoDS_Shape[] {
  const solids: TopoDS_Shape[] = [];
  for (let i = 0; i < p.toothCount; i += 1) {
    const x = -d.teethSpan / 2 + i * d.toothPitch;
    solids.push(
      translate(roundedRectPrism(p.toothWidth, p.toothLength + 0.1, p.toothCornerRadius, p.toothThickness), [
        x,
        -p.toothLength,
        0,
      ]),
    );
  }

  if (p.showSideHooks) {
    solids.push(hookPrism(p, d, -1, p.leftHookAngleDegrees), hookPrism(p, d, 1, p.rightHookAngleDegrees));
  }

  return solids;
}

/** `side_hook_2d()` extruded — an angled end hook whose lower tip leans outward by `angleDeg`. */
function hookPrism(p: Params, d: Derived, side: number, angleDeg: number): TopoDS_Shape {
  const hookTotalHeight = p.hookDrop + p.hookAttachHeight;
  const outwardTipOffset = hookTotalHeight * tanDeg(angleDeg) + p.hookTipOutwardExtra;
  const tipShiftX = side * outwardTipOffset;

  const outerTopX = (side * d.barWidth) / 2;
  const innerTopX = outerTopX - side * p.hookWidth;
  const outerBottomX = outerTopX + tipShiftX;
  const innerBottomX = innerTopX + tipShiftX;

  const points: Vec2[] =
    side < 0
      ? [
          [outerBottomX, -p.hookDrop],
          [innerBottomX, -p.hookDrop],
          [innerTopX, p.hookAttachHeight],
          [outerTopX, p.hookAttachHeight],
        ]
      : [
          [innerBottomX, -p.hookDrop],
          [outerBottomX, -p.hookDrop],
          [outerTopX, p.hookAttachHeight],
          [innerTopX, p.hookAttachHeight],
        ];

  return polygonPrism(points, p.toothThickness);
}

/** Slot cutters: fully rounded obrounds bored through the bar (`slot_cutouts_2d`). */
function slotCutters(p: Params, d: Derived, zBase: number, thickness: number): TopoDS_Shape[] {
  if (p.slotCount <= 0 || d.slotWidth <= 0) {
    return [];
  }

  const cutters: TopoDS_Shape[] = [];
  for (let i = 0; i < p.slotCount; i += 1) {
    const x = d.slotStartX + i * (d.slotWidth + p.slotGap);
    cutters.push(translate(roundedRectPrism(d.slotWidth, p.slotHeight, d.slotRadius, thickness), [x, d.slotY, zBase]));
  }

  return cutters;
}

/**
 * `ridge_bands_2d()` extruded into a slab over [zStart, zStart + thickness],
 * one solid per band. When clipped to the comb body each band is intersected
 * with the bar face — the ridges live within the bar for every valid parameter
 * set, so the bar face reproduces the original's `intersection(comb_face_2d,
 * ...)` exactly; otherwise the raw band only has the slots bored out. Bands are
 * kept separate (not pre-fused) so no compound reaches a boolean (see
 * {@link gelComb}); each overlaps the bar and connects in the final union.
 */
function ridgeBands(p: Params, d: Derived, zStart: number, thickness: number): TopoDS_Shape[] {
  // Top band, then the lower band above the tooth roots — matching `ridge_bands_2d()`.
  const bands = [
    { yCenter: p.barHeight - p.topRidgeHeight / 2, stripHeight: p.topRidgeHeight },
    { yCenter: p.bottomRidgeGapFromTeeth + p.bottomRidgeHeight / 2, stripHeight: p.bottomRidgeHeight },
  ].filter((band) => band.stripHeight > 0);

  return bands.map(({ yCenter, stripHeight }) => {
    const band = bandBox(d, yCenter, stripHeight, zStart, thickness);
    return p.clipRidgesToCombBody
      ? intersect(barFaceSlab(p, d, zStart, thickness), band)
      : cut(band, ...slotCutters(p, d, zStart - seamOverlap, thickness + 2 * seamOverlap));
  });
}

/** One raised band strip: full ridge width, `stripH` tall in Y, over the given Z slab. */
function bandBox(d: Derived, yCenter: number, stripH: number, zStart: number, thickness: number): TopoDS_Shape {
  return translate(box(d.ridgeWidth, stripH, thickness), [-d.ridgeWidth / 2, yCenter - stripH / 2, zStart]);
}

/** A thin Z-slice of the bar face (bar rounded rect minus slots) used to clip the ridge bands. */
function barFaceSlab(p: Params, d: Derived, zStart: number, thickness: number): TopoDS_Shape {
  const outline = translate(roundedRectPrism(d.barWidth, p.barHeight, p.bodyCornerRadius, thickness), [
    -d.barWidth / 2,
    0,
    zStart,
  ]);
  return cut(outline, ...slotCutters(p, d, zStart - seamOverlap, thickness + 2 * seamOverlap));
}

/** `raised_text_3d()` for the three front labels, raised off the +Z face. */
function labelSolids(p: Params, d: Derived): TopoDS_Shape[] {
  const leftLabel = p.leftLabel === '' ? `${p.toothCount} well` : p.leftLabel;
  const placements: readonly [string, number, number][] = [
    [leftLabel, -d.barWidth * 0.28, p.labelSize],
    [p.middleLabel, 0, p.labelSize * 0.82],
    [p.rightLabel, d.barWidth * 0.28, p.labelSize],
  ];

  const solids: TopoDS_Shape[] = [];
  for (const [text, x, size] of placements) {
    // Extended down a hair below the +Z face so each stroke unions cleanly.
    for (const stroke of strokeText(text, { size, thickness: p.labelRaise + seamOverlap })) {
      solids.push(translate(stroke, [x, p.labelY, p.barThickness - seamOverlap]));
    }
  }

  return solids;
}
