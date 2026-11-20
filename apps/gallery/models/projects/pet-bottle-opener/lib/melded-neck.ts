import type { Drawing } from 'replicad';
import { draw } from 'replicad';

export type PlanarPoint = [number, number];

export type MeldedNeckOptions = {
  /** Centers of the two modules in the sketch plane. */
  centerA: PlanarPoint;
  centerB: PlanarPoint;
  /** Circumradii of the module outlines. */
  radiusA: number;
  radiusB: number;
  /** Polygon side counts; use 64 or greater for a circular outline. */
  sidesA: number;
  sidesB: number;
  /** Narrowest full width of the waist. */
  width: number;
  /** Controls how broadly the waist flares into each module. */
  blend: number;
  /** Material carried inside each module for a reliable later fuse. */
  overlap?: number;
};

/**
 * Draws a symmetric, tangent-curved bridge between two round or faceted modules.
 *
 * Each flank uses two cubic curves: a broad shoulder leaves the first module,
 * narrows to the requested waist, then opens into the second module. Attachment
 * points are calculated against each outline's inscribed radius, so the bridge
 * stays inside faceted bodies instead of producing circular wedges between
 * polygon edges.
 *
 * Extrude this drawing to the module thickness, fuse it with both *unfinished*
 * module solids, and only then apply the shared exterior fillet or chamfer. That
 * construction order is what prevents visible seams and interrupted bevels.
 *
 * Returns `null` when the centers coincide, blending is disabled, or the
 * modules leave too little axial room for a curved waist.
 */
export const drawMeldedNeck = ({
  centerA,
  centerB,
  radiusA,
  radiusB,
  sidesA,
  sidesB,
  width,
  blend,
  overlap = 1.8,
}: MeldedNeckOptions): Drawing | null => {
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
  const inscribedRadius = (radius: number, sides: number): number => {
    return sides >= 3 && sides < 64 ? radius * Math.cos(Math.PI / sides) : radius;
  };
  const safeRadiusA = inscribedRadius(radiusA, sidesA);
  const safeRadiusB = inscribedRadius(radiusB, sidesB);
  const halfWidth = Math.min(width / 2, Math.min(safeRadiusA, safeRadiusB) * 0.65);
  const shoulderGrowth = Math.max(0, blend * 0.65);
  const shoulderA = Math.min(halfWidth + shoulderGrowth, safeRadiusA * 0.72);
  const shoulderB = Math.min(halfWidth + shoulderGrowth, safeRadiusB * 0.72);
  const insetA = Math.sqrt(Math.max(0, safeRadiusA * safeRadiusA - shoulderA * shoulderA)) - overlap;
  const insetB = Math.sqrt(Math.max(0, safeRadiusB * safeRadiusB - shoulderB * shoulderB)) - overlap;
  const startT = Math.max(insetA, 0);
  const endT = length - Math.max(insetB, 0);
  const curveLength = endT - startT;

  if (curveLength <= 1) {
    return null;
  }

  const toWorld = (normalOffset: number, axialOffset: number): PlanarPoint => {
    return [centerA[0] + nx * normalOffset + ux * axialOffset, centerA[1] + ny * normalOffset + uy * axialOffset];
  };
  const offsetPoint = (
    point: PlanarPoint,
    normalDirection: number,
    axialDirection: number,
    distance: number,
  ): PlanarPoint => {
    const directionLength = Math.hypot(normalDirection, axialDirection);

    return [
      point[0] + ((nx * normalDirection + ux * axialDirection) / directionLength) * distance,
      point[1] + ((ny * normalDirection + uy * axialDirection) / directionLength) * distance,
    ];
  };
  const mirror = (point: PlanarPoint): PlanarPoint => {
    const dx = point[0] - centerA[0];
    const dy = point[1] - centerA[1];
    const normalOffset = dx * nx + dy * ny;

    return [point[0] - 2 * nx * normalOffset, point[1] - 2 * ny * normalOffset];
  };

  const midT = (startT + endT) / 2;
  const rightA = toWorld(shoulderA, startT);
  const rightMid = toWorld(halfWidth, midT);
  const rightB = toWorld(shoulderB, endT);
  const endRadial = length - endT;
  const endHandle = Math.min(curveLength * 0.22, blend + 2);
  const midHandle = Math.min(curveLength * 0.2, Math.max(blend * 0.8, 1));

  const firstControlA = offsetPoint(rightA, -startT, shoulderA, endHandle);
  const firstControlMid = offsetPoint(rightMid, 0, -1, midHandle);
  const secondControlMid = offsetPoint(rightMid, 0, 1, midHandle);
  const secondControlB = offsetPoint(rightB, -endRadial, -shoulderB, endHandle);

  return draw(rightA)
    .cubicBezierCurveTo(rightMid, firstControlA, firstControlMid)
    .cubicBezierCurveTo(rightB, secondControlMid, secondControlB)
    .lineTo(mirror(rightB))
    .cubicBezierCurveTo(mirror(rightMid), mirror(secondControlB), mirror(secondControlMid))
    .cubicBezierCurveTo(mirror(rightA), mirror(firstControlMid), mirror(firstControlA))
    .close();
};
