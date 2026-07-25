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
import { advanceEm, capHeightPerSize, glyphStrokes, glyphWidthEm, strokeWidthEm } from './stroke-font.js';

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
