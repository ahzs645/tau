/**
 * Modular PET Bottle Opener
 *
 * A parametric, flat (extruded) PET bottle / cap opener with one or two
 * fin-style opener heads joined by a neck. The top head grips a bottle cap
 * with a ring of tapered radial fins; the lower module is either a plain
 * finger / hanging hole or a second smaller opener head.
 *
 * Ported from a PythonOCC (OpenCascade) design to Replicad. The whole part is
 * built as a single 2D profile using boolean operations on drawings, then
 * extruded to the desired thickness.
 */
import type { Drawing, Shape3D } from 'replicad';
import { draw, drawCircle, drawPolysides } from 'replicad';

export const defaultParams = {
  thickness: 10, // Overall plate thickness (mm)

  // --- Main (top) opener head ---
  capDiameter: 29.5, // Clear diameter at the fin tips (cap knurl diameter)
  finOuterRadius: 25, // Radius where the fins meet the outer rim
  outerRadius: 27.5, // Outside radius of the head
  finCount: 60, // Number of radial gripping fins
  finInnerWidth: 0.75, // Tangential fin width at the tip (mm)
  finOuterWidth: 1.35, // Tangential fin width at the root (mm)
  contactEvery: 1, // 1 = every fin touches the cap; N = every Nth fin
  supportSetback: 0, // How far non-contact fins stop short of the cap (mm)
  outerSides: 64, // 64 = round rim; use 8/10/12 for a faceted rim

  // --- Layout ---
  centerDistance: 45, // Distance between the two head centers (mm)
  neckWidth: 16, // Width of the bridge between modules (mm)

  // --- Lower module ---
  secondOpener: false, // false = finger/hang hole, true = second opener head
  handleHoleDiameter: 25, // Finger/hang hole diameter (when secondOpener = false)
  handleOuterRadius: 17.5, // Outside radius of the lower disc (hole mode)

  // --- Second opener head (used when secondOpener = true) ---
  secondCapDiameter: 19,
  secondFinOuterRadius: 16.5,
  secondOuterRadius: 18.5,
  secondFinCount: 36,
  secondFinInnerWidth: 0.55,
  secondFinOuterWidth: 1.05,

  // --- Finishing ---
  // Rounds every edge of the final solid. Leave at 0 for sharp CAD edges and
  // the fastest, most reliable render. Small values (~0.3) look nicer when
  // printed but filleting a 60-tooth ring can be slow or fail.
  edgeRound: 0,
};

// Small overlap between fin roots and the outer rim for reliable 2D fusing.
const ROOT_OVERLAP = 0.35;
// Overlap between the neck and each round module so they merge cleanly.
const NECK_OVERLAP = 1.8;

type OpenerHead = {
  capDiameter: number;
  finOuterRadius: number;
  outerRadius: number;
  finCount: number;
  finInnerWidth: number;
  finOuterWidth: number;
  contactEvery: number;
  supportSetback: number;
  outerSides: number;
};

/** Point at `radius` and `angle` (radians) around a center. */
function polar(
  center: [number, number],
  radius: number,
  angle: number,
): [number, number] {
  return [
    center[0] + radius * Math.cos(angle),
    center[1] + radius * Math.sin(angle),
  ];
}

/** Closed polygon from a list of 2D points. */
function polygon(points: Array<[number, number]>): Drawing {
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
  const outer =
    sides >= 3 && sides < 64
      ? drawPolysides(outerRadius, sides)
      : drawCircle(outerRadius);
  return outer.cut(drawCircle(innerRadius));
}

/** A single tapered radial fin/tooth pointing inward toward the center. */
function radialFin(
  innerRadius: number,
  outerRadius: number,
  innerWidth: number,
  outerWidth: number,
  angle: number,
): Drawing {
  const center: [number, number] = [0, 0];
  // Convert tangential widths (mm) into angular half-widths at each radius.
  const innerHalf = innerWidth / 2 / Math.max(innerRadius, 0.01);
  const outerHalf = outerWidth / 2 / Math.max(outerRadius, 0.01);
  const finOuter = outerRadius + ROOT_OVERLAP;

  return polygon([
    polar(center, innerRadius, angle - innerHalf),
    polar(center, finOuter, angle - outerHalf),
    polar(center, finOuter, angle + outerHalf),
    polar(center, innerRadius, angle + innerHalf),
  ]);
}

/** Builds one opener head as a 2D drawing centered at the origin. */
function buildOpenerHead(head: OpenerHead): Drawing {
  const capRadius = head.capDiameter / 2;
  const ringInner = head.finOuterRadius - ROOT_OVERLAP;

  if (capRadius <= 0) {
    throw new Error('capDiameter must be positive');
  }
  if (head.finOuterRadius <= capRadius) {
    throw new Error('finOuterRadius must be larger than capDiameter / 2');
  }
  if (head.outerRadius <= head.finOuterRadius) {
    throw new Error('outerRadius must be larger than finOuterRadius');
  }
  if (head.finCount < 3) {
    throw new Error('finCount must be at least 3');
  }

  let shape = annulus(head.outerRadius, ringInner, head.outerSides);

  for (let i = 0; i < head.finCount; i++) {
    const isContact = head.contactEvery <= 1 || i % head.contactEvery === 0;
    const finInnerRadius = isContact
      ? capRadius
      : capRadius + head.supportSetback;
    const angle = (i * 2 * Math.PI) / head.finCount;
    shape = shape.fuse(
      radialFin(
        finInnerRadius,
        head.finOuterRadius,
        head.finInnerWidth,
        head.finOuterWidth,
        angle,
      ),
    );
  }

  return shape;
}

/**
 * Rectangular neck that overlaps the two round modules but stops short of
 * their centers so it never fills a cap opening. Returns null when the modules
 * already overlap enough that no neck is needed.
 */
function buildBridge(
  centerA: [number, number],
  centerB: [number, number],
  radiusA: number,
  radiusB: number,
  width: number,
): Drawing | null {
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

export default function main(p = defaultParams): Shape3D {
  const topCenter: [number, number] = [0, 0];
  const lowerCenter: [number, number] = [0, -p.centerDistance];

  // Top opener head (built at the origin, which is already its center).
  let body = buildOpenerHead({
    capDiameter: p.capDiameter,
    finOuterRadius: p.finOuterRadius,
    outerRadius: p.outerRadius,
    finCount: p.finCount,
    finInnerWidth: p.finInnerWidth,
    finOuterWidth: p.finOuterWidth,
    contactEvery: p.contactEvery,
    supportSetback: p.supportSetback,
    outerSides: p.outerSides,
  });

  let lowerOuterRadius: number;
  let lower: Drawing;
  let handleHole: Drawing | null = null;

  if (p.secondOpener) {
    lowerOuterRadius = p.secondOuterRadius;
    lower = buildOpenerHead({
      capDiameter: p.secondCapDiameter,
      finOuterRadius: p.secondFinOuterRadius,
      outerRadius: p.secondOuterRadius,
      finCount: p.secondFinCount,
      finInnerWidth: p.secondFinInnerWidth,
      finOuterWidth: p.secondFinOuterWidth,
      contactEvery: 1,
      supportSetback: 0,
      outerSides: 64,
    }).translate(lowerCenter[0], lowerCenter[1]);
  } else {
    lowerOuterRadius = p.handleOuterRadius;
    lower = drawCircle(p.handleOuterRadius).translate(
      lowerCenter[0],
      lowerCenter[1],
    );
    handleHole = drawCircle(p.handleHoleDiameter / 2).translate(
      lowerCenter[0],
      lowerCenter[1],
    );
  }

  const bridge = buildBridge(
    topCenter,
    lowerCenter,
    p.outerRadius,
    lowerOuterRadius,
    p.neckWidth,
  );
  if (bridge) {
    body = body.fuse(bridge);
  }

  body = body.fuse(lower);
  if (handleHole) {
    body = body.cut(handleHole);
  }

  const solid = body.sketchOnPlane().extrude(p.thickness);

  if (p.edgeRound > 0) {
    return solid.fillet(p.edgeRound);
  }

  return solid;
}
