/** Geometry helpers from the gallery vane-trap project. Operations consume their input shapes. */
import {
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
} from 'libcascade';
import type { TopoDS_Shape } from 'libcascade';

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
