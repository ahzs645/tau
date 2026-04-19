import { draw, textBlueprints } from 'replicad';
import type { Shape3D } from 'replicad';

export const defaultParams = {
  printerSize: '258x258 (X1/P1/A1)' as
    | '258x258 (X1/P1/A1)'
    | '180x180 (A1 mini)',
  labelText: 'Bambu Smooth PEI Plate',
  thickness: 1,
  textRelief: 0.4,
};

export default function main(p = defaultParams): Shape3D {
  let W = 258;
  let D = 258;
  if (p.printerSize === '180x180 (A1 mini)') {
    W = 180;
    D = 180;
  }

  const R = 8;
  const tabW_base = W > 200 ? 70 : 50;
  const tabW_top = W > 200 ? 50 : 35;
  const tabH = W > 200 ? 10 : 8;
  const notchW = 10;
  const notchD = 5;
  const notchDistribution = W > 200 ? 15 : 10;

  // Outline drawn starting from front left
  const pen = draw([-W / 2 + R, -D / 2])
    .lineTo([W / 2 - R, -D / 2]) // Front edge
    .tangentArcTo([W / 2, -D / 2 + R]) // Front right corner
    .lineTo([W / 2, D / 2 - R]) // Right edge
    .tangentArcTo([W / 2 - R, D / 2]) // Back right corner
    // back right notch
    .lineTo([W / 2 - notchDistribution, D / 2])
    .lineTo([W / 2 - notchDistribution, D / 2 - notchD])
    .lineTo([W / 2 - notchDistribution - notchW, D / 2 - notchD])
    .lineTo([W / 2 - notchDistribution - notchW, D / 2])
    // Center tab
    .lineTo([tabW_base / 2, D / 2])
    .lineTo([tabW_top / 2, D / 2 + tabH])
    .lineTo([-tabW_top / 2, D / 2 + tabH])
    .lineTo([-tabW_base / 2, D / 2])
    // Back left notch
    .lineTo([-W / 2 + notchDistribution + notchW, D / 2])
    .lineTo([-W / 2 + notchDistribution + notchW, D / 2 - notchD])
    .lineTo([-W / 2 + notchDistribution, D / 2 - notchD])
    .lineTo([-W / 2 + notchDistribution, D / 2])
    // Back left corner
    .lineTo([-W / 2 + R, D / 2])
    .tangentArcTo([-W / 2, D / 2 - R])
    // Left edge
    .lineTo([-W / 2, -D / 2 + R])
    // Front left corner
    .tangentArcTo([-W / 2 + R, -D / 2])
    .close();

  const plateBase = pen.sketchOnPlane().extrude(p.thickness);

  // Left Text
  let textLeft = textBlueprints(p.labelText, { fontSize: W > 200 ? 8 : 6 });
  const bboxL = textLeft.boundingBox;
  textLeft = textLeft
    .translate(-bboxL.center[0], -bboxL.center[1])
    .rotate(90)
    .translate(-W / 2 + (W > 200 ? 15 : 10), 0);
  const textLeft3D = textLeft
    .sketchOnPlane()
    .extrude(p.thickness + p.textRelief);

  // Bottom right Text
  let textRight = textBlueprints('PLA/PETG/ABS/TPU/PC', {
    fontSize: W > 200 ? 5 : 4,
  });
  const bboxR = textRight.boundingBox;
  textRight = textRight
    .translate(-bboxR.center[0], -bboxR.center[1])
    .translate(W / 2 - (W > 200 ? 50 : 35), -D / 2 + (W > 200 ? 10 : 8));
  const textRight3D = textRight
    .sketchOnPlane()
    .extrude(p.thickness + p.textRelief);

  return plateBase.fuse(textLeft3D).fuse(textRight3D);
}
