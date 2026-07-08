/**
 * Minimal OpenCASCADE helpers for the OpenCASCADE variant of this project.
 *
 * The gel comb is entirely 2D profiles (rounded rectangles for the bar, teeth,
 * and slots; angled polygons for the side hooks) extruded and combined, so
 * these helpers mirror the OpenSCAD idioms the original uses — lower-left
 * anchored `rounded_rect_2d`, `polygon`, `linear_extrude`, booleans — letting
 * the ported model read like the source. Helpers consume their shape inputs
 * (Emscripten objects are freed as soon as a derived shape exists); build a
 * fresh shape per use like an OpenSCAD module call instead of reusing one.
 */
import {
  BRepAlgoAPI_Common,
  BRepAlgoAPI_Cut,
  BRepAlgoAPI_Fuse,
  BRepBuilderAPI_MakeFace,
  BRepBuilderAPI_MakePolygon,
  BRepBuilderAPI_Transform,
  BRepPrimAPI_MakeBox,
  BRepPrimAPI_MakeCylinder,
  BRepPrimAPI_MakePrism,
  gp_Ax1,
  gp_Dir,
  gp_Pnt,
  gp_Trsf,
  gp_Vec,
  NCollection_List_TopoDS_Shape,
} from 'opencascade.js';
import type { TopoDS_Shape } from 'opencascade.js';

export type Vec3 = readonly [number, number, number];
export type Vec2 = readonly [number, number];

const epsilon = 1e-9;

const degToRad = (degrees: number): number => (degrees * Math.PI) / 180;

type ShapeMaker = { Shape(): TopoDS_Shape; delete(): void };

/** Run a maker, take its shape, free the maker. */
function shapeOf(maker: ShapeMaker): TopoDS_Shape {
  const shape = maker.Shape();
  maker.delete();
  return shape;
}

/** Axis-aligned box anchored at the origin, spanning [0,dx] x [0,dy] x [0,dz] — like `cube([dx,dy,dz])`. */
export function box(dx: number, dy: number, dz: number): TopoDS_Shape {
  return shapeOf(new BRepPrimAPI_MakeBox(dx, dy, dz));
}

/** Box centered on `center` in x/y/z — `translate(center) cube(size, center=true)`. */
export function boxAt(center: Vec3, dx: number, dy: number, dz: number): TopoDS_Shape {
  return translate(box(dx, dy, dz), [center[0] - dx / 2, center[1] - dy / 2, center[2] - dz / 2]);
}

/** Cylinder along +Z starting at the origin, like `cylinder(r, h)`. */
function cylinder(radius: number, height: number): TopoDS_Shape {
  return shapeOf(new BRepPrimAPI_MakeCylinder(radius, height));
}

/**
 * `linear_extrude(thickness) rounded_rect_2d(width, height, radius)`: a rounded
 * rectangle anchored at the lower-left (spanning [0,width] x [0,height]),
 * extruded +Z from z = 0. Built constructively as the OpenSCAD `hull()` of four
 * corner circles — a cross of slabs plus quarter-round corner rods — so a fully
 * rounded end (radius = height/2) becomes a proper stadium/obround (the slots).
 */
export function roundedRectPrism(width: number, height: number, radius: number, thickness: number): TopoDS_Shape {
  const r = Math.min(radius, Math.min(width, height) / 2);
  if (r <= epsilon) {
    return box(width, height, thickness);
  }

  const parts: TopoDS_Shape[] = [];
  if (width - 2 * r > epsilon) {
    parts.push(translate(box(width - 2 * r, height, thickness), [r, 0, 0]));
  }
  if (height - 2 * r > epsilon) {
    parts.push(translate(box(width, height - 2 * r, thickness), [0, r, 0]));
  }

  // Corner quarter-rounds; dedupe coincident centers when radius == width/2 or
  // height/2 (an obround, where the two centers on that axis collapse to one).
  const seen = new Set<string>();
  for (const cx of [r, width - r]) {
    for (const cy of [r, height - r]) {
      const key = `${cx.toFixed(6)},${cy.toFixed(6)}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      parts.push(translate(cylinder(r, thickness), [cx, cy, 0]));
    }
  }

  return fuse(...parts);
}

/** `linear_extrude(height) polygon(points)` — a polygon in the XY plane extruded along +Z. */
export function polygonPrism(points: ReadonlyArray<Vec2>, height: number): TopoDS_Shape {
  const polygon = new BRepBuilderAPI_MakePolygon();
  for (const [x, y] of points) {
    const point = new gp_Pnt(x, y, 0);
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

function transformed(shape: TopoDS_Shape, applyTo: (transform: gp_Trsf) => void): TopoDS_Shape {
  const transform = new gp_Trsf();
  applyTo(transform);
  const operation = new BRepBuilderAPI_Transform(shape, transform, true, false);
  const result = operation.Shape();
  operation.delete();
  transform.delete();
  shape.delete();
  return result;
}

export function translate(shape: TopoDS_Shape, offset: Vec3): TopoDS_Shape {
  return transformed(shape, (transform) => {
    const vector = new gp_Vec(offset[0], offset[1], offset[2]);
    transform.SetTranslation(vector);
    vector.delete();
  });
}

export function rotateZ(shape: TopoDS_Shape, degrees: number): TopoDS_Shape {
  return transformed(shape, (transform) => {
    const origin = new gp_Pnt(0, 0, 0);
    const direction = new gp_Dir(0, 0, 1);
    const rotationAxis = new gp_Ax1(origin, direction);
    transform.SetRotation(rotationAxis, degToRad(degrees));
    rotationAxis.delete();
    direction.delete();
    origin.delete();
  });
}

type MultiBooleanOperation = new () => {
  SetArguments(shapes: NCollection_List_TopoDS_Shape): void;
  SetTools(shapes: NCollection_List_TopoDS_Shape): void;
  Build(): void;
  Shape(): TopoDS_Shape;
  delete(): void;
};

function shapeList(shapes: ReadonlyArray<TopoDS_Shape>): NCollection_List_TopoDS_Shape {
  const list = new NCollection_List_TopoDS_Shape();
  for (const shape of shapes) {
    list.Append(shape);
  }

  return list;
}

/**
 * One multi-tool boolean via the BOPAlgo list API. Passing a compound as a
 * boolean operand silently misbehaves in this build; `SetArguments` +
 * `SetTools` is the supported multi-shape path.
 */
function booleanOf(
  Operation: MultiBooleanOperation,
  args: ReadonlyArray<TopoDS_Shape>,
  tools: ReadonlyArray<TopoDS_Shape>,
): TopoDS_Shape {
  const operation = new Operation();
  const argList = shapeList(args);
  const toolList = shapeList(tools);
  operation.SetArguments(argList);
  operation.SetTools(toolList);
  operation.Build();
  const result = operation.Shape();
  operation.delete();
  argList.delete();
  toolList.delete();
  for (const shape of [...args, ...tools]) {
    shape.delete();
  }

  return result;
}

/** `union()` — fuses all arguments into one solid. */
export function fuse(...shapes: TopoDS_Shape[]): TopoDS_Shape {
  const [first, ...rest] = shapes;
  if (!first) {
    throw new Error('fuse() needs at least one shape');
  }

  return rest.length === 0 ? first : booleanOf(BRepAlgoAPI_Fuse, [first], rest);
}

/** `difference()` — subtracts every tool from the base in one boolean. */
export function cut(base: TopoDS_Shape, ...tools: TopoDS_Shape[]): TopoDS_Shape {
  return tools.length === 0 ? base : booleanOf(BRepAlgoAPI_Cut, [base], tools);
}

/** `intersection()` of two solids. */
export function intersect(left: TopoDS_Shape, right: TopoDS_Shape): TopoDS_Shape {
  return booleanOf(BRepAlgoAPI_Common, [left], [right]);
}
