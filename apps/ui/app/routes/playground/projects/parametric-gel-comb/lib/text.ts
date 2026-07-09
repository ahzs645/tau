/**
 * Stroke-font text for the OpenCASCADE variant's optional raised labels.
 *
 * OpenSCAD's `text()` runs through fontconfig/FreeType; the OCCT wasm build the
 * kernel uses excludes `Font_BRepFont` (see
 * docs/research/occt-unbound-symbols-audit.md), so glyph outlines are not
 * available. The comb's labels are disabled by default; when turned on, this
 * renders them as a compact single-stroke stencil font — each glyph is a set of
 * polyline segments turned into square-capped box prisms, matching the pilots'
 * approach (3d-rack-scad shipped the digit-only subset). Input is upper-cased,
 * and any glyph without strokes is skipped rather than throwing, so a label can
 * never break the render.
 */
import type { TopoDS_Shape } from 'opencascade.js';
import { boxAt, rotateZ, translate } from './occt-utils.js';
import type { Vec2 } from './occt-utils.js';

type Stroke = readonly [Vec2, Vec2];

/**
 * Glyph polylines on a unit box: x in [0, 0.6], y in [0, 1] cap-height units,
 * y up. Segment joints overlap thanks to the square stroke caps. Curves are
 * approximated with straight segments, which suits the box-prism rendering.
 */
const glyphStrokes: Readonly<Record<string, readonly Stroke[]>> = {
  ' ': [],
  '-': [[[0.1, 0.5], [0.5, 0.5]]],
  '.': [[[0.25, 0], [0.35, 0]]],
  '0': [[[0, 0], [0.6, 0]], [[0.6, 0], [0.6, 1]], [[0.6, 1], [0, 1]], [[0, 1], [0, 0]]],
  '1': [[[0.1, 0.75], [0.3, 1]], [[0.3, 1], [0.3, 0]], [[0.1, 0], [0.5, 0]]],
  '2': [[[0, 1], [0.6, 1]], [[0.6, 1], [0.6, 0.5]], [[0.6, 0.5], [0, 0.5]], [[0, 0.5], [0, 0]], [[0, 0], [0.6, 0]]],
  '3': [[[0, 1], [0.6, 1]], [[0.6, 1], [0.6, 0]], [[0.6, 0], [0, 0]], [[0.2, 0.5], [0.6, 0.5]]],
  '4': [[[0, 1], [0, 0.5]], [[0, 0.5], [0.6, 0.5]], [[0.6, 1], [0.6, 0]]],
  '5': [[[0.6, 1], [0, 1]], [[0, 1], [0, 0.5]], [[0, 0.5], [0.6, 0.5]], [[0.6, 0.5], [0.6, 0]], [[0.6, 0], [0, 0]]],
  '6': [[[0.6, 1], [0, 1]], [[0, 1], [0, 0]], [[0, 0], [0.6, 0]], [[0.6, 0], [0.6, 0.5]], [[0.6, 0.5], [0, 0.5]]],
  '7': [[[0, 1], [0.6, 1]], [[0.6, 1], [0.25, 0]]],
  '8': [[[0, 0], [0.6, 0]], [[0.6, 0], [0.6, 1]], [[0.6, 1], [0, 1]], [[0, 1], [0, 0]], [[0, 0.5], [0.6, 0.5]]],
  '9': [[[0.6, 0.5], [0, 0.5]], [[0, 0.5], [0, 1]], [[0, 1], [0.6, 1]], [[0.6, 1], [0.6, 0]], [[0.6, 0], [0, 0]]],
  A: [[[0, 0], [0.3, 1]], [[0.3, 1], [0.6, 0]], [[0.13, 0.4], [0.47, 0.4]]],
  B: [
    [[0, 0], [0, 1]],
    [[0, 1], [0.45, 1]],
    [[0.45, 1], [0.45, 0.55]],
    [[0.45, 0.55], [0, 0.5]],
    [[0, 0.5], [0.55, 0.45]],
    [[0.55, 0.45], [0.55, 0]],
    [[0.55, 0], [0, 0]],
  ],
  C: [[[0.6, 1], [0, 1]], [[0, 1], [0, 0]], [[0, 0], [0.6, 0]]],
  D: [[[0, 0], [0, 1]], [[0, 1], [0.4, 1]], [[0.4, 1], [0.6, 0.7]], [[0.6, 0.7], [0.6, 0.3]], [[0.6, 0.3], [0.4, 0]], [[0.4, 0], [0, 0]]],
  E: [[[0.6, 1], [0, 1]], [[0, 1], [0, 0]], [[0, 0], [0.6, 0]], [[0, 0.5], [0.45, 0.5]]],
  F: [[[0.6, 1], [0, 1]], [[0, 1], [0, 0]], [[0, 0.5], [0.45, 0.5]]],
  G: [[[0.6, 1], [0, 1]], [[0, 1], [0, 0]], [[0, 0], [0.6, 0]], [[0.6, 0], [0.6, 0.45]], [[0.6, 0.45], [0.35, 0.45]]],
  H: [[[0, 1], [0, 0]], [[0.6, 1], [0.6, 0]], [[0, 0.5], [0.6, 0.5]]],
  I: [[[0.3, 1], [0.3, 0]], [[0.1, 1], [0.5, 1]], [[0.1, 0], [0.5, 0]]],
  J: [[[0.6, 1], [0.6, 0.2]], [[0.6, 0.2], [0.4, 0]], [[0.4, 0], [0.1, 0]], [[0.1, 0], [0, 0.25]]],
  K: [[[0, 1], [0, 0]], [[0, 0.45], [0.55, 1]], [[0, 0.45], [0.55, 0]]],
  L: [[[0, 1], [0, 0]], [[0, 0], [0.55, 0]]],
  M: [[[0, 0], [0, 1]], [[0, 1], [0.3, 0.45]], [[0.3, 0.45], [0.6, 1]], [[0.6, 1], [0.6, 0]]],
  N: [[[0, 0], [0, 1]], [[0, 1], [0.6, 0]], [[0.6, 0], [0.6, 1]]],
  O: [[[0, 0], [0.6, 0]], [[0.6, 0], [0.6, 1]], [[0.6, 1], [0, 1]], [[0, 1], [0, 0]]],
  P: [[[0, 0], [0, 1]], [[0, 1], [0.55, 1]], [[0.55, 1], [0.55, 0.5]], [[0.55, 0.5], [0, 0.5]]],
  Q: [[[0, 0], [0.6, 0]], [[0.6, 0], [0.6, 1]], [[0.6, 1], [0, 1]], [[0, 1], [0, 0]], [[0.35, 0.35], [0.65, 0]]],
  R: [[[0, 0], [0, 1]], [[0, 1], [0.55, 1]], [[0.55, 1], [0.55, 0.5]], [[0.55, 0.5], [0, 0.5]], [[0.25, 0.5], [0.6, 0]]],
  S: [[[0.6, 1], [0, 1]], [[0, 1], [0, 0.5]], [[0, 0.5], [0.6, 0.5]], [[0.6, 0.5], [0.6, 0]], [[0.6, 0], [0, 0]]],
  T: [[[0, 1], [0.6, 1]], [[0.3, 1], [0.3, 0]]],
  U: [[[0, 1], [0, 0]], [[0, 0], [0.6, 0]], [[0.6, 0], [0.6, 1]]],
  V: [[[0, 1], [0.3, 0]], [[0.3, 0], [0.6, 1]]],
  W: [[[0, 1], [0.15, 0]], [[0.15, 0], [0.3, 0.55]], [[0.3, 0.55], [0.45, 0]], [[0.45, 0], [0.6, 1]]],
  X: [[[0, 1], [0.6, 0]], [[0, 0], [0.6, 1]]],
  Y: [[[0, 1], [0.3, 0.5]], [[0.6, 1], [0.3, 0.5]], [[0.3, 0.5], [0.3, 0]]],
  Z: [[[0, 1], [0.6, 1]], [[0.6, 1], [0, 0]], [[0, 0], [0.6, 0]]],
};

const glyphWidthEm = 0.6;
const advanceEm = 0.85;
const strokeWidthEm = 0.15;
// OpenSCAD's `text(size = s)` produces glyphs of roughly 0.7·s cap height.
const capHeightPerSize = 0.7;

/**
 * Solids for `text(str, size, halign = "center", valign = "center")` extruded
 * `thickness` along +Z from z = 0, centered on the origin. Returned unfused so
 * a caller placing several labels can batch them into one boolean. Unknown
 * glyphs advance without drawing (rendered as a space).
 */
export function strokeText(text: string, options: { size: number; thickness: number }): TopoDS_Shape[] {
  const characters = [...text.toUpperCase()];
  const capHeight = options.size * capHeightPerSize;
  const strokeWidth = strokeWidthEm * capHeight;
  const advance = advanceEm * capHeight;
  const totalWidth = Math.max(0, (characters.length - 1) * advance + glyphWidthEm * capHeight);

  const solids: TopoDS_Shape[] = [];
  for (const [index, character] of characters.entries()) {
    const strokes = glyphStrokes[character] ?? [];
    const glyphX = -totalWidth / 2 + index * advance;
    for (const [[x1, y1], [x2, y2]] of strokes) {
      solids.push(
        strokeSolid(
          [glyphX + x1 * capHeight, (y1 - 0.5) * capHeight],
          [glyphX + x2 * capHeight, (y2 - 0.5) * capHeight],
          strokeWidth,
          options.thickness,
        ),
      );
    }
  }

  return solids;
}

/** One square-capped stroke segment: a box spanning the segment plus half a stroke width at each end. */
function strokeSolid(from: Vec2, to: Vec2, strokeWidth: number, thickness: number): TopoDS_Shape {
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  const length = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const segment = rotateZ(boxAt([0, 0, thickness / 2], length + strokeWidth, strokeWidth, thickness), angle);
  return translate(segment, [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, 0]);
}
