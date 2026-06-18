/**
 * Modular PET Bottle Opener — chamfered, cap-size-driven version
 *
 * Reproduces the finished look of the "PET Bottle Opener 2nd (New Standard)"
 * STEP reference (Thingiverse thing:4570640):
 *  - 16-sided faceted rim with chamfered top & bottom outer edges
 *  - a recessed band of 60 angled fins: 20 long "contact" fins that grip the
 *    cap and 40 short "support" fins set back behind them
 *  - a smooth, chamfered bore above the fin band
 *  - ONE knob (capDiameter) sizes the whole head; the fin setback offset and
 *    sweep angle stay constant, so any cap size keeps the same grip geometry
 *  - an optional lower module: a finger / hang hole, or a second opener head
 *    that is either the SAME size or a SMALLER size than the main head
 *
 * Dimensions were measured from PetBottle_Opener_2_thick_release.step:
 *   cap radius 14.75, support radius 15.45 (0.7 mm setback), fin-root ring 25.0,
 *   smooth bore 23.5, outer rim = 16 facets, fin band 8 mm, body 22 mm (thick).
 *
 * Built as 2D profiles fused with boolean operations, extruded, then finished
 * with selective chamfers (the same edge-finder technique as the helical-gear
 * example).
 */
import type { Drawing, EdgeFinder, Shape3D } from 'replicad';
import { draw, drawCircle, drawPolysides } from 'replicad';

// Parameters are grouped so the playground renders them as labelled,
// collapsible sections (nested objects become sections in the UI). The exported
// `jsonSchema` below turns the string fields into dropdowns and adds ranges.
export const defaultParams = {
  // --- Body ---
  body: {
    thickness: 22, // 22 = thick release, 10 = thin release
    outerSides: 16, // 16 = faceted rim (like the STEP); 64 = round rim
  },

  // --- Cap & head: capDiameter sizes the head; the rest are radial deltas ---
  head: {
    capDiameter: 29.5, // PET cap knurl Ø to grip. Everything tracks this.
    finBandDepth: 10.25, // Cap face -> fin-root ring        (25.0 - 14.75)
    wallThickness: 3, //   Fin-root ring -> outer rim corner (28.0 - 25.0)
    boreClearance: 1.5, // Fin-root ring -> smooth bore      (25.0 - 23.5)
  },

  // --- Fin band: kept constant across cap sizes (the "offset and angle") ---
  fins: {
    finHeight: 8, // Working height of the fin band (mm)
    finCount: 60, // 6° tooth pitch on the main head
    contactEvery: 3, // 1 long contact fin, then 2 short support fins
    supportSetback: 0.7, // THE OFFSET: how far support fins stop short of the cap
    rootOffsetDeg: -7.36, // THE ANGLE: root sweep from the inner tip (cw)
    phaseDeg: 1.67, // Overall tooth phase
    supportPhaseOffsetDeg: -1.03, // Extra phase nudge on support fins
    innerWidth: 0.86, // Contact fin tip width (mm)
    outerWidth: 1.8, // Contact fin root width (mm)
    supportInnerWidth: 0.855, // Support fin tip width (mm)
    supportOuterWidth: 1.8, // Support fin root width (mm)
  },

  // --- Chamfers: the source's finished look. Set any to 0 for sharp edges. ---
  chamfers: {
    rim: 1.6, // Top & bottom bevel on the outer rim (the "nut" look)
    bore: 0.6, // Bevel on the top smooth-bore edge
    finTip: 0, // Optional break on the fin tips (slow on 60 fins; off by default)
  },

  // --- Lower module: none, a finger/hang hole, or a second opener head ---
  lower: {
    module: 'none', // 'none' | 'handle' | 'opener'
    openerSize: 'smaller', // When 'opener': 'same' as the main head, or 'smaller'
    secondCapDiameter: 19, // Cap Ø for the lower head when openerSize = 'smaller'
    centerDistance: 63, // Min distance between module centers; auto-grown for a clean blend
    neckWidth: 16, // Width of the bridge between modules (mm)
    handleHoleDiameter: 25, // Finger / hang hole Ø (module = 'handle')
    handleOuterRadius: 17.5, // Outer radius of the handle disc (module = 'handle')
  },
};

type Params = typeof defaultParams;
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K];
};
type HeadProportions = {
  finBandDepth: number;
  wallThickness: number;
  boreClearance: number;
};
type Point = [number, number];

// Small overlap between fin roots and the outer rim for reliable 2D fusing.
const ROOT_OVERLAP = 0.35;
// Overlap between the neck and each round module so they merge cleanly.
const NECK_OVERLAP = 1.8;
// Default clear gap between two module rims. The lower module is spaced at least
// this far from the main head so the rims never overlap AND there is room for
// the neck to blend smoothly into both bodies (a melded waist, not a thin slab
// crashing into a knife-edge junction). A larger user spacing is honored.
const NECK_BLEND_GAP = 12;
const DEG = Math.PI / 180;

/** Resolved radii for one opener head, all derived from its cap diameter. */
type HeadGeometry = {
  capDiameter: number;
  finOuterRadius: number;
  outerRadius: number;
  smoothBoreRadius: number;
  finCount: number;
};

/** The fin-band parameters shared by every head (kept constant by size). */
type FinSpec = {
  contactEvery: number;
  supportSetback: number;
  finInnerWidth: number;
  finOuterWidth: number;
  supportFinInnerWidth: number;
  supportFinOuterWidth: number;
  finRootOffsetDeg: number;
  finPhaseDeg: number;
  supportPhaseOffsetDeg: number;
};

/** Chamfer sizes (mm). Any can be 0 to leave that edge sharp. */
type ChamferSpec = {
  rimChamfer: number;
  boreChamfer: number;
  finTipChamfer: number;
};

// --- Parameter UI schema -----------------------------------------------------
// When a model exports `jsonSchema`, the kernel renders the parameter panel from
// it instead of inferring one from the values. We build the schema from
// `defaultParams` (so every field is covered automatically) and layer on the
// things inference can't express: dropdowns (enums), friendly titles, and
// numeric ranges. Nested groups become collapsible sections in the panel.
const GROUP_TITLES: Record<string, string> = {
  body: 'Body',
  head: 'Cap & head',
  fins: 'Fin band',
  chamfers: 'Chamfers',
  lower: 'Lower module',
};

const ENUM_OPTIONS: Record<string, string[]> = {
  module: ['none', 'handle', 'opener'],
  openerSize: ['smaller', 'same'],
};

type FieldMeta = {
  title?: string;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
};

const FIELD_META: Record<string, FieldMeta> = {
  thickness: { title: 'Thickness (mm)', min: 2, max: 60, step: 0.5 },
  outerSides: {
    title: 'Rim facets',
    description: '16 = faceted (like the source), 64 = round',
    min: 3,
    max: 64,
    step: 1,
  },
  capDiameter: { title: 'Cap diameter (mm)', min: 10, max: 60, step: 0.5 },
  finBandDepth: { title: 'Fin band depth (mm)', min: 3, max: 25, step: 0.25 },
  wallThickness: { title: 'Wall thickness (mm)', min: 1, max: 12, step: 0.25 },
  boreClearance: { title: 'Bore clearance (mm)', min: 0.5, max: 6, step: 0.25 },
  finHeight: { title: 'Fin band height (mm)', min: 1, max: 30, step: 0.5 },
  finCount: { title: 'Fin count', min: 6, max: 120, step: 1 },
  contactEvery: { title: 'Contact every Nth fin', min: 1, max: 6, step: 1 },
  supportSetback: { title: 'Support setback (mm)', min: 0, max: 3, step: 0.05 },
  rootOffsetDeg: { title: 'Fin sweep angle (°)', min: -20, max: 20, step: 0.1 },
  phaseDeg: { title: 'Tooth phase (°)', min: -10, max: 10, step: 0.1 },
  supportPhaseOffsetDeg: {
    title: 'Support phase offset (°)',
    min: -10,
    max: 10,
    step: 0.1,
  },
  innerWidth: { title: 'Contact tip width (mm)', min: 0.2, max: 4, step: 0.05 },
  outerWidth: {
    title: 'Contact root width (mm)',
    min: 0.2,
    max: 4,
    step: 0.05,
  },
  supportInnerWidth: {
    title: 'Support tip width (mm)',
    min: 0.2,
    max: 4,
    step: 0.05,
  },
  supportOuterWidth: {
    title: 'Support root width (mm)',
    min: 0.2,
    max: 4,
    step: 0.05,
  },
  rim: { title: 'Rim chamfer (mm)', min: 0, max: 6, step: 0.1 },
  bore: { title: 'Bore chamfer (mm)', min: 0, max: 4, step: 0.1 },
  finTip: {
    title: 'Fin-tip chamfer (mm)',
    description: 'Best-effort; slow on 60 fins',
    min: 0,
    max: 1,
    step: 0.05,
  },
  module: {
    title: 'Lower module',
    description: 'None, a finger/hang hole, or a second opener',
  },
  openerSize: {
    title: 'Second opener size',
    description: 'Same cap as the main head, or smaller',
  },
  secondCapDiameter: {
    title: 'Second cap diameter (mm)',
    min: 10,
    max: 60,
    step: 0.5,
  },
  centerDistance: {
    title: 'Module spacing (mm)',
    description:
      'Minimum center-to-center distance; auto-increased so the heads never overlap and the neck blends in. Increase for a longer, smoother waist',
    min: 20,
    max: 120,
    step: 1,
  },
  neckWidth: { title: 'Neck width (mm)', min: 4, max: 40, step: 0.5 },
  handleHoleDiameter: {
    title: 'Handle hole Ø (mm)',
    min: 0,
    max: 50,
    step: 0.5,
  },
  handleOuterRadius: {
    title: 'Handle radius (mm)',
    min: 5,
    max: 40,
    step: 0.5,
  },
};

function titleCase(key: string): string {
  const spaced = key.replaceAll(/[A-Z]/gu, (match) => ` ${match}`);
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

type JsonSchemaNode = Record<string, unknown>;

function schemaForLeaf(key: string, value: unknown): JsonSchemaNode {
  const meta = FIELD_META[key] ?? {};
  const base: JsonSchemaNode = {
    title: meta.title ?? titleCase(key),
    default: value,
    ...(meta.description ? { description: meta.description } : {}),
  };

  if (typeof value === 'boolean') {
    return { ...base, type: 'boolean' };
  }

  if (typeof value === 'number') {
    return {
      ...base,
      type: 'number',
      ...(meta.min === undefined ? {} : { minimum: meta.min }),
      ...(meta.max === undefined ? {} : { maximum: meta.max }),
      ...(meta.step === undefined ? {} : { multipleOf: meta.step }),
    };
  }

  return {
    ...base,
    type: 'string',
    ...(ENUM_OPTIONS[key] ? { enum: ENUM_OPTIONS[key] } : {}),
  };
}

function buildSchemaProperties(group: Record<string, unknown>): Record<string, JsonSchemaNode> {
  const properties: Record<string, JsonSchemaNode> = {};

  for (const [key, value] of Object.entries(group)) {
    properties[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? {
            type: 'object',
            title: GROUP_TITLES[key] ?? titleCase(key),
            properties: buildSchemaProperties(value as Record<string, unknown>),
          }
        : schemaForLeaf(key, value);
  }

  return properties;
}

/**
 * Conditional schema for the lower module. Only `module` shows until a value is
 * chosen; RJSF resolves these `dependencies` against the current value so:
 *  - `none`   reveals nothing else,
 *  - `handle` reveals the hole/disc + bridge fields,
 *  - `opener` reveals the second-opener + bridge fields.
 * Hidden fields keep their defaults (the panel deep-merges defaults into the
 * form data), so the geometry is unaffected by what is shown.
 */
function buildLowerSchema(): JsonSchemaNode {
  const leaf = (key: keyof typeof defaultParams.lower): JsonSchemaNode => schemaForLeaf(key, defaultParams.lower[key]);

  const bridgeFields = {
    centerDistance: leaf('centerDistance'),
    neckWidth: leaf('neckWidth'),
  };

  return {
    type: 'object',
    title: 'Lower module',
    properties: {
      module: leaf('module'),
    },
    dependencies: {
      module: {
        oneOf: [
          { properties: { module: { enum: ['none'] } } },
          {
            properties: {
              module: { enum: ['handle'] },
              handleHoleDiameter: leaf('handleHoleDiameter'),
              handleOuterRadius: leaf('handleOuterRadius'),
              ...bridgeFields,
            },
          },
          {
            properties: {
              module: { enum: ['opener'] },
              openerSize: leaf('openerSize'),
              secondCapDiameter: leaf('secondCapDiameter'),
              ...bridgeFields,
            },
          },
        ],
      },
    },
  };
}

/**
 * Parameter panel schema: groups become collapsible sections, the string fields
 * become dropdowns, numbers get ranges, and the lower module gates its fields on
 * the chosen `module`. Consumed by the kernel's `getParameters`.
 *
 * @public
 */
export const jsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'PET Bottle Opener',
  type: 'object',
  properties: {
    ...buildSchemaProperties(defaultParams),
    lower: buildLowerSchema(),
  },
};

/** Point at `radius` and `angle` (radians) around a center. */
function polar(center: Point, radius: number, angle: number): Point {
  return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
}

/** Closed polygon from a list of 2D points. */
function polygon(points: Point[]): Drawing {
  const [first, ...rest] = points;

  if (!first) {
    throw new Error('polygon needs at least one point');
  }

  let pen = draw(first);

  for (const point of rest) {
    pen = pen.lineTo(point);
  }

  return pen.close();
}

/** Ring centered at the origin. Faceted when `sides` is between 3 and 63. */
function annulus(outerRadius: number, innerRadius: number, sides: number): Drawing {
  const outer = sides >= 3 && sides < 64 ? drawPolysides(outerRadius, sides) : drawCircle(outerRadius);

  return outer.cut(drawCircle(innerRadius));
}

/**
 * A single tapered fin/tooth whose root is angularly offset from its tip.
 *
 * `innerAngle` is the center angle at the cap side; `rootAngleOffset` sweeps
 * the root relative to the inner tip.
 */
function angledRadialFin(
  innerRadius: number,
  outerRadius: number,
  innerWidth: number,
  outerWidth: number,
  innerAngle: number,
  rootAngleOffset: number,
): Drawing {
  const center: Point = [0, 0];

  // Convert tangential widths in mm into angular half-widths.
  const innerHalf = innerWidth / 2 / Math.max(innerRadius, 0.01);
  const outerHalf = outerWidth / 2 / Math.max(outerRadius, 0.01);

  const finOuter = outerRadius + ROOT_OVERLAP;
  const outerAngle = innerAngle + rootAngleOffset;

  return polygon([
    polar(center, innerRadius, innerAngle - innerHalf),
    polar(center, finOuter, outerAngle - outerHalf),
    polar(center, finOuter, outerAngle + outerHalf),
    polar(center, innerRadius, innerAngle + innerHalf),
  ]);
}

/** Derive every head radius from a cap diameter, keeping band/wall constant. */
function deriveHead(capDiameter: number, proportions: HeadProportions, finCount: number): HeadGeometry {
  const capRadius = capDiameter / 2;
  const finOuterRadius = capRadius + proportions.finBandDepth;

  return {
    capDiameter,
    finOuterRadius,
    outerRadius: finOuterRadius + proportions.wallThickness,
    // Bore sits just inside the fin-root ring; never let it pinch the cap.
    smoothBoreRadius: Math.max(finOuterRadius - proportions.boreClearance, capRadius + 0.5),
    finCount,
  };
}

/** Builds one opener head as a 2D drawing (fin band only) at the origin. */
function buildFinBand(geom: HeadGeometry, fin: FinSpec, outerSides: number): Drawing {
  const capRadius = geom.capDiameter / 2;
  const ringInner = geom.finOuterRadius - ROOT_OVERLAP;

  const contactEvery = Math.max(1, Math.round(fin.contactEvery));
  const supportSetback = Math.max(0, fin.supportSetback);

  const finRootOffset = fin.finRootOffsetDeg * DEG;
  const finPhase = fin.finPhaseDeg * DEG;
  const supportPhaseOffset = fin.supportPhaseOffsetDeg * DEG;

  if (capRadius <= 0) {
    throw new Error('capDiameter must be positive');
  }

  if (geom.finOuterRadius <= capRadius) {
    throw new Error('finBandDepth must be positive');
  }

  if (geom.outerRadius <= geom.finOuterRadius) {
    throw new Error('wallThickness must be positive');
  }

  if (geom.finCount < 3) {
    throw new Error('finCount must be at least 3');
  }

  if (contactEvery > 1 && capRadius + supportSetback >= geom.finOuterRadius - 0.25) {
    throw new Error('supportSetback is too large; support fins would not reach the rim cleanly');
  }

  let shape = annulus(geom.outerRadius, ringInner, outerSides);

  for (let i = 0; i < geom.finCount; i++) {
    const isContact = contactEvery <= 1 || i % contactEvery === 0;

    const finInnerRadius = isContact ? capRadius : capRadius + supportSetback;
    const innerWidth = isContact ? fin.finInnerWidth : fin.supportFinInnerWidth;
    const outerWidth = isContact ? fin.finOuterWidth : fin.supportFinOuterWidth;
    const phaseOffset = isContact ? 0 : supportPhaseOffset;
    const innerAngle = finPhase + phaseOffset + (i * 2 * Math.PI) / geom.finCount;

    shape = shape.fuse(
      angledRadialFin(finInnerRadius, geom.finOuterRadius, innerWidth, outerWidth, innerAngle, finRootOffset),
    );
  }

  return shape;
}

function extrudeDrawing(drawing: Drawing, height: number, z = 0): Shape3D {
  const solid = drawing.sketchOnPlane().extrude(height);

  return z === 0 ? solid : solid.translate(0, 0, z);
}

/** Recessed fin band (lower) fused with a smooth bore ring (upper). */
function buildLayeredHead(
  geom: HeadGeometry,
  fin: FinSpec,
  outerSides: number,
  thickness: number,
  finHeight: number,
): Shape3D {
  const band = Math.min(Math.max(finHeight, 0.1), thickness);
  const upperHeight = Math.max(thickness - band, 0);

  let solid = extrudeDrawing(buildFinBand(geom, fin, outerSides), band);

  if (upperHeight > 0) {
    if (geom.smoothBoreRadius <= 0 || geom.smoothBoreRadius >= geom.outerRadius) {
      throw new Error('smoothBoreRadius must be between 0 and outerRadius');
    }

    solid = solid.fuse(extrudeDrawing(annulus(geom.outerRadius, geom.smoothBoreRadius, outerSides), upperHeight, band));
  }

  return solid;
}

/**
 * Chamfer that degrades gracefully: if OCCT cannot build the chamfer (e.g. the
 * radius is too large for an edge, or the 60 thin fin tips defeat the filleter)
 * the edge is left sharp instead of failing the whole model. The geometry is
 * never mutated in place — `chamfer` returns a new solid — so on failure we
 * just return the input untouched.
 */
function safeChamfer(solid: Shape3D, size: number, finder: (edge: EdgeFinder) => EdgeFinder): Shape3D {
  if (size <= 0) {
    return solid;
  }

  try {
    return solid.chamfer(size, finder);
  } catch {
    return solid;
  }
}

/** Applies the rim / bore / fin-tip chamfers to a head solid at the origin. */
function finishHead(
  solid: Shape3D,
  geom: HeadGeometry,
  outerSides: number,
  thickness: number,
  finHeight: number,
  chamfer: ChamferSpec,
): Shape3D {
  let result = solid;

  // Flat-to-flat radius of the rim; midpoints of rim edges sit here. Pull the
  // threshold a little inside it so every rim edge is caught but the bore and
  // fins (well inside) are excluded.
  const facetRadius =
    outerSides >= 3 && outerSides < 64 ? geom.outerRadius * Math.cos(Math.PI / outerSides) : geom.outerRadius;
  const rimThreshold = facetRadius - Math.max(chamfer.rimChamfer, 0.5) - 0.1;

  // Top & bottom outer-rim bevel — the signature "nut" chamfer.
  for (const z of [0, thickness]) {
    result = safeChamfer(result, chamfer.rimChamfer, (edge) =>
      edge.inPlane('XY', z).when(({ element }) => {
        const mid = element.pointAt(0.5);
        return Math.hypot(mid.x, mid.y) >= rimThreshold;
      }),
    );
  }

  // Top smooth-bore edge bevel (the circular opening on the top face).
  result = safeChamfer(result, chamfer.boreChamfer, (edge) =>
    edge
      .inPlane('XY', thickness)
      .ofCurveType('CIRCLE')
      .when(({ element }) => {
        const mid = element.pointAt(0.5);
        return Math.abs(Math.hypot(mid.x, mid.y) - geom.smoothBoreRadius) < 1;
      }),
  );

  // Optional break on the fin tips, which live in the lower band (z = 0 and the
  // top of the fin band). Chamfering 60 thin teeth often defeats OCCT, so this
  // is off by default and best-effort via safeChamfer.
  const capRadius = geom.capDiameter / 2;
  const tipOuter = capRadius + Math.max(0, geom.finOuterRadius - capRadius) * 0.25;
  for (const z of [0, Math.min(finHeight, thickness)]) {
    result = safeChamfer(result, chamfer.finTipChamfer, (edge) =>
      edge.inPlane('XY', z).when(({ element }) => {
        const mid = element.pointAt(0.5);
        return Math.hypot(mid.x, mid.y) <= tipOuter;
      }),
    );
  }

  return result;
}

/** A round handle disc with a finger / hang hole, chamfered to match the head. */
function buildHandleSolid(outerRadius: number, holeRadius: number, thickness: number, chamfer: ChamferSpec): Shape3D {
  let solid = extrudeDrawing(drawCircle(outerRadius), thickness);

  if (holeRadius > 0) {
    solid = solid.cut(extrudeDrawing(drawCircle(holeRadius), thickness));
  }

  // Outer rim chamfer (round edge -> cone, like the head rim).
  for (const z of [0, thickness]) {
    solid = safeChamfer(solid, chamfer.rimChamfer, (edge) =>
      edge.inPlane('XY', z).when(({ element }) => {
        const mid = element.pointAt(0.5);
        return Math.hypot(mid.x, mid.y) >= outerRadius - chamfer.rimChamfer - 0.1;
      }),
    );
  }

  // Hole edge chamfer (top & bottom).
  if (holeRadius > 0) {
    for (const z of [0, thickness]) {
      solid = safeChamfer(solid, chamfer.boreChamfer, (edge) =>
        edge
          .inPlane('XY', z)
          .ofCurveType('CIRCLE')
          .when(({ element }) => {
            const mid = element.pointAt(0.5);
            return Math.abs(Math.hypot(mid.x, mid.y) - holeRadius) < 1;
          }),
      );
    }
  }

  return solid;
}

/**
 * Rectangular neck that overlaps the two modules but stops short of their
 * centers so it never fills a cap opening. Returns null when the modules
 * already overlap enough that no neck is needed.
 */
function buildBridge(centerA: Point, centerB: Point, radiusA: number, radiusB: number, width: number): Drawing | null {
  const vx = centerB[0] - centerA[0];
  const vy = centerB[1] - centerA[1];
  const length = Math.hypot(vx, vy);

  if (length < 1e-6) {
    return null;
  }

  const ux = vx / length;
  const uy = vy / length;
  const nx = -uy;
  const ny = ux;

  const startDist = Math.max(radiusA - NECK_OVERLAP, 0);
  const endDist = Math.max(radiusB - NECK_OVERLAP, 0);

  const sx = centerA[0] + ux * startDist;
  const sy = centerA[1] + uy * startDist;
  const ex = centerB[0] - ux * endDist;
  const ey = centerB[1] - uy * endDist;

  // Modules overlap enough that no neck is needed.
  if ((ex - sx) * ux + (ey - sy) * uy <= 0) {
    return null;
  }

  const hw = width / 2;

  return polygon([
    [sx + nx * hw, sy + ny * hw],
    [ex + nx * hw, ey + ny * hw],
    [ex - nx * hw, ey - ny * hw],
    [sx - nx * hw, sy - ny * hw],
  ]);
}

/**
 * A neck that *melds* into both modules instead of butting against them.
 *
 * The two body outlines and a straight neck are fused into a figure-8 whose
 * only outline corners are the four concave rim junctions; filleting those
 * rounds the neck so it flows tangentially into each rim (the smooth waist of
 * the "New Standard" reference). We then keep only the material OUTSIDE the two
 * bodies — so head bores stay open — plus a small overlap into each rim for a
 * clean 3D fuse.
 *
 * Returns null when the blend can't be built (callers fall back to a plain
 * rectangular neck), so a tricky parameter set degrades instead of failing.
 */
function buildMeldNeck(
  centerA: Point,
  centerB: Point,
  radiusA: number,
  radiusB: number,
  width: number,
  blend: number,
): Drawing | null {
  const vx = centerB[0] - centerA[0];
  const vy = centerB[1] - centerA[1];
  const length = Math.hypot(vx, vy);

  if (length < 1e-6 || blend <= 0) {
    return null;
  }

  const ux = vx / length;
  const uy = vy / length;
  const nx = -uy;
  const ny = ux;
  // Keep the neck narrower than the smaller body so the rect ends stay inside
  // both discs and the only outline corners are the four rim junctions.
  const hw = Math.min(width / 2, Math.min(radiusA, radiusB) * 0.8);

  const discA = drawCircle(radiusA).translate(centerA[0], centerA[1]);
  const discB = drawCircle(radiusB).translate(centerB[0], centerB[1]);

  // Full-span neck (center to center) fused with both discs, then the concave
  // junction corners rounded. Both ops can fail in OCCT for extreme inputs.
  let blended: Drawing;

  try {
    const rectFull = polygon([
      [centerA[0] + nx * hw, centerA[1] + ny * hw],
      [centerB[0] + nx * hw, centerB[1] + ny * hw],
      [centerB[0] - nx * hw, centerB[1] - ny * hw],
      [centerA[0] - nx * hw, centerA[1] - ny * hw],
    ]);

    blended = discA.fuse(rectFull).fuse(discB).fillet(blend);
  } catch {
    return null;
  }

  try {
    // Discard the body interiors (keep the blend wedges + inter-body neck), then
    // add a short overlap strip into each rim for a watertight 3D fuse.
    const startDist = Math.max(radiusA - NECK_OVERLAP, 0);
    const endDist = Math.max(radiusB - NECK_OVERLAP, 0);
    const sx = centerA[0] + ux * startDist;
    const sy = centerA[1] + uy * startDist;
    const ex = centerB[0] - ux * endDist;
    const ey = centerB[1] - uy * endDist;
    const overlap = polygon([
      [sx + nx * hw, sy + ny * hw],
      [ex + nx * hw, ey + ny * hw],
      [ex - nx * hw, ey - ny * hw],
      [sx - nx * hw, sy - ny * hw],
    ]);

    return blended.cut(discA).cut(discB).fuse(overlap);
  } catch {
    return null;
  }
}

export default function main(params: DeepPartial<Params> = {}): Shape3D {
  // Deep-merge each group over the defaults so a partial (or empty) parameter
  // object can never leave a field undefined — an undefined dimension becomes
  // NaN and OCCT throws Standard_OutOfRange. The playground already deep-merges
  // with defaults; this keeps direct/programmatic and partial calls safe too.
  const body = { ...defaultParams.body, ...params.body };
  const head = { ...defaultParams.head, ...params.head };
  const fins = { ...defaultParams.fins, ...params.fins };
  const chamferParams = { ...defaultParams.chamfers, ...params.chamfers };
  const lower = { ...defaultParams.lower, ...params.lower };

  const proportions: HeadProportions = {
    finBandDepth: head.finBandDepth,
    wallThickness: head.wallThickness,
    boreClearance: head.boreClearance,
  };

  const fin: FinSpec = {
    contactEvery: fins.contactEvery,
    supportSetback: fins.supportSetback,
    finInnerWidth: fins.innerWidth,
    finOuterWidth: fins.outerWidth,
    supportFinInnerWidth: fins.supportInnerWidth,
    supportFinOuterWidth: fins.supportOuterWidth,
    finRootOffsetDeg: fins.rootOffsetDeg,
    finPhaseDeg: fins.phaseDeg,
    supportPhaseOffsetDeg: fins.supportPhaseOffsetDeg,
  };

  const chamfer: ChamferSpec = {
    rimChamfer: chamferParams.rim,
    boreChamfer: chamferParams.bore,
    finTipChamfer: chamferParams.finTip,
  };

  const finHeight = Math.min(Math.max(fins.finHeight, 0.1), body.thickness);

  const topCenter: Point = [0, 0];

  // --- Main (top) head -----------------------------------------------------
  const topGeom = deriveHead(head.capDiameter, proportions, fins.finCount);
  let solid = finishHead(
    buildLayeredHead(topGeom, fin, body.outerSides, body.thickness, finHeight),
    topGeom,
    body.outerSides,
    body.thickness,
    finHeight,
    chamfer,
  );

  // --- Lower module --------------------------------------------------------
  const mode = lower.module === 'opener' || lower.module === 'handle' ? lower.module : 'none';

  if (mode !== 'none') {
    // Build the lower module at the origin; we place it once we know how far
    // the two centers must sit apart to keep the rims from overlapping.
    let lowerAtOrigin: Shape3D;
    let lowerOuterRadius: number;

    if (mode === 'opener') {
      // The second head reuses every shared fin parameter; only its cap size
      // changes. Its fin count is derived to keep the tooth pitch constant.
      const sameSize = lower.openerSize !== 'smaller';
      const secondCapDiameter = sameSize ? head.capDiameter : lower.secondCapDiameter;

      const mainLinearPitch = (2 * Math.PI * topGeom.finOuterRadius) / topGeom.finCount;
      const secondFinOuterRadius = secondCapDiameter / 2 + proportions.finBandDepth;
      const rawCount = Math.round((2 * Math.PI * secondFinOuterRadius) / mainLinearPitch);
      const grouped = Math.max(1, Math.round(rawCount / fin.contactEvery)) * fin.contactEvery;
      const secondFinCount = Math.max(fin.contactEvery * 4, grouped);

      const secondGeom = deriveHead(secondCapDiameter, proportions, secondFinCount);
      lowerOuterRadius = secondGeom.outerRadius;

      lowerAtOrigin = finishHead(
        buildLayeredHead(secondGeom, fin, body.outerSides, body.thickness, finHeight),
        secondGeom,
        body.outerSides,
        body.thickness,
        finHeight,
        chamfer,
      );
    } else {
      lowerOuterRadius = lower.handleOuterRadius;
      lowerAtOrigin = buildHandleSolid(lower.handleOuterRadius, lower.handleHoleDiameter / 2, body.thickness, chamfer);
    }

    // Space the lower center so the rims clear each other with room for the
    // neck to blend in, honoring a larger user-set distance. This is what stops
    // the two heads overlapping (same-size or smaller).
    const rimA = topGeom.outerRadius;
    const rimB = lowerOuterRadius;
    const minCenterDistance = rimA + rimB + NECK_BLEND_GAP;
    const centerDistance = Math.max(lower.centerDistance, minCenterDistance);
    const lowerCenter: Point = [0, -centerDistance];

    const lowerSolid = lowerAtOrigin.translate(lowerCenter[0], lowerCenter[1], 0);

    // Size the blend to the room available: the neck's straight edges run from
    // each rim crossing inward, so each junction fillet can grow to about half
    // that straight run (capped to a fraction of the smaller rim). A bigger
    // user spacing therefore yields a more generous, smoother waist.
    const hw = Math.min(lower.neckWidth / 2, Math.min(rimA, rimB) * 0.8);
    const straight =
      centerDistance - Math.sqrt(Math.max(0, rimA * rimA - hw * hw)) - Math.sqrt(Math.max(0, rimB * rimB - hw * hw));
    const blendRadius = Math.min(Math.max(straight / 2 - 1, 0), Math.min(rimA, rimB) * 0.45);

    // Prefer the melded neck; fall back to a plain rectangular bridge if the
    // blend can't be built for this parameter set.
    const neck =
      (blendRadius > 0.5 && buildMeldNeck(topCenter, lowerCenter, rimA, rimB, lower.neckWidth, blendRadius)) ||
      buildBridge(topCenter, lowerCenter, rimA, rimB, lower.neckWidth);

    if (neck) {
      solid = solid.fuse(extrudeDrawing(neck, body.thickness));
    }

    solid = solid.fuse(lowerSolid);

    // Carry the rim chamfer across the melded neck so the whole figure-8 has a
    // continuous top & bottom bevel, matching the heads (the source's finished
    // look). The neck flank is the ONLY material that sits outside both rim
    // circles, so that test isolates its top/bottom edges without touching the
    // already-chamfered head rims, bores, or fins. Best-effort via safeChamfer.
    const neckEdgeMargin = 0.1;
    for (const z of [0, body.thickness]) {
      solid = safeChamfer(solid, chamfer.rimChamfer, (edge) =>
        edge.inPlane('XY', z).when(({ element }) => {
          const mid = element.pointAt(0.5);
          const toA = Math.hypot(mid.x - topCenter[0], mid.y - topCenter[1]);
          const toB = Math.hypot(mid.x - lowerCenter[0], mid.y - lowerCenter[1]);
          return toA > rimA + neckEdgeMargin && toB > rimB + neckEdgeMargin;
        }),
      );
    }
  }

  return solid;
}
