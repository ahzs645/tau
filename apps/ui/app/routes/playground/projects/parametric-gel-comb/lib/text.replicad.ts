/**
 * Stroke-font text for the Replicad variant's optional raised labels.
 *
 * Same glyphs and metrics as the OpenCASCADE variant — both read `stroke-font.ts`
 * — so the two variants engrave identical geometry and can be compared directly.
 *
 * Replicad *can* render real glyph outlines (`drawText`, backed by opentype.js,
 * with a default font the kernel preloads), which the OCCT build cannot. That
 * path is deliberately not used here: it would make the two variants disagree
 * for no modelling reason. `docs/research/cad-text-and-custom-fonts.md` covers
 * when to reach for it and how a custom font should be supplied.
 */
import { makeBaseBox } from 'replicad';
import type { Shape3D } from 'replicad';
import { advanceEm, capHeightPerSize, glyphStrokes, glyphWidthEm, strokeWidthEm } from './stroke-font.js';
import type { Vec2 } from './stroke-font.js';

/**
 * Solids for `text(str, size, halign = "center", valign = "center")` extruded
 * `thickness` along +Z from z = 0, centred on the origin. Returned unfused so a
 * caller placing several labels can batch them into one boolean. Unknown glyphs
 * advance without drawing (rendered as a space).
 */
export function strokeText(text: string, options: { size: number; thickness: number }): Shape3D[] {
  const characters = [...text.toUpperCase()];
  const capHeight = options.size * capHeightPerSize;
  const strokeWidth = strokeWidthEm * capHeight;
  const advance = advanceEm * capHeight;
  const totalWidth = Math.max(0, (characters.length - 1) * advance + glyphWidthEm * capHeight);

  const solids: Shape3D[] = [];
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
function strokeSolid(from: Vec2, to: Vec2, strokeWidth: number, thickness: number): Shape3D {
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  const length = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return makeBaseBox(length + strokeWidth, strokeWidth, thickness)
    .rotate(angle, [0, 0, 0], [0, 0, 1])
    .translate([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, 0]);
}
