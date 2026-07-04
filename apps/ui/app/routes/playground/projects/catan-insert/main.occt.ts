/**
 * Catan Box Insert — OpenCASCADE port of `main.scad`.
 *
 * A faithful BRep translation of the OpenSCAD original: the same well
 * layout, solid floors, top walls, and finger holes, built directly against
 * the OCCT API. One deliberate deviation: the original hollows leftover bulk
 * with `projection(cut=true) → offset(-wallthick) → linear_extrude`, which
 * has no robust BRep one-liner; this port constructs the identical hollow
 * volume explicitly (inset outline minus expanded well outlines), skipping
 * only the 2 mm corner rounding that OpenSCAD's `offset(r)` applies.
 */
import type { TopoDS_Shape } from 'opencascade.js';
import {
  boxAt,
  capsule,
  cut,
  fuse,
  intersect,
  regularPrism,
  rotateZ,
  stadiumWall,
  translate,
} from './lib/occt-utils.js';
import type { Vec3 } from './lib/occt-utils.js';

export const defaultParams = {
  wallThickness: 2,
  floorThickness: 1,
  joineryTabThickness: 2,
  hexDiameter: 93,
  hexWellDepth: 50,
  playerTokenWidth: 85,
  playerTokenLength: 104,
  playerTokenWellDepth: 15,
  cardWidth: 56,
  cardLength: 81,
  cardWellDepth: 35,
  borderWidth: 70.5,
  borderLength: 250,
  borderWellDepth: 25,
  insertWidth: 230,
  insertLength: 285,
  insertHeight: 75,
};

type Params = typeof defaultParams;

const cosDeg = (degrees: number): number => Math.cos((degrees * Math.PI) / 180);
const sinDeg = (degrees: number): number => Math.sin((degrees * Math.PI) / 180);

export default function main(params: Params = defaultParams): TopoDS_Shape {
  const p = { ...defaultParams, ...params };
  return boxInsert(p);
}

type Layout = {
  hexA: readonly [number, number];
  hexB: readonly [number, number];
  playerTokens: readonly [number, number];
  border: readonly [number, number];
  cards: readonly [number, number];
  seafarersHex: readonly [number, number];
};

/** Well centers, matching the translate() arithmetic of the OpenSCAD modules. */
function layoutOf(p: Params): Layout {
  const wall = p.wallThickness;
  const hex = p.hexDiameter;
  // A pointy-side inset: hexes sit closer to the edge by the sagitta of the hex flat.
  const hexInset = hex / 2 - cosDeg(30) * (hex / 2);
  return {
    hexA: [-p.insertWidth / 2 + wall + hex / 2, -p.insertLength / 2 + wall + hex / 2 - hexInset],
    hexB: [-p.insertWidth / 2 + wall + hex / 2, -p.insertLength / 2 + wall * 2 + hex * 1.5 - 3 * hexInset],
    playerTokens: [
      -p.insertWidth / 2 + wall + p.playerTokenWidth / 2,
      p.insertLength / 2 - wall - p.playerTokenLength / 2,
    ],
    border: [p.insertWidth / 2 - wall - p.borderWidth / 2, -p.insertLength / 2 + wall + p.borderLength / 2],
    cards: [
      p.insertWidth / 2 - wall * 2 - p.borderWidth - p.cardWidth / 2,
      -p.insertLength / 2 + wall + p.cardLength / 2 + p.joineryTabThickness + wall * 2,
    ],
    seafarersHex: [p.insertWidth / 2 - wall - p.borderWidth, 0],
  };
}

/** `boxinsertmain()` — outer block minus through-wells, plus solid well floors. */
function boxInsertMain(p: Params, layout: Layout): TopoDS_Shape {
  const height = p.insertHeight;
  const hexRadius = p.hexDiameter / 2;

  const block = boxAt([0, 0, height / 2], p.insertWidth, p.insertLength, height);
  const carved = cut(
    block,
    translate(regularPrism(hexRadius, height + 10, 6), [...layout.hexA, -5]),
    translate(regularPrism(hexRadius, height + 10, 6), [...layout.hexB, -5]),
    boxAt([...layout.playerTokens, height / 2], p.playerTokenWidth, p.playerTokenLength, height + 10),
    boxAt([...layout.border, height / 2], p.borderWidth, p.borderLength, height + 10),
    boxAt([...layout.cards, height / 2], p.cardWidth, p.cardLength, height + 10),
    translate(rotateZ(regularPrism(hexRadius, height + 10, 6), 90), [...layout.seafarersHex, -5]),
  );

  return fuse(
    carved,
    // Solid floors under each well (`hexstackinsert`, `playertokeninsert`, `cardsinsert`).
    translate(regularPrism((p.hexDiameter + 0.5) / 2, height - p.hexWellDepth, 6), [...layout.hexA, 0]),
    translate(regularPrism((p.hexDiameter + 0.5) / 2, height - p.hexWellDepth, 6), [...layout.hexB, 0]),
    boxAt(
      [...layout.playerTokens, (height - p.playerTokenWellDepth) / 2],
      p.playerTokenWidth + 0.5,
      p.playerTokenLength + 0.5,
      height - p.playerTokenWellDepth,
    ),
    boxAt(
      [...layout.cards, (height - p.cardWellDepth) / 2],
      p.cardWidth + 0.5,
      p.cardLength + 0.5,
      height - p.cardWellDepth,
    ),
    borderInsertFloor(p, layout),
  );
}

/** `borderinsert()` — partial hex floor for the seafarers tile plus the border floor. */
function borderInsertFloor(p: Params, layout: Layout): TopoDS_Shape {
  const tall = p.insertHeight - p.borderWellDepth;
  const centerYOffset = (p.insertLength - p.wallThickness * 2 - p.borderLength) / 2;
  const [borderX, borderY] = layout.border;

  const halfHexFloor = translate(
    intersect(
      rotateZ(regularPrism((p.hexDiameter + 0.5) / 2, tall, 6), 30),
      boxAt([-p.hexDiameter / 2, 0, tall / 2], p.hexDiameter, p.hexDiameter * 2, tall),
    ),
    [borderX - p.borderWidth / 2, borderY + centerYOffset, 0],
  );

  const hexEdgeWall = boxAt(
    [borderX - p.borderWidth / 2 - p.wallThickness / 2, borderY + centerYOffset, tall / 2],
    p.wallThickness,
    p.hexDiameter + 1,
    tall,
  );

  const borderFloor = boxAt([borderX, borderY, tall / 2], p.borderWidth + 0.5, p.borderLength + 0.5, tall);

  return fuse(halfHexFloor, hexEdgeWall, borderFloor);
}

/**
 * `boxinsertsub()` — hollows the leftover bulk of the block (2 mm skin,
 * 1 mm floor) and raises the two thin stadium walls that subdivide wells.
 *
 * The hollow tool is the block outline inset by one wall thickness, minus
 * every well outline expanded by one wall thickness — the explicit
 * construction of the original's `offset(-wallthick)` cross-section.
 */
function hollowTool(p: Params, layout: Layout): TopoDS_Shape {
  const wall = p.wallThickness;
  const height = p.insertHeight;
  const toolHeight = height + 10;
  const expandedHexRadius = (p.hexDiameter + wall * 2) / 2;

  return cut(
    boxAt([0, 0, p.floorThickness + toolHeight / 2], p.insertWidth - wall * 2, p.insertLength - wall * 2, toolHeight),
    translate(regularPrism(expandedHexRadius, toolHeight + 20, 6), [...layout.hexA, -5]),
    translate(regularPrism(expandedHexRadius, toolHeight + 20, 6), [...layout.hexB, -5]),
    boxAt(
      [...layout.playerTokens, height / 2],
      p.playerTokenWidth + wall * 2,
      p.playerTokenLength + wall * 2,
      toolHeight + 20,
    ),
    boxAt([...layout.border, height / 2], p.borderWidth + wall * 2, p.borderLength + wall * 2, toolHeight + 20),
    boxAt([...layout.cards, height / 2], p.cardWidth + wall * 2, p.cardLength + wall * 2, toolHeight + 20),
    translate(rotateZ(regularPrism(expandedHexRadius, toolHeight + 20, 6), 90), [...layout.seafarersHex, -5]),
  );
}

function boxInsertSub(p: Params, layout: Layout): TopoDS_Shape {
  const wall = p.wallThickness;
  const height = p.insertHeight;
  const hex = p.hexDiameter;

  const hexAY = layout.hexA[1];
  const hexBY = layout.hexB[1];

  const dividerWallA = stadiumWall(
    [
      [-p.insertWidth / 2 + wall * 1.5 + hex, hexAY, height],
      [p.insertWidth / 2 - wall * 2.5 - p.cardWidth - p.borderWidth, hexAY, height],
    ],
    wall / 2,
  );

  const dividerWallB = stadiumWall(
    [
      [
        -p.insertWidth / 2 + wall + hex / 2 + sinDeg(30) * (hex / 2 + wall / 2),
        hexBY + cosDeg(30) * (hex / 2 + wall / 2),
        height,
      ],
      [
        -p.insertWidth / 2 + wall * 1.5 + p.playerTokenWidth,
        p.insertLength / 2 - wall * 1.5 - p.playerTokenLength,
        height,
      ],
      [
        p.insertWidth / 2 - wall - p.borderWidth - cosDeg(30) * (hex / 2 + wall / 2),
        sinDeg(30) * (hex / 2 + wall / 2),
        height,
      ],
    ],
    wall / 2,
  );

  return fuse(cut(boxInsertMain(p, layout), hollowTool(p, layout)), dividerWallA, dividerWallB);
}

/** `fingerhole()` — hull of two stacked spheres: a vertical capsule. */
function fingerHole(at: Vec3, p: Params): TopoDS_Shape {
  return capsule(at, [at[0], at[1], at[2] + p.insertHeight], 20);
}

/** `boxinsert()` — the sub-assembly minus all finger holes. */
function boxInsert(p: Params): TopoDS_Shape {
  const layout = layoutOf(p);
  const wall = p.wallThickness;
  const height = p.insertHeight;
  const hex = p.hexDiameter;

  const hexFingerHoles = ([centerX, centerY]: readonly [number, number]): TopoDS_Shape[] => {
    const angle = 38;
    const radius = hex / 2 - 5;
    const z = height - p.hexWellDepth;
    return [
      fingerHole([centerX + cosDeg(angle) * radius, centerY + sinDeg(angle) * radius, z], p),
      fingerHole([centerX - cosDeg(angle) * radius, centerY - sinDeg(angle) * radius, z], p),
    ];
  };

  // Elongated scoop over the card well: the original hulls two finger holes
  // offset by [20, 0, 15]. The hull is reproduced from its boundary pieces —
  // both capsules, the lower connecting capsule (the visible scoop edge), and
  // a filler box for the interior (everything above the solid is cut anyway).
  const scoopStart: Vec3 = [
    p.insertWidth / 2 - wall * 1.5 - p.borderWidth,
    -p.insertLength / 2 + wall * 2 + p.joineryTabThickness + 12.5,
    height - p.cardWellDepth,
  ];
  const scoopEnd: Vec3 = [scoopStart[0] + 20, scoopStart[1], scoopStart[2] + 15];
  const scoop = fuse(
    fingerHole(scoopStart, p),
    fingerHole(scoopEnd, p),
    capsule(scoopStart, scoopEnd, 20),
    boxAt(
      [(scoopStart[0] + scoopEnd[0]) / 2, scoopStart[1], (scoopEnd[2] + scoopStart[2] + height) / 2],
      scoopEnd[0] - scoopStart[0],
      20,
      scoopStart[2] + height - scoopEnd[2],
    ),
  );

  return cut(
    boxInsertSub(p, layout),
    ...hexFingerHoles(layout.hexA),
    ...hexFingerHoles(layout.hexB),
    // Seafarers hex well finger hole.
    fingerHole([hex / 2 - cosDeg(45) * (hex / 2 - 2), -sinDeg(45) * (hex / 2 - 2), height - p.borderWellDepth], p),
    // Card well finger hole.
    fingerHole(
      [
        p.insertWidth / 2 - wall * 2.5 - p.borderWidth - p.cardWidth,
        -p.insertLength / 2 + wall * 2 + p.joineryTabThickness + p.cardLength - 10,
        height - p.cardWellDepth,
      ],
      p,
    ),
    scoop,
    // Player token well finger hole.
    fingerHole(
      [
        -p.insertWidth / 2 + wall + 12,
        p.insertLength / 2 - wall * 1.5 - p.playerTokenLength,
        height - p.playerTokenWellDepth * 2,
      ],
      p,
    ),
  );
}
