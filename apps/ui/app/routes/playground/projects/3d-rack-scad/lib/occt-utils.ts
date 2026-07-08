/**
 * Minimal OpenCASCADE helpers for the OpenCASCADE variant of this project.
 *
 * Mirrors the OpenSCAD idioms the original model uses — centered cuboids,
 * frustum dimples, extruded dovetail polygons, `hull()` rounded slots,
 * booleans, transforms — so the ported model reads like the source. Helpers
 * consume their shape inputs (Emscripten objects are freed as soon as a
 * derived shape exists); build a fresh shape per use like an OpenSCAD module
 * call instead of reusing one, or use `translateCopy` for instancing.
 */
import {
  BRepAlgoAPI_Common,
  BRepAlgoAPI_Cut,
  BRepAlgoAPI_Fuse,
  BRepBuilderAPI_MakeFace,
  BRepBuilderAPI_MakePolygon,
  BRepBuilderAPI_Transform,
  BRepPrimAPI_MakeBox,
  BRepPrimAPI_MakeCone,
  BRepPrimAPI_MakeCylinder,
  BRepPrimAPI_MakePrism,
  gp_Ax1,
  gp_Ax2,
  gp_Dir,
  gp_Pnt,
  gp_Trsf,
  gp_Vec,
  NCollection_List_TopoDS_Shape,
} from 'opencascade.js';
import type { TopoDS_Shape } from 'opencascade.js';

export type Vec3 = readonly [number, number, number];
export type Vec2 = readonly [number, number];

const degToRad = (degrees: number): number => (degrees * Math.PI) / 180;

type ShapeMaker = { Shape(): TopoDS_Shape; delete(): void };

/** Run a maker, take its shape, free the maker. */
function shapeOf(maker: ShapeMaker): TopoDS_Shape {
  const shape = maker.Shape();
  maker.delete();
  return shape;
}

/** Axis-aligned box; `center` centers it on the origin in all three axes like `cube(center=true)`. */
export function box(dx: number, dy: number, dz: number, options?: { center?: boolean }): TopoDS_Shape {
  const solid = shapeOf(new BRepPrimAPI_MakeBox(dx, dy, dz));
  return options?.center ? translate(solid, [-dx / 2, -dy / 2, -dz / 2]) : solid;
}

/** Box centered on `center` in x/y/z — `translate(center) cube(size, center=true)`. */
export function boxAt(center: Vec3, dx: number, dy: number, dz: number): TopoDS_Shape {
  return translate(box(dx, dy, dz, { center: true }), center);
}

/** Cylinder along +Z starting at the origin, like `cylinder(r, h)`. */
export function cylinder(radius: number, height: number): TopoDS_Shape {
  return shapeOf(new BRepPrimAPI_MakeCylinder(radius, height));
}

/** Cylinder along +Z centered on `center` — `translate(center) cylinder(r, h, center=true)`. */
export function cylinderAt(center: Vec3, radius: number, height: number): TopoDS_Shape {
  return translate(cylinder(radius, height), [center[0], center[1], center[2] - height / 2]);
}

/** Cylinder along +X centered on `center` — BOSL2's `xcyl(h, r)`. */
export function xcylAt(center: Vec3, radius: number, length: number): TopoDS_Shape {
  const origin = new gp_Pnt(center[0] - length / 2, center[1], center[2]);
  const direction = new gp_Dir(1, 0, 0);
  const axes = new gp_Ax2(origin, direction);
  const solid = shapeOf(new BRepPrimAPI_MakeCylinder(axes, radius, length));
  axes.delete();
  direction.delete();
  origin.delete();
  return solid;
}

/** Conical frustum along +Z starting at the origin — `cylinder(r1, r2, h)`. */
export function cone(bottomRadius: number, topRadius: number, height: number): TopoDS_Shape {
  if (Math.abs(bottomRadius - topRadius) < 1e-9) {
    return cylinder(bottomRadius, height);
  }

  return shapeOf(new BRepPrimAPI_MakeCone(bottomRadius, topRadius, height));
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

/**
 * Through-slot along +X centered on `center`: a rounded rectangle (width along
 * Y, height along Z, corner radius) extruded `length` along X — the original's
 * `hull()` of four corner cylinders, built constructively as two slabs plus
 * four corner rods.
 */
export function roundedSlotX(
  center: Vec3,
  width: number,
  height: number,
  length: number,
  radius: number,
): TopoDS_Shape {
  const [cx, cy, cz] = center;
  const corners: TopoDS_Shape[] = [];
  for (const ySide of [-1, 1]) {
    for (const zSide of [-1, 1]) {
      corners.push(xcylAt([cx, cy + ySide * (width / 2 - radius), cz + zSide * (height / 2 - radius)], radius, length));
    }
  }

  return fuse(
    boxAt(center, length, width - 2 * radius, height),
    boxAt(center, length, width, height - 2 * radius),
    ...corners,
  );
}

function transformed(shape: TopoDS_Shape, applyTo: (transform: gp_Trsf) => void, consume = true): TopoDS_Shape {
  const transform = new gp_Trsf();
  applyTo(transform);
  const operation = new BRepBuilderAPI_Transform(shape, transform, true, false);
  const result = operation.Shape();
  operation.delete();
  transform.delete();
  if (consume) {
    shape.delete();
  }

  return result;
}

export function translate(shape: TopoDS_Shape, offset: Vec3): TopoDS_Shape {
  return transformed(shape, (transform) => {
    const vector = new gp_Vec(offset[0], offset[1], offset[2]);
    transform.SetTranslation(vector);
    vector.delete();
  });
}

/** Non-consuming `translate` for instancing: `shape` stays valid (delete it yourself when done). */
export function translateCopy(shape: TopoDS_Shape, offset: Vec3): TopoDS_Shape {
  return transformed(
    shape,
    (transform) => {
      const vector = new gp_Vec(offset[0], offset[1], offset[2]);
      transform.SetTranslation(vector);
      vector.delete();
    },
    false,
  );
}

function rotated(shape: TopoDS_Shape, axis: Vec3, degrees: number): TopoDS_Shape {
  return transformed(shape, (transform) => {
    const origin = new gp_Pnt(0, 0, 0);
    const direction = new gp_Dir(axis[0], axis[1], axis[2]);
    const rotationAxis = new gp_Ax1(origin, direction);
    transform.SetRotation(rotationAxis, degToRad(degrees));
    rotationAxis.delete();
    direction.delete();
    origin.delete();
  });
}

export function rotateZ(shape: TopoDS_Shape, degrees: number): TopoDS_Shape {
  return rotated(shape, [0, 0, 1], degrees);
}

export function rotateX(shape: TopoDS_Shape, degrees: number): TopoDS_Shape {
  return rotated(shape, [1, 0, 0], degrees);
}

export function rotateY(shape: TopoDS_Shape, degrees: number): TopoDS_Shape {
  return rotated(shape, [0, 1, 0], degrees);
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
