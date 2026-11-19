import { drawRoundedRectangle } from 'replicad';
import type { Shape3D } from 'replicad';

export const defaultParams = {
  width: 90,
  depth: 55,
  height: 18,
  wall: 3,
  radius: 6,
  style: 'open',
};

export const jsonSchema = {
  type: 'object',
  title: 'Tray Parameters',
  required: ['width', 'depth', 'height', 'wall', 'radius', 'style'],
  properties: {
    width: { type: 'number', title: 'Width', default: 90, minimum: 30, maximum: 180 },
    depth: { type: 'number', title: 'Depth', default: 55, minimum: 25, maximum: 140 },
    height: { type: 'number', title: 'Height', default: 18, minimum: 4, maximum: 60 },
    wall: { type: 'number', title: 'Wall', default: 3, minimum: 1, maximum: 10 },
    radius: { type: 'number', title: 'Radius', default: 6, minimum: 1, maximum: 20 },
    style: {
      type: 'string',
      title: 'Style',
      default: 'open',
      enum: ['open', 'shallow', 'solid'],
    },
  },
};

export default function main(params = {}): Shape3D {
  const p = { ...defaultParams, ...params };
  const outer = drawRoundedRectangle(p.width, p.depth, p.radius)
    .sketchOnPlane()
    .extrude(p.height);

  if (p.style === 'solid') {
    return outer.fillet(0.8);
  }

  const cavityHeight = p.style === 'shallow' ? p.height * 0.55 : p.height;
  const inner = drawRoundedRectangle(
    p.width - p.wall * 2,
    p.depth - p.wall * 2,
    Math.max(1, p.radius - p.wall),
  )
    .sketchOnPlane()
    .extrude(cavityHeight)
    .translate([0, 0, p.wall]);

  return outer.cut(inner).fillet(0.8);
}