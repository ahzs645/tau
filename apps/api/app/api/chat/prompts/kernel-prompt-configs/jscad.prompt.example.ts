import jscad from '@jscad/modeling'
const { cylinder, polygon } = jscad.primitives;
const { rotateZ } = jscad.transforms;
const { extrudeLinear } = jscad.extrusions;
const { union, subtract } = jscad.booleans;
const { vec2 } = jscad.maths;
const { degToRad } = jscad.utils;

type Vec2 = jscad.maths.vec2.Vec2;
type Geom3 = jscad.geometries.geom3.Geom3;

export const defaultParams = {
  numTeeth: 10,
  circularPitch: 5,
  pressureAngle: 20,
  clearance: 0.0,
  thickness: 5,
  centerHoleRadius: 2
}

export default function main(p = defaultParams): Geom3 {
  let gear = involuteGear(
    p.numTeeth,
    p.circularPitch,
    degToRad(p.pressureAngle),
    p.clearance,
    p.thickness
  )
  if (p.centerHoleRadius > 0) {
    const centerHole = cylinder({
      height: p.thickness,
      radius: p.centerHoleRadius,
      center: [0, 0, p.thickness / 2],
      segments: 16
    })
    gear = subtract(gear, centerHole)
  }
  return gear
}

const involuteGear = (numTeeth: number, circularPitch: number, pressureAngle: number, clearance: number, thickness: number): Geom3 => {
  const addendum = circularPitch / Math.PI
  const dedendum = addendum + clearance

  const pitchRadius = numTeeth * circularPitch / (2 * Math.PI)
  const baseRadius = pitchRadius * Math.cos(pressureAngle)
  const outerRadius = pitchRadius + addendum
  const rootRadius = pitchRadius - dedendum

  const maxTanLength = Math.sqrt(outerRadius * outerRadius - baseRadius * baseRadius)
  const maxAngle = maxTanLength / baseRadius

  const tlAtPitchCircle = Math.sqrt(pitchRadius * pitchRadius - baseRadius * baseRadius)
  const angleAtPitchCircle = tlAtPitchCircle / baseRadius
  const diffAngle = angleAtPitchCircle - Math.atan(angleAtPitchCircle)
  const angularToothWidthAtBase = (Math.PI / numTeeth) + (2 * diffAngle)

  const toothCurveResolution = 5
  const points: [number, number][] = [[0, 0]]
  for (let i = 0; i <= toothCurveResolution; i++) {
    const angle = maxAngle * Math.pow(i / toothCurveResolution, 2 / 3)
    const tanLength = angle * baseRadius
    let radiantVector = vec2.fromAngleRadians(vec2.create(), angle)
    let tangentVector = vec2.scale(vec2.create(), vec2.normal(vec2.create(), radiantVector), -tanLength)
    radiantVector = vec2.scale(vec2.create(), radiantVector, baseRadius)
    points[i + 1] = [radiantVector[0] + tangentVector[0], radiantVector[1] + tangentVector[1]]

    radiantVector = vec2.fromAngleRadians(vec2.create(), angularToothWidthAtBase - angle)
    tangentVector = vec2.scale(vec2.create(), vec2.normal(vec2.create(), radiantVector), tanLength)
    radiantVector = vec2.scale(vec2.create(), radiantVector, baseRadius)
    points[(2 * toothCurveResolution) + 2 - i] = [radiantVector[0] + tangentVector[0], radiantVector[1] + tangentVector[1]]
  }

  const singleTooth2D = polygon({ points })
  const singleTooth3D = extrudeLinear({ height: thickness }, singleTooth2D)

  const allTeeth: Geom3[] = []
  for (let j = 0; j < numTeeth; j++) {
    const currentToothAngle = j * 2 * Math.PI / numTeeth
    const rotatedTooth = rotateZ(currentToothAngle, singleTooth3D)
    allTeeth.push(rotatedTooth)
  }

  const rootPoints: Vec2[] = []
  const toothAngle = 2 * Math.PI / numTeeth
  const toothCenterAngle = 0.5 * angularToothWidthAtBase
  for (let k = 0; k < numTeeth; k++) {
    const currentAngle = toothCenterAngle + k * toothAngle
    const p1 = vec2.scale(vec2.create(), vec2.fromAngleRadians(vec2.create(), currentAngle), rootRadius)
    rootPoints.push([p1[0], p1[1]] as Vec2)
  }

  const rootCircle2D = polygon({ points: rootPoints })
  const rootcircle = extrudeLinear({ height: thickness }, rootCircle2D)

  return union(rootcircle, allTeeth)
}
