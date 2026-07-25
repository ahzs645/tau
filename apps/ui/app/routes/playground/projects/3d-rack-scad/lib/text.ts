/**
 * Stroke-font digit engraving for the OpenCASCADE variant.
 *
 * OpenSCAD's `text()` runs through fontconfig/FreeType; the OCCT wasm build
 * used by the kernel excludes `Font_BRepFont`, so glyph outlines are not
 * available. The engraved hole numbers only need '0'–'9', so this renders
 * them as a compact vector stroke font instead: each digit is a short
 * polyline whose segments become square-capped box prisms, ready to be
 * subtracted from a face like the original's extruded text.
 */
import type { TopoDS_Shape } from 'opencascade.js';
import { boxAt, rotateZ, translate } from './occt-utils.js';
import type { Vec2 } from './occt-utils.js';
import { advanceEm, capHeightPerSize, digitStrokes, glyphWidthEm, strokeWidthEm } from './stroke-font.js';

export function engravedText(text: string, options: { size: number; depth: number }): TopoDS_Shape[] {
  const capHeight = options.size * capHeightPerSize;
  const strokeWidth = strokeWidthEm * capHeight;
  const advance = advanceEm * capHeight;
  const totalWidth = (text.length - 1) * advance + glyphWidthEm * capHeight;

  const solids: TopoDS_Shape[] = [];
  for (const [index, character] of [...text].entries()) {
    const strokes = digitStrokes[character];
    if (!strokes) {
      throw new Error(`engravedText: no strokes for character "${character}"`);
    }

    const glyphX = -totalWidth / 2 + index * advance;
    for (const [[x1, y1], [x2, y2]] of strokes) {
      solids.push(
        strokeSolid(
          [glyphX + x1 * capHeight, (y1 - 0.5) * capHeight],
          [glyphX + x2 * capHeight, (y2 - 0.5) * capHeight],
          strokeWidth,
          options.depth,
        ),
      );
    }
  }

  return solids;
}

/** One square-capped stroke segment: a box spanning the segment plus half a stroke width at each end. */
function strokeSolid(from: Vec2, to: Vec2, strokeWidth: number, depth: number): TopoDS_Shape {
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  const length = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const segment = rotateZ(boxAt([0, 0, depth / 2], length + strokeWidth, strokeWidth, depth), angle);
  return translate(segment, [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, 0]);
}
