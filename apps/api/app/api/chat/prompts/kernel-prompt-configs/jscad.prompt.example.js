const jscad = require('@jscad/modeling')
const { cylinder, polygon } = jscad.primitives
const { rotateZ } = jscad.transforms
const { extrudeLinear } = jscad.extrusions
const { union, subtract } = jscad.booleans
const { vec2 } = jscad.maths
const { degToRad } = jscad.utils

const getParameterDefinitions = () => [
  { name: 'numTeeth', caption: 'Number of teeth:', type: 'int', initial: 10, min: 5, max: 20 },
  { name: 'circularPitch', caption: 'Circular pitch:', type: 'float', initial: 5 },
  { name: 'pressureAngle', caption: 'Pressure angle:', type: 'float', initial: 20 },
  { name: 'clearance', caption: 'Clearance:', type: 'float', initial: 0.0 },
  { name: 'thickness', caption: 'Thickness:', type: 'float', initial: 5, min: 0 },
  { name: 'centerHoleRadius', caption: 'Center hole:', type: 'float', initial: 2, min: 0 }
]

const main = (params) => {
  let gear = involuteGear(
    params.numTeeth,
    params.circularPitch,
    degToRad(params.pressureAngle),
    params.clearance,
    params.thickness
  )
  if (params.centerHoleRadius > 0) {
    const centerHole = cylinder({
      height: params.thickness,
      radius: params.centerHoleRadius,
      center: [0, 0, params.thickness / 2],
      segments: 16
    })
    gear = subtract(gear, centerHole)
  }
  return gear
}

const involuteGear = (numTeeth, circularPitch, pressureAngle, clearance, thickness) => {
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
  const points = [[0, 0]]
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

  const singleTooth2D = polygon({ points, closed: true })
  const singleTooth3D = extrudeLinear({ height: thickness }, singleTooth2D)

  const allTeeth = []
  for (let j = 0; j < numTeeth; j++) {
    const currentToothAngle = j * 2 * Math.PI / numTeeth
    const rotatedTooth = rotateZ(currentToothAngle, singleTooth3D)
    allTeeth.push(rotatedTooth)
  }

  const rootPoints = []
  const toothAngle = 2 * Math.PI / numTeeth
  const toothCenterAngle = 0.5 * angularToothWidthAtBase
  for (let k = 0; k < numTeeth; k++) {
    const currentAngle = toothCenterAngle + k * toothAngle
    const p1 = vec2.scale(vec2.create(), vec2.fromAngleRadians(vec2.create(), currentAngle), rootRadius)
    rootPoints.push([p1[0], p1[1]])
  }

  const rootCircle2D = polygon({ points: rootPoints, closed: true })
  const rootcircle = extrudeLinear({ height: thickness }, rootCircle2D)

  return union(rootcircle, allTeeth)
}

module.exports = { main, getParameterDefinitions }
