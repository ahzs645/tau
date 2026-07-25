/**
 * Stamp — OpenCASCADE variant of `Main.scad`, rendering the artwork the
 * OpenSCAD original cannot.
 *
 * The shipped `yaa.svg` is a stroke drawing: 1624 `<line>` elements with
 * `fill: none` and a 2.27 px stroke. OpenSCAD's `import()` builds geometry from
 * fill area, so it imports as nothing and the model's `offset()` thickens
 * emptiness into radial slivers across the stamp face. Here the strokes are
 * read directly (`lib/svg-strokes.ts`) and given width as solids, which is both
 * simpler and correct.
 *
 * The artwork arrives through the bundler's `?raw` import, so it is the
 * project's own file — or a viewer-uploaded one written to the same name.
 *
 * Deviation from the original: the OpenSCAD version imports two STL templates
 * for the handle and knub. Meshes are not BRep, so this variant builds the
 * stamp plate and its artwork only; `component_selection` therefore has no
 * handle option.
 */
import artworkSource from './yaa.svg?raw';
import type { TopoDS_Shape } from 'opencascade.js';
import {
  BRepAlgoAPI_Cut,
  BRepAlgoAPI_Fuse,
  BRepBuilderAPI_MakeFace,
  BRepBuilderAPI_MakePolygon,
  BRepPrimAPI_MakeCylinder,
  BRepPrimAPI_MakePrism,
  gp_Ax2,
  gp_Dir,
  gp_Pnt,
  gp_Vec,
  NCollection_List_TopoDS_Shape,
} from 'opencascade.js';
import { parseSvgStrokes, placeStrokes, simplifyStrokes } from './lib/svg-strokes.js';
import type { StrokeSegment } from './lib/svg-strokes.js';

export const defaultParams = {
  /** 'negative' engraves the artwork into the face; 'positive' raises it. */
  svgStyle: 'negative',
  svgStrokeWidth: 0.7,
  svgScale: 0.16,
  svgAdjustX: -0.7,
  svgAdjustY: 0,
  plateWidth: 30,
  plateLength: 40,
  plateThickness: 2.5,
  roundedRadius: 5,
  stampRidgeHeight: 2.5,
  /**
   * Direction change tolerated when merging the artwork's consecutive line
   * segments. Every segment costs a boolean, so this is the knob between a
   * render and its cost. 30° collapses yaa.svg's 1624 plotter segments to ~400
   * and renders in ~24 s; 6° keeps 1035 segments and renders in ~61 s.
   */
  simplifyAngleDeg: 30,
};

type Params = typeof defaultParams;

type ShapeMaker = { Shape(): TopoDS_Shape; delete(): void };

const shapeOf = (maker: ShapeMaker): TopoDS_Shape => {
  const shape = maker.Shape();
  maker.delete();
  return shape;
};

function shapeList(shapes: readonly TopoDS_Shape[]): NCollection_List_TopoDS_Shape {
  const list = new NCollection_List_TopoDS_Shape();
  for (const shape of shapes) {
    list.Append(shape);
  }

  return list;
}

type MultiBooleanOperation = new () => {
  SetArguments(shapes: NCollection_List_TopoDS_Shape): void;
  SetTools(shapes: NCollection_List_TopoDS_Shape): void;
  Build(): void;
  Shape(): TopoDS_Shape;
  delete(): void;
};

/** Consumes its inputs, like the other OCCT ports' helpers. */
function booleanOf(
  Operation: MultiBooleanOperation,
  args: readonly TopoDS_Shape[],
  tools: readonly TopoDS_Shape[],
): TopoDS_Shape {
  const operation = new Operation();
  const argumentList = shapeList(args);
  const toolList = shapeList(tools);
  operation.SetArguments(argumentList);
  operation.SetTools(toolList);
  operation.Build();
  const result = operation.Shape();
  operation.delete();
  argumentList.delete();
  toolList.delete();
  for (const shape of [...args, ...tools]) {
    shape.delete();
  }

  return result;
}

const fuse = (...shapes: TopoDS_Shape[]): TopoDS_Shape =>
  shapes.length === 1 ? shapes[0]! : booleanOf(BRepAlgoAPI_Fuse, [shapes[0]!], shapes.slice(1));

const cut = (base: TopoDS_Shape, ...tools: TopoDS_Shape[]): TopoDS_Shape =>
  tools.length === 0 ? base : booleanOf(BRepAlgoAPI_Cut, [base], tools);

/** A polygon in the XY plane extruded along +Z. */
function polygonPrism(points: ReadonlyArray<readonly [number, number]>, height: number, baseZ = 0): TopoDS_Shape {
  const polygon = new BRepBuilderAPI_MakePolygon();
  for (const [x, y] of points) {
    const point = new gp_Pnt(x, y, baseZ);
    polygon.Add(point);
    point.delete();
  }

  polygon.Close();
  const wire = polygon.Wire();
  const faceMaker = new BRepBuilderAPI_MakeFace(wire, true);
  const face = faceMaker.Face();
  const extrusion = new gp_Vec(0, 0, height);
  const prism = shapeOf(new BRepPrimAPI_MakePrism(face, extrusion, false, true));
  extrusion.delete();
  face.delete();
  faceMaker.delete();
  wire.delete();
  polygon.delete();
  return prism;
}

/** Cylinder along +Z with its base at `[x, y, 0]`. */
function cylinderAt([x, y]: readonly [number, number], radius: number, height: number, baseZ = 0): TopoDS_Shape {
  const origin = new gp_Pnt(x, y, baseZ);
  const direction = new gp_Dir(0, 0, 1);
  const axes = new gp_Ax2(origin, direction);
  const solid = shapeOf(new BRepPrimAPI_MakeCylinder(axes, radius, height));
  axes.delete();
  direction.delete();
  origin.delete();
  return solid;
}

/** `rounded_rectangle()` — the plate outline, as a slab plus corner rods. */
function roundedPlate(p: Params, height: number): TopoDS_Shape {
  const halfWidth = p.plateWidth / 2;
  const halfLength = p.plateLength / 2;
  const radius = Math.min(p.roundedRadius, Math.min(halfWidth, halfLength));

  const parts: TopoDS_Shape[] = [
    polygonPrism(
      [
        [-halfWidth + radius, -halfLength],
        [halfWidth - radius, -halfLength],
        [halfWidth - radius, halfLength],
        [-halfWidth + radius, halfLength],
      ],
      height,
    ),
    polygonPrism(
      [
        [-halfWidth, -halfLength + radius],
        [halfWidth, -halfLength + radius],
        [halfWidth, halfLength - radius],
        [-halfWidth, halfLength - radius],
      ],
      height,
    ),
  ];
  for (const x of [-halfWidth + radius, halfWidth - radius]) {
    for (const y of [-halfLength + radius, halfLength - radius]) {
      parts.push(cylinderAt([x, y], radius, height));
    }
  }

  return fuse(...parts);
}

/** One stroke body: a rectangle the length of the segment, extruded. */
function strokeBody(segment: StrokeSegment, width: number, height: number, baseZ: number): TopoDS_Shape | undefined {
  const [x1, y1] = segment.from;
  const [x2, y2] = segment.to;
  const [dx, dy] = [x2 - x1, y2 - y1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) {
    return undefined;
  }

  // Unit normal, so the rectangle straddles the segment by half a stroke width.
  const radius = width / 2;
  const [nx, ny] = [(-dy / length) * radius, (dx / length) * radius];
  return polygonPrism(
    [
      [x1 + nx, y1 + ny],
      [x2 + nx, y2 + ny],
      [x2 - nx, y2 - ny],
      [x1 - nx, y1 - ny],
    ],
    height,
    baseZ,
  );
}

/**
 * Applies the artwork in batches, building each batch's solids only when it is
 * about to be consumed.
 *
 * Building every stroke first and then booleaning holds ~1000 solids live at
 * once, which exhausts the wasm heap before the booleans even start. Generating
 * a batch, consuming it, and moving on keeps the live count at `batchSize`.
 */
function applyArtwork(
  plate: TopoDS_Shape,
  segments: readonly StrokeSegment[],
  build: (segment: StrokeSegment) => TopoDS_Shape | undefined,
  raised: boolean,
  // Fifteen, not a hundred: BOPAlgo's cost is superlinear in how many tools in
  // one operation intersect *each other*, and chained strokes all touch their
  // neighbours. Profiling batches of 100 gave 4.6 s, 185 s, 239 s, 58 s — the
  // spikes are the dense passages of the drawing, not a growing base. Fifteen
  // makes every batch 0.2–1.4 s and the whole render 20x faster.
  batchSize = 15,
): TopoDS_Shape {
  let result = plate;
  for (let index = 0; index < segments.length; index += batchSize) {
    const tools = segments
      .slice(index, index + batchSize)
      .map((segment) => build(segment))
      .filter((solid): solid is TopoDS_Shape => solid !== undefined);
    if (tools.length === 0) {
      continue;
    }

    result = raised ? fuse(result, ...tools) : cut(result, ...tools);
  }

  return result;
}

export default function main(params: Params = defaultParams): TopoDS_Shape {
  const p = { ...defaultParams, ...params };
  const strokes = placeStrokes(simplifyStrokes(parseSvgStrokes(artworkSource, p.svgStrokeWidth), p.simplifyAngleDeg), {
    scale: p.svgScale,
    offset: [p.svgAdjustX, p.svgAdjustY],
  });
  // The document's own stroke width, scaled, plus the model's thickening —
  // the role `offset(r = svg_stroke_width / 2)` plays in the original.
  const strokeWidth = strokes.strokeWidth + p.svgStrokeWidth;

  const seamOverlap = 0.1;
  const toolHeight = p.plateThickness + 2 * seamOverlap;
  const raised = p.svgStyle === 'positive';
  const artworkZ = raised ? p.plateThickness - seamOverlap : -seamOverlap;

  // Caps are omitted: the artwork is a chain, so consecutive quads already meet
  // at their shared vertex, and each rod is another solid on a boolean budget
  // that is already the binding constraint at 1624 segments.
  const toolHeightForStyle = raised ? p.stampRidgeHeight + seamOverlap : toolHeight;
  return applyArtwork(
    roundedPlate(p, p.plateThickness),
    strokes.segments,
    (segment) => strokeBody(segment, strokeWidth, toolHeightForStyle, artworkZ),
    raised,
  );
}
