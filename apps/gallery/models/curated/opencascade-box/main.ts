import {
  BRepPrimAPI_MakeBox,
  BRepFilletAPI_MakeFillet,
  ChFi3d_FilletShape,
  TopAbs_ShapeEnum,
  TopExp_Explorer,
  TopoDS,
} from 'libcascade';

export const defaultParams = {
  width: 52,
  depth: 34,
  height: 20,
  fillet: 3,
  profile: 'soft',
};

export const jsonSchema = {
  type: 'object',
  title: 'OpenCascade Box Parameters',
  required: ['width', 'depth', 'height', 'fillet', 'profile'],
  properties: {
    width: { type: 'number', title: 'Width', default: 52, minimum: 10, maximum: 120 },
    depth: { type: 'number', title: 'Depth', default: 34, minimum: 10, maximum: 120 },
    height: { type: 'number', title: 'Height', default: 20, minimum: 5, maximum: 100 },
    fillet: { type: 'number', title: 'Fillet', default: 3, minimum: 0, maximum: 12 },
    profile: {
      type: 'string',
      title: 'Profile',
      default: 'soft',
      enum: ['soft', 'sharp'],
    },
  },
};

export default function main(params = {}) {
  const p = { ...defaultParams, ...params };
  const box = new BRepPrimAPI_MakeBox(p.width, p.depth, p.height).Shape();
  if (p.profile === 'sharp' || p.fillet <= 0) {
    return box;
  }

  const fillet = new BRepFilletAPI_MakeFillet(box, ChFi3d_FilletShape.ChFi3d_Rational);
  const explorer = new TopExp_Explorer(box, TopAbs_ShapeEnum.TopAbs_EDGE, TopAbs_ShapeEnum.TopAbs_SHAPE);

  if (explorer.More()) {
    fillet.Add(p.fillet, TopoDS.Edge(explorer.Current()));
  }

  explorer.delete();
  const result = fillet.Shape();
  fillet.delete();
  return result;
}