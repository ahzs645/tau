/**
 * 3D Rack System — OpenCASCADE port of `main.scad`.
 *
 * The BOSL2 `cuboid()`/`xcyl()` calls are plain boxes and X-axis cylinders;
 * the dovetail rails and sockets are extruded trapezoid polygons; the
 * handle's `hull()` is built constructively (straight walls up to the corner
 * cylinders, a slab between them); and the engraved hole numbers — FreeType
 * `text()` in the original — use the stroke-digit font from `lib/text.ts`,
 * since the OCCT build ships no font engine. The assembly returns separate
 * per-part shapes with the original's colors, so STEP export keeps the parts.
 */
import type { TopoDS_Shape } from 'opencascade.js';
import {
  boxAt,
  cone,
  cut,
  cylinder,
  cylinderAt,
  fuse,
  polygonPrism,
  rotateX,
  rotateZ,
  roundedSlotX,
  translate,
  translateCopy,
  xcylAt,
} from './lib/occt-utils.js';
import type { Vec2 } from './lib/occt-utils.js';
import { engravedText } from './lib/text.js';

type NumberDirection = 'left_to_right' | 'right_to_left' | 'front_to_back' | 'back_to_front';
type ComponentSelection = 'assembly' | 'bottom_rack' | 'combined_rack' | 'vertical_support';

export const defaultParams = {
  rackWidth: 201,
  rackDepth: 222.4,
  rackHeight: 184,
  sectionHeight: 9.4,
  numPlates: 3,
  holeDiameter: 16,
  numHolesX: 0,
  numHolesY: 0,
  holeSpacing: 9.8,
  enableNumbers: true,
  numberDirection: 'left_to_right' as NumberDirection,
  enableCenterDots: true,
  numberDepth: 3,
  numberScale: 1,
  numberRotation: 0,
  numberSpacing: 3,
  numberVerticalOffset: 1,
  dovetailWidth: 15,
  dovetailHeight: 4,
  dovetailBackWidth: 18,
  supportThickness: 14.3,
  handleHeight: 60,
  slotWidth: 150,
  slotHeight: 36,
  slotCornerRadius: 6,
  cornerRadius: 5,
  dovetailSpacing: 60,
  dovetailStartHeight: 10,
  sideMargin: 30,
  frontMargin: 15,
  bottomDepth: 7,
  componentSelection: 'assembly' as ComponentSelection,
};

type Params = typeof defaultParams;

type PartEntry = { shape: TopoDS_Shape; name: string; color: string };

// Exactly coincident seams in a fuse can poison later cuts (see the porting
// notes in docs/research/openscad-opencascade-project-variants.md), so
// stacked parts get a hair of interpenetration instead of touching.
const seamOverlap = 0.01;

export default function main(params: Params = defaultParams): TopoDS_Shape | PartEntry[] {
  const p = { ...defaultParams, ...params };
  switch (p.componentSelection) {
    case 'bottom_rack': {
      return bottomRack(p);
    }

    case 'combined_rack': {
      return combinedRack(p);
    }

    case 'vertical_support': {
      return verticalSupport(p, 1);
    }

    default: {
      return assembly(p);
    }
  }
}

/** `assembly()` — stacked plates between two vertical supports, as colored parts. */
function assembly(p: Params): PartEntry[] {
  const parts: PartEntry[] = [
    {
      shape: translate(bottomRack(p), [0, 0, p.dovetailStartHeight]),
      name: 'Bottom rack',
      color: '#add8e6',
    },
  ];

  if (p.numPlates > 1) {
    // The numbered plates are identical — build once, place copies.
    const plate = combinedRack(p);
    for (let index = 1; index <= p.numPlates - 1; index += 1) {
      parts.push({
        shape: translateCopy(plate, [0, 0, p.dovetailStartHeight + p.dovetailSpacing * index]),
        name: `Combined rack ${index}`,
        color: '#90ee90',
      });
    }

    plate.delete();
  }

  const supportOffset = p.rackWidth / 2 + p.supportThickness / 2;
  parts.push(
    { shape: translate(verticalSupport(p, 1), [-supportOffset, 0, 0]), name: 'Left support', color: '#ffffff' },
    { shape: translate(verticalSupport(p, -1), [supportOffset, 0, 0]), name: 'Right support', color: '#ffffff' },
  );
  return parts;
}

//--------------------------//
// Hole Layout Calculation
//--------------------------//

type HoleLayout = { cols: number; rows: number; spacingX: number; spacingY: number };

/** `calc_hole_layout()` — hole counts and spacing, auto-spread when counts are 0. */
function holeLayout(p: Params): HoleLayout {
  const availWidth = p.rackWidth - 2 * p.sideMargin;
  const availDepth = p.rackDepth - 2 * p.frontMargin;

  const cols =
    p.numHolesX > 0 ? p.numHolesX : Math.floor((availWidth + p.holeSpacing) / (p.holeDiameter + p.holeSpacing));
  const rows =
    p.numHolesY > 0 ? p.numHolesY : Math.floor((availDepth + p.holeSpacing) / (p.holeDiameter + p.holeSpacing));

  const spacingX =
    p.numHolesX > 0 && p.holeSpacing > 0
      ? p.holeSpacing
      : cols <= 1
        ? 0
        : (availWidth - cols * p.holeDiameter) / (cols - 1);
  const spacingY =
    p.numHolesY > 0 && p.holeSpacing > 0
      ? p.holeSpacing
      : rows <= 1
        ? 0
        : (availDepth - rows * p.holeDiameter) / (rows - 1);

  return { cols, rows, spacingX, spacingY };
}

/** Center of hole (x, y) in plate coordinates (plate centered on the origin). */
function holeCenter(p: Params, layout: HoleLayout, x: number, y: number): Vec2 {
  return [
    -p.rackWidth / 2 + p.sideMargin + p.holeDiameter / 2 + x * (p.holeDiameter + layout.spacingX),
    -p.rackDepth / 2 + p.frontMargin + p.holeDiameter / 2 + y * (p.holeDiameter + layout.spacingY),
  ];
}

/** `get_hole_number()` — 1-based label per the numbering direction. */
function holeNumber(p: Params, x: number, y: number, totalX: number, totalY: number): number {
  switch (p.numberDirection) {
    case 'right_to_left': {
      return y * totalX + (totalX - x);
    }

    case 'front_to_back': {
      return x * totalY + y + 1;
    }

    case 'back_to_front': {
      return x * totalY + (totalY - y);
    }

    default: {
      return y * totalX + x + 1;
    }
  }
}

//--------------------------//
// Dovetails
//--------------------------//

/** `depth_dovetail_profile()` with the seam-overlap base extension folded in. */
function dovetailProfile(side: number, width: number, height: number, backWidth: number): readonly Vec2[] {
  return [
    [-side * seamOverlap, -width / 2],
    [side * height, -backWidth / 2],
    [side * height, backWidth / 2],
    [-side * seamOverlap, width / 2],
  ];
}

/** Extrude a dovetail profile along Y (the original's `rotate([90,0,0]) linear_extrude(center=true)`). */
function dovetailPrism(profile: readonly Vec2[], depth: number): TopoDS_Shape {
  return rotateX(translate(polygonPrism(profile, depth), [0, 0, -depth / 2]), 90);
}

/** `depth_dovetail_rail()` — male rail on the plate edge, running the full depth. */
function depthDovetailRail(p: Params, side: number): TopoDS_Shape {
  const profile = dovetailProfile(side, p.dovetailWidth, p.dovetailHeight, p.dovetailBackWidth);
  return translate(dovetailPrism(profile, p.rackDepth), [(side * p.rackWidth) / 2, 0, 0]);
}

/** `depth_dovetail_socket()` — female cutter for the support's inner face. */
function depthDovetailSocket(p: Params, side: number, clearance = 0.35): TopoDS_Shape {
  const profile = dovetailProfile(
    -side,
    p.dovetailWidth + clearance,
    p.dovetailHeight + clearance,
    p.dovetailBackWidth + clearance,
  );
  return translate(dovetailPrism(profile, p.rackDepth + 2), [(side * p.supportThickness) / 2, 0, 0]);
}

/** Plate slab plus both side rails (`cuboid()` + `rack_side_rails()`). */
function rackPlateBody(p: Params): TopoDS_Shape {
  return fuse(
    boxAt([0, 0, 0], p.rackWidth, p.rackDepth, p.sectionHeight),
    depthDovetailRail(p, -1),
    depthDovetailRail(p, 1),
  );
}

//--------------------------//
// Plates
//--------------------------//

/** `bottom_rack()` — plate with tapered blind dimples instead of through holes. */
function bottomRack(p: Params): TopoDS_Shape {
  const layout = holeLayout(p);
  const dimples: TopoDS_Shape[] = [];
  for (let x = 0; x < layout.cols; x += 1) {
    for (let y = 0; y < layout.rows; y += 1) {
      const [cx, cy] = holeCenter(p, layout, x, y);
      dimples.push(
        translate(cone(p.holeDiameter / 2, (p.holeDiameter * 0.9) / 2, p.bottomDepth), [
          cx,
          cy,
          p.sectionHeight - p.bottomDepth,
        ]),
      );
    }
  }

  return cut(rackPlateBody(p), ...dimples);
}

/** `combined_rack()` — plate with through holes, engraved numbers, and center dots. */
function combinedRack(p: Params): TopoDS_Shape {
  const layout = holeLayout(p);
  const cutters: TopoDS_Shape[] = [];
  for (let x = 0; x < layout.cols; x += 1) {
    for (let y = 0; y < layout.rows; y += 1) {
      const [cx, cy] = holeCenter(p, layout, x, y);
      cutters.push(cylinderAt([cx, cy, 0], p.holeDiameter / 2, p.sectionHeight * 3));

      if (p.enableNumbers) {
        cutters.push(...numberEngraving(p, holeNumber(p, x, y, layout.cols, layout.rows), cx, cy));
      }

      if (p.enableCenterDots) {
        cutters.push(
          translate(cylinder(1, p.numberDepth + seamOverlap), [cx, cy, p.sectionHeight / 2 - p.numberDepth]),
        );
      }
    }
  }

  return cut(rackPlateBody(p), ...cutters);
}

/** One hole label: stroke-digit solids placed below the hole, sunk into the top face. */
function numberEngraving(p: Params, label: number, holeX: number, holeY: number): TopoDS_Shape[] {
  const text = String(label);
  // The original approximates each glyph as 4 mm wide when spacing labels.
  const numberWidth = text.length * 4 * p.numberScale;
  const labelY = holeY - p.holeDiameter / 2 - p.numberSpacing - numberWidth / 2;
  const labelZ = p.sectionHeight / 2 - p.numberDepth + p.numberVerticalOffset;
  return engravedText(text, { size: 8 * p.numberScale, depth: p.numberDepth + seamOverlap }).map((stroke) =>
    translate(rotateZ(stroke, p.numberRotation), [holeX, labelY, labelZ]),
  );
}

//--------------------------//
// Vertical Support
//--------------------------//

/** `vertical_support()` — socketed post with the slotted carry handle on top. */
function verticalSupport(p: Params, socketSide: number): TopoDS_Shape {
  const totalHeight = Math.max(p.rackHeight, p.numPlates * p.sectionHeight + p.dovetailStartHeight + p.sectionHeight);
  const dovetailCount = p.numPlates + 1;

  const sockets: TopoDS_Shape[] = [];
  for (let index = 0; index <= dovetailCount - 2; index += 1) {
    sockets.push(translate(depthDovetailSocket(p, socketSide), [0, 0, p.dovetailStartHeight + index * p.dovetailSpacing]));
  }

  const post = cut(boxAt([0, 0, totalHeight / 2], p.supportThickness, p.rackDepth, totalHeight), ...sockets);
  return fuse(post, handle(p, totalHeight));
}

/** The handle `hull()` with its rounded through-slot cut out. */
function handle(p: Params, baseZ: number): TopoDS_Shape {
  const handleWidth = p.supportThickness;
  const handleDepth = p.rackDepth;
  const r = p.cornerRadius;

  // hull(): straight side walls up to the corner-cylinder centers, a slab
  // bridging between the cylinders, quarter-round top corners.
  const body = fuse(
    boxAt([0, 0, baseZ + p.handleHeight / 2 - seamOverlap / 2], handleWidth, handleDepth, p.handleHeight + seamOverlap),
    boxAt([0, 0, baseZ + p.handleHeight + (r - seamOverlap) / 2], handleWidth, handleDepth - 2 * r, r + seamOverlap),
    xcylAt([0, handleDepth / 2 - r, baseZ + p.handleHeight], r, handleWidth),
    xcylAt([0, -(handleDepth / 2 - r), baseZ + p.handleHeight], r, handleWidth),
  );

  const slot = roundedSlotX(
    [0, 0, baseZ + p.handleHeight / 2],
    p.slotWidth,
    p.slotHeight,
    handleWidth + 2,
    p.slotCornerRadius,
  );
  return cut(body, slot);
}
