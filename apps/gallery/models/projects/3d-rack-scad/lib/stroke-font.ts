/**
 * Stroke-font digit data, shared by every kernel variant of this project.
 *
 * Pure data plus metrics: no kernel types, no geometry. Each variant turns the
 * polylines into solids its own way (`text.ts` builds OCCT box prisms,
 * `text.replicad.ts` builds replicad ones), so the font is defined once.
 *
 * See docs/research/cad-text-and-custom-fonts.md for why the engraved numbers
 * are a stroke font at all, and what a real-font path would take.
 */

export type Vec2 = readonly [number, number];
export type Stroke = readonly [Vec2, Vec2];

/**
 * Digit polylines on a unit glyph box: x in [0, 0.6], y in [0, 1] cap-height
 * units, y up. Joints overlap thanks to the square stroke caps.
 */
export const digitStrokes: Readonly<Record<string, readonly Stroke[]>> = {
  '0': [
    [
      [0, 0],
      [0.6, 0],
    ],
    [
      [0.6, 0],
      [0.6, 1],
    ],
    [
      [0.6, 1],
      [0, 1],
    ],
    [
      [0, 1],
      [0, 0],
    ],
  ],
  '1': [
    [
      [0.1, 0.75],
      [0.3, 1],
    ],
    [
      [0.3, 1],
      [0.3, 0],
    ],
    [
      [0.1, 0],
      [0.5, 0],
    ],
  ],
  '2': [
    [
      [0, 1],
      [0.6, 1],
    ],
    [
      [0.6, 1],
      [0.6, 0.5],
    ],
    [
      [0.6, 0.5],
      [0, 0.5],
    ],
    [
      [0, 0.5],
      [0, 0],
    ],
    [
      [0, 0],
      [0.6, 0],
    ],
  ],
  '3': [
    [
      [0, 1],
      [0.6, 1],
    ],
    [
      [0.6, 1],
      [0.6, 0],
    ],
    [
      [0.6, 0],
      [0, 0],
    ],
    [
      [0.2, 0.5],
      [0.6, 0.5],
    ],
  ],
  '4': [
    [
      [0, 1],
      [0, 0.5],
    ],
    [
      [0, 0.5],
      [0.6, 0.5],
    ],
    [
      [0.6, 1],
      [0.6, 0],
    ],
  ],
  '5': [
    [
      [0.6, 1],
      [0, 1],
    ],
    [
      [0, 1],
      [0, 0.5],
    ],
    [
      [0, 0.5],
      [0.6, 0.5],
    ],
    [
      [0.6, 0.5],
      [0.6, 0],
    ],
    [
      [0.6, 0],
      [0, 0],
    ],
  ],
  '6': [
    [
      [0.6, 1],
      [0, 1],
    ],
    [
      [0, 1],
      [0, 0],
    ],
    [
      [0, 0],
      [0.6, 0],
    ],
    [
      [0.6, 0],
      [0.6, 0.5],
    ],
    [
      [0.6, 0.5],
      [0, 0.5],
    ],
  ],
  '7': [
    [
      [0, 1],
      [0.6, 1],
    ],
    [
      [0.6, 1],
      [0.25, 0],
    ],
  ],
  '8': [
    [
      [0, 0],
      [0.6, 0],
    ],
    [
      [0.6, 0],
      [0.6, 1],
    ],
    [
      [0.6, 1],
      [0, 1],
    ],
    [
      [0, 1],
      [0, 0],
    ],
    [
      [0, 0.5],
      [0.6, 0.5],
    ],
  ],
  '9': [
    [
      [0.6, 0.5],
      [0, 0.5],
    ],
    [
      [0, 0.5],
      [0, 1],
    ],
    [
      [0, 1],
      [0.6, 1],
    ],
    [
      [0.6, 1],
      [0.6, 0],
    ],
    [
      [0.6, 0],
      [0, 0],
    ],
  ],
};

export const glyphWidthEm = 0.6;
export const advanceEm = 0.85;
export const strokeWidthEm = 0.17;
// OpenSCAD's `text(size = s)` produces digits of roughly 0.7·s cap height.
export const capHeightPerSize = 0.7;

/**
 * Solids for `text(str, size, halign = "center", valign = "center")` extruded
 * `depth` along +Z from z = 0. Returned unfused so a caller batching many
 * labels can hand every box to a single multi-tool cut.
 */
