/**
 * Projection Test — exercises HLR (Hidden Line Removal) bindings.
 * Creates a box and runs drawProjection() to verify HLRBRep_Algo,
 * HLRAlgo_Projector, HLRBRep_HLRToShape, and Handle_HLRBRep_Algo
 * are properly bound in the WASM module.
 */
import type { AnyShape } from 'replicad';
import { drawProjection, draw } from 'replicad';

/* This follow the "first angle projection" convention
 * https://en.wikipedia.org/wiki/Multiview_orthographic_projection#First-angle_projection
 */
const descriptiveGeom = (shape: AnyShape) => [
  { shape, name: 'Shape to project' },
  {
    shape: drawProjection(shape, 'front').visible,
    name: 'Front',
  },
  {
    shape: drawProjection(shape, 'back').visible,
    name: 'Back',
  },
  {
    shape: drawProjection(shape, 'top').visible,
    name: 'Top',
  },
  {
    shape: drawProjection(shape, 'bottom').visible,
    name: 'Bottom',
  },
  {
    shape: drawProjection(shape, 'left').visible,
    name: 'Left',
  },
  {
    shape: drawProjection(shape, 'right').visible,
    name: 'Right',
  },
];

export const defaultParams = {};

export default function main(): ReturnType<typeof descriptiveGeom> {
  // This shape looks different from every angle
  const shape = draw()
    .vLine(-10)
    .hLine(-5)
    .vLine(15)
    .customCorner(2)
    .hLine(15)
    .vLine(-5)
    .close()
    .sketchOnPlane()
    .extrude(10)
    .chamfer(5, (edgeFinder) =>
      edgeFinder.inPlane('XY', 10).containsPoint([10, 1, 10]),
    );
  return descriptiveGeom(shape);
}
