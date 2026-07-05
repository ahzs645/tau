/**
 * Minimal OpenCASCADE helpers for the OpenCASCADE variant of this project.
 *
 * Mirrors the OpenSCAD idioms the original model uses — centered cubes,
 * `$fn=6` hex cylinders, `hull()` capsules, booleans, transforms — so the
 * ported model reads like the source. Helpers consume their shape inputs
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
  BRepPrimAPI_MakeCone,
  BRepPrimAPI_MakeCylinder,
  BRepPrimAPI_MakePrism,
  BRepPrimAPI_MakeRevol,
  BRepPrimAPI_MakeSphere,
  BRepPrimAPI_MakeTorus,
  BRepOffsetAPI_ThruSections,
  gp_Ax1,
  gp_Ax2,
  gp_Dir,
  gp_Pnt,
  gp_Trsf,
  gp_Vec,
  NCollection_List_TopoDS_Shape,
} from 'opencascade.js';
import type { TopoDS_Shape, TopoDS_Wire } from 'opencascade.js';

export type Vec3 = readonly [number, number, number];

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

/** Conical frustum along +Z starting at the origin — `cylinder(r1, r2, h)`. */
export function cone(bottomRadius: number, topRadius: number, height: number): TopoDS_Shape {
  if (Math.abs(bottomRadius - topRadius) < 1e-9) {
    return cylinder(bottomRadius, height);
  }

  return shapeOf(new BRepPrimAPI_MakeCone(bottomRadius, topRadius, height));
}

/** Ruled polygonal frustum matching OpenSCAD `cylinder(d1, d2, $fn=sides)`. */
export function facetedCone(bottomRadius: number, topRadius: number, height: number, sides: number): TopoDS_Shape {
  if (sides < 3) {
    throw new Error('facetedCone() needs at least 3 sides');
  }

  const bottom = regularWire(bottomRadius, 0, sides);
  const top = regularWire(topRadius, height, sides);
  const loft = new BRepOffsetAPI_ThruSections(true, true, 1e-6);
  loft.AddWire(bottom);
  loft.AddWire(top);
  loft.Build();
  const shape = loft.Shape();
  loft.delete();
  bottom.delete();
  top.delete();
  return shape;
}

function regularWire(radius: number, z: number, sides: number): TopoDS_Wire {
  const polygon = new BRepBuilderAPI_MakePolygon();
  for (let index = 0; index < sides; index += 1) {
    const angle = degToRad((index * 360) / sides);
    const point = new gp_Pnt(radius * Math.cos(angle), radius * Math.sin(angle), z);
    polygon.Add(point);
    point.delete();
  }

  polygon.Close();
  const wire = polygon.Wire();
  polygon.delete();
  return wire;
}

/**
 * Regular polygonal prism along +Z — OpenSCAD's `cylinder(d, h, $fn=sides)`.
 * OpenSCAD places vertices on the circumscribed circle starting at angle 0,
 * so `circumradius` is `d / 2` and `rotateDeg` matches a wrapping `rotate()`.
 */
export function regularPrism(circumradius: number, height: number, sides: number, rotateDeg = 0): TopoDS_Shape {
  const polygon = new BRepBuilderAPI_MakePolygon();
  for (let index = 0; index < sides; index += 1) {
    const angle = degToRad(rotateDeg + (index * 360) / sides);
    const point = new gp_Pnt(circumradius * Math.cos(angle), circumradius * Math.sin(angle), 0);
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

/** Sphere of the given diameter centered on `center`. */
export function sphereAt(center: Vec3, diameter: number): TopoDS_Shape {
  const centerPoint = new gp_Pnt(center[0], center[1], center[2]);
  const solid = shapeOf(new BRepPrimAPI_MakeSphere(centerPoint, diameter / 2));
  centerPoint.delete();
  return solid;
}

/** Torus around +Z centered on `center` — `rotate_extrude() translate([major, 0]) circle(minor)`. */
export function torusAt(center: Vec3, majorRadius: number, minorRadius: number): TopoDS_Shape {
  return translate(shapeOf(new BRepPrimAPI_MakeTorus(majorRadius, minorRadius)), center);
}

/**
 * Capsule (spherocylinder) between two points — `hull()` of two spheres of
 * the given diameter, which OpenSCAD models use for finger holes.
 */
export function capsule(from: Vec3, to: Vec3, diameter: number): TopoDS_Shape {
  const radius = diameter / 2;
  const [dx, dy, dz] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const length = Math.hypot(dx, dy, dz);
  const caps = [sphereAt(from, diameter), sphereAt(to, diameter)];
  if (length < 1e-9) {
    return caps[1] ? fuse(...caps) : caps[0]!;
  }

  const origin = new gp_Pnt(from[0], from[1], from[2]);
  const direction = new gp_Dir(dx / length, dy / length, dz / length);
  const axes = new gp_Ax2(origin, direction);
  const body = shapeOf(new BRepPrimAPI_MakeCylinder(axes, radius, length));
  axes.delete();
  direction.delete();
  origin.delete();
  return fuse(body, ...caps);
}

/**
 * Vertical wall following a polyline, with rounded (stadium) ends — the
 * `wall()` idiom of hulled thin cylinders. Each point is `[x, y, height]`.
 */
export function stadiumWall(points: ReadonlyArray<Vec3>, radius: number): TopoDS_Shape {
  const segments: TopoDS_Shape[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x1, y1, h1] = points[index]!;
    const [x2, y2, h2] = points[index + 1]!;
    const height = Math.max(h1, h2);
    const length = Math.hypot(x2 - x1, y2 - y1);
    segments.push(translate(cylinder(radius, h1), [x1, y1, 0]), translate(cylinder(radius, h2), [x2, y2, 0]));
    if (length > 1e-9) {
      const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
      const slab = boxAt([length / 2, 0, height / 2], length, radius * 2, height);
      segments.push(translate(rotateZ(slab, angle), [x1, y1, 0]));
    }
  }

  return fuse(...segments);
}

/**
 * Revolve a closed polygon profile around the Z axis — `rotate_extrude()`
 * over `polygon(points)`, with profile points given as `[radius, z]`.
 */
export function revolveZ(profile: ReadonlyArray<readonly [number, number]>): TopoDS_Shape {
  const polygon = new BRepBuilderAPI_MakePolygon();
  for (const [radius, z] of profile) {
    const point = new gp_Pnt(radius, 0, z);
    polygon.Add(point);
    point.delete();
  }

  polygon.Close();
  const wire = polygon.Wire();
  const faceMaker = new BRepBuilderAPI_MakeFace(wire, true);
  const face = faceMaker.Face();
  const origin = new gp_Pnt(0, 0, 0);
  const zDirection = new gp_Dir(0, 0, 1);
  const axis = new gp_Ax1(origin, zDirection);
  const solid = shapeOf(new BRepPrimAPI_MakeRevol(face, axis, false));
  axis.delete();
  zDirection.delete();
  origin.delete();
  face.delete();
  faceMaker.delete();
  wire.delete();
  polygon.delete();
  return solid;
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
