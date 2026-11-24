/** Slider-crank reconstructed from the pulley swing bar sketch. Lengths are millimetres. */
import type { TopoDS_Shape } from 'libcascade';
import { boxAt, cut, cylinder, fuse, regularPrism, rotateX, rotateZ, translate } from './lib/occt-utils.js';

export const defaultParams = {
  crankRadius: 20,
  crankAngle: 0,
  includeGuide: false,
  includeKeyway: false,
  pulleyDiameter: 80,
  pulleyThickness: 30,
  shaftDiameter: 15,
  rimClearance: 5,
  linkWidth: 15,
  linkThickness: 15,
  barWidth: 12,
  barThickness: 5,
  barLength: 100,
};

export const jsonSchema = {
  type: 'object',
  properties: {
    crankRadius: { type: 'number', title: 'Crank radius (mm)', description: 'The total slider travel is twice this distance.', default: 20, minimum: 12, maximum: 35 },
    crankAngle: { type: 'number', title: 'Crank angle (°)', description: '90° is the top of the stroke. 270° is the bottom.', default: 0, minimum: 0, maximum: 360 },
    includeGuide: { type: 'boolean', title: 'Include guide sleeve', default: false },
    includeKeyway: { type: 'boolean', title: 'Cut motor keyseat', description: '4.5 mm wide, 2.5 mm deep and 17 mm long, opening at the rear.', default: false },
    pulleyDiameter: { type: 'number', title: 'Pulley diameter (mm)', default: 80, minimum: 50, maximum: 90 },
    pulleyThickness: { type: 'number', title: 'Pulley thickness (mm)', default: 30, minimum: 18, maximum: 50 },
    shaftDiameter: { type: 'number', title: 'Shaft bore (mm)', default: 15, minimum: 6, maximum: 25 },
    rimClearance: { type: 'number', title: 'Minimum bar-to-rim gap (mm)', default: 5, minimum: 1, maximum: 20 },
    linkWidth: { type: 'number', title: 'Link width (mm)', default: 15, minimum: 8, maximum: 30 },
    linkThickness: { type: 'number', title: 'Link thickness (mm)', default: 15, minimum: 3, maximum: 30 },
    barWidth: { type: 'number', title: 'Steel bar width (mm)', default: 12, minimum: 8, maximum: 30 },
    barThickness: { type: 'number', title: 'Steel bar thickness (mm)', default: 5, minimum: 2, maximum: 15 },
    barLength: { type: 'number', title: 'Steel bar length (mm)', default: 100, minimum: 30, maximum: 250 },
  },
};

type Parameters = typeof defaultParams;
type Part = { name: string; color: string; shape: TopoDS_Shape };

// Assumed M5 hardware, a nominal motor shaft and a rigid two-pivot link.
const pinRadius = 2.75;
const nutRadius = 8.4 / Math.sqrt(3);
const pinInset = 8;
const axialGap = 0.6;
const guideHeight = 25;
const guideWall = 4;
const guidePlay = 0.5;

function pulley(p: Parameters) {
  const radius = p.pulleyDiameter / 2;
  const t = p.pulleyThickness;
  const tools = [
    cylinder(p.shaftDiameter / 2, t),
    translate(cylinder(pinRadius, t), [p.crankRadius, 0, 0]),
    translate(regularPrism(nutRadius, 4.3, 6), [p.crankRadius, 0, 0]),
    translate(rotateX(cylinder(2.1, radius + 1), -90), [0, 0, t / 2]),
  ];
  if (p.includeKeyway) {
    const radialDepth = p.shaftDiameter / 2 + 2.5;
    tools.push(boxAt([0, -radialDepth / 2, 8.5], 4.5, radialDepth, 17));
  }
  return rotateZ(cut(cylinder(radius, t), ...tools), p.crankAngle);
}

function connectingLink(p: Parameters, centres: number) {
  const t = p.linkThickness;
  const radius = p.linkWidth / 2;
  const body = fuse(
    boxAt([centres / 2, 0, t / 2], centres, p.linkWidth, t),
    cylinder(radius, t),
    translate(cylinder(radius, t), [centres, 0, 0]),
  );
  return cut(body, cylinder(pinRadius, t), translate(cylinder(pinRadius, t), [centres, 0, 0]));
}

function guideSleeve(p: Parameters, top: number) {
  const x = p.barWidth + 2 * guidePlay;
  const z = p.barThickness + 2 * guidePlay;
  const centre = [0, top - guideHeight / 2, p.pulleyThickness - p.barThickness / 2] as const;
  return cut(boxAt(centre, x + 2 * guideWall, guideHeight, z + 2 * guideWall), boxAt(centre, x, guideHeight + 2, z));
}

export default function main(params: Parameters = defaultParams): Part[] {
  const p = { ...defaultParams, ...params };
  if (p.crankRadius <= p.shaftDiameter / 2 + nutRadius || p.crankRadius >= p.pulleyDiameter / 2 - nutRadius) {
    throw new Error('Adjust the crank radius to leave room for the pivot nut between the shaft bore and pulley rim.');
  }

  // At top dead centre the pin lies (centres - radius) below the shaft.
  const centres = p.pulleyDiameter / 2 + p.crankRadius + pinInset + p.rimClearance;
  const guideTop = -centres - p.crankRadius - p.linkWidth / 2 - 5;
  const highBarBottom = -centres + p.crankRadius + pinInset - p.barLength;
  if (p.includeGuide && highBarBottom > guideTop - guideHeight) {
    throw new Error('Increase steel bar length or reduce crank radius so the bar spans the guide throughout the stroke.');
  }

  const theta = p.crankAngle * Math.PI / 180;
  const pinX = p.crankRadius * Math.cos(theta);
  const pinY = p.crankRadius * Math.sin(theta);
  const sliderY = pinY - Math.sqrt(centres * centres - pinX * pinX);
  const linkAngle = Math.atan2(sliderY - pinY, -pinX) * 180 / Math.PI;

  const bar = cut(
    boxAt([0, pinInset - p.barLength / 2, p.barThickness / 2], p.barWidth, p.barLength, p.barThickness),
    cylinder(pinRadius, p.barThickness),
  );
  const parts = [
    { name: 'Pulley', color: '#497693', shape: pulley(p) },
    { name: 'Connecting link', color: '#e09b49', shape: translate(rotateZ(connectingLink(p, centres), linkAngle), [pinX, pinY, p.pulleyThickness + axialGap]) },
    { name: 'Steel bar', color: '#aebcc5', shape: translate(bar, [0, sliderY, p.pulleyThickness - p.barThickness]) },
  ];
  if (p.includeGuide) {
    parts.push({ name: 'Guide sleeve', color: '#737f87', shape: guideSleeve(p, guideTop) });
  }
  // Sketch +Y is vertical. Present the standing mechanism on Tau’s Z-up workplane.
  return parts.map((part) => ({ ...part, shape: rotateX(part.shape, 90) }));
}
