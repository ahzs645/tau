/**
 * Stroke extraction from an SVG, shared by every kernel variant of this project.
 *
 * Pure geometry: no kernel types. Each variant turns the segments into solids
 * its own way.
 *
 * The artwork this project ships (and the kind of artwork a viewer is likely to
 * upload from a pen-plotter or a laser tool) is a *stroke* drawing — `yaa.svg`
 * is 1624 `<line>` elements with `fill: none` and a `stroke-width`. OpenSCAD's
 * `import()` builds geometry from fill area, so a stroke-only file imports as
 * nothing and the model's `offset()` thickens it into radial slivers. Reading
 * the strokes directly and giving them width here sidesteps that entirely, and
 * is why the OpenCASCADE variant renders the logo the OpenSCAD one cannot.
 */

export type Vec2 = readonly [number, number];
export type StrokeSegment = { readonly from: Vec2; readonly to: Vec2 };

export type SvgStrokes = {
  readonly segments: readonly StrokeSegment[];
  /** Stroke width declared by the document, in SVG user units. */
  readonly strokeWidth: number;
  /** Extents of the drawing in SVG user units, before any transform. */
  readonly bounds: { readonly min: Vec2; readonly max: Vec2 };
};

const lineElementPattern = /<line\b[^>]*>/giu;
const attributePattern = (name: string): RegExp => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'iu');
const strokeWidthPattern = /stroke-width\s*:\s*([\d.]+)/iu;
const strokeWidthAttributePattern = /stroke-width\s*=\s*"([\d.]+)/iu;

function attribute(element: string, name: string): number | undefined {
  const match = attributePattern(name).exec(element);
  const value = match?.[1] === undefined ? Number.NaN : Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Every `<line>` in the document, with the stroke width from either the CSS
 * block or a presentation attribute. Elements missing a coordinate are skipped
 * rather than throwing, so a partially-understood file still renders something.
 */
export function parseSvgStrokes(source: string, fallbackStrokeWidth = 1): SvgStrokes {
  const segments: StrokeSegment[] = [];
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];

  for (const [element] of source.matchAll(lineElementPattern)) {
    const x1 = attribute(element, 'x1');
    const y1 = attribute(element, 'y1');
    const x2 = attribute(element, 'x2');
    const y2 = attribute(element, 'y2');
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
      continue;
    }

    segments.push({ from: [x1, y1], to: [x2, y2] });
    for (const [x, y] of [
      [x1, y1],
      [x2, y2],
    ] as const) {
      min[0] = Math.min(min[0], x);
      min[1] = Math.min(min[1], y);
      max[0] = Math.max(max[0], x);
      max[1] = Math.max(max[1], y);
    }
  }

  const strokeWidth =
    Number.parseFloat(strokeWidthPattern.exec(source)?.[1] ?? '') ||
    Number.parseFloat(strokeWidthAttributePattern.exec(source)?.[1] ?? '') ||
    fallbackStrokeWidth;

  return {
    segments,
    strokeWidth,
    bounds: segments.length > 0 ? { min, max } : { min: [0, 0], max: [0, 0] },
  };
}

export type PlacementOptions = {
  /** Multiplies SVG user units to reach millimetres. */
  scale: number;
  /** Millimetre offset applied after centring. */
  offset?: Vec2;
  /** SVG's y axis points down; flip it so the artwork reads the right way up. */
  flipY?: boolean;
};

/**
 * The drawing centred on the origin and scaled to millimetres, matching
 * `translate(svg_adjust) scale(svg_scale) import(file, center = true)`.
 */
export function placeStrokes(strokes: SvgStrokes, options: PlacementOptions): SvgStrokes {
  const { scale } = options;
  const [offsetX, offsetY] = options.offset ?? [0, 0];
  const flipY = options.flipY ?? true;
  const centreX = (strokes.bounds.min[0] + strokes.bounds.max[0]) / 2;
  const centreY = (strokes.bounds.min[1] + strokes.bounds.max[1]) / 2;

  const place = ([x, y]: Vec2): Vec2 => [
    (x - centreX) * scale + offsetX,
    (flipY ? centreY - y : y - centreY) * scale + offsetY,
  ];

  const segments = strokes.segments.map((segment) => ({ from: place(segment.from), to: place(segment.to) }));
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  for (const segment of segments) {
    for (const [x, y] of [segment.from, segment.to]) {
      min[0] = Math.min(min[0], x);
      min[1] = Math.min(min[1], y);
      max[0] = Math.max(max[0], x);
      max[1] = Math.max(max[1], y);
    }
  }

  return {
    segments,
    strokeWidth: strokes.strokeWidth * scale,
    bounds: segments.length > 0 ? { min, max } : { min: [0, 0], max: [0, 0] },
  };
}
