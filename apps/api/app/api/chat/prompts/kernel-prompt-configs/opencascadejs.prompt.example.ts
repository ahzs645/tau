import {
  BRepPrimAPI_MakeBox_3,
  BRepPrimAPI_MakeCylinder_3,
  BRepAlgoAPI_Cut,
  Message_ProgressRange,
  gp_Pnt,
  gp_Ax2_4,
  gp_Dir_5,
} from 'opencascade.js';

export const defaultParams = {
  width: 80,
  depth: 40,
  height: 20,
  holeRadius: 6,
  holeSpacing: 0.25,
};

export default function main(p = defaultParams) {
  const body = new BRepPrimAPI_MakeBox_3(
    new gp_Pnt(-p.width / 2, -p.depth / 2, -p.height / 2),
    p.width,
    p.depth,
    p.height,
  );

  const leftAxis = new gp_Ax2_4(new gp_Pnt(-p.width * p.holeSpacing, 0, -p.height / 2 - 1), new gp_Dir_5(0, 0, 1));
  const leftHole = new BRepPrimAPI_MakeCylinder_3(leftAxis, p.holeRadius, p.height + 2);

  const rightAxis = new gp_Ax2_4(new gp_Pnt(p.width * p.holeSpacing, 0, -p.height / 2 - 1), new gp_Dir_5(0, 0, 1));
  const rightHole = new BRepPrimAPI_MakeCylinder_3(rightAxis, p.holeRadius, p.height + 2);

  const cut1 = new BRepAlgoAPI_Cut(body.Shape(), leftHole.Shape(), new Message_ProgressRange());
  const cut2 = new BRepAlgoAPI_Cut(cut1.Shape(), rightHole.Shape(), new Message_ProgressRange());

  try {
    return cut2.Shape();
  } finally {
    for (const obj of [body, leftAxis, leftHole, rightAxis, rightHole, cut1, cut2]) {
      obj.delete();
    }
  }
}
