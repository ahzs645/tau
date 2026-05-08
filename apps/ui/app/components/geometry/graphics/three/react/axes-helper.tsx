import * as THREE from 'three';
import { Line } from '@react-three/drei';
import React, { Fragment } from 'react';
import { LineGeometry } from 'three/addons';
import { Line2 as Line2WebGpu } from 'three/addons/lines/webgpu/Line2.js';
import { Line2NodeMaterial } from '#components/geometry/graphics/three/materials/line2.material.js';
import { axesHelperColors, axesHelperOpacity } from '#components/geometry/graphics/three/overlay-colors.constants.js';
import { useThreeGraphicsBackend } from '#components/geometry/graphics/three/three-graphics-backend-context.js';
import { sceneTag, sceneTagData } from '#components/geometry/graphics/three/utils/scene-tags.js';
import { topMostRenderOrder } from '#components/geometry/graphics/three/utils/render-order.utils.js';

/** Local +X axis used to orient pick hitboxes along arbitrary axis rays. */
const canonicalAxisDirection = new THREE.Vector3(1, 0, 0);

type CustomAxesHelperProps = {
  /**
   * The size of the axes
   * @default 5000
   */
  readonly size?: number;
  /**
   * The color of the X axis
   * @default 'red'
   */
  readonly xAxisColor?: string;
  /**
   * The color of the Y axis
   * @default 'green'
   */
  readonly yAxisColor?: string;
  /**
   * The color of the Z axis
   * @default 'blue'
   */
  readonly zAxisColor?: string;
  /**
   * The thickness of the axes
   * @default 5
   */
  readonly thickness?: number;
  /**
   * The thickness of the axes when hovered
   * @default 2
   */
  readonly hoverThickness?: number;
};

type AxisSegmentDefinition = Readonly<{
  color: string;
  id: 'x' | 'y' | 'z';
  negativeEnd: THREE.Vector3;
  origin: THREE.Vector3;
  positiveEnd: THREE.Vector3;
}>;

function axisPickRadial(length: number, thickness: number): number {
  return Math.min(Math.max(length * 0.004, thickness * 16, 6), length * 0.06);
}

type AxisPickHitboxProps = Readonly<{
  length: number;
  midpoint: readonly [number, number, number];
  quaternion: THREE.Quaternion;
  radial: number;
  renderOrder: number;
  onPointerOut: () => void;
  onPointerOver: () => void;
}>;

function AxisPickHitbox({
  length,
  midpoint,
  quaternion,
  radial,
  renderOrder,
  onPointerOut,
  onPointerOver,
}: AxisPickHitboxProps): React.JSX.Element {
  return (
    // oxlint-disable-next-line tau-lint/no-hardcoded-color -- invisible raycast hull
    <mesh
      quaternion={quaternion}
      position={midpoint}
      renderOrder={renderOrder}
      visible
      onPointerOut={(event) => {
        event.stopPropagation();
        onPointerOut();
      }}
      onPointerOver={(event) => {
        event.stopPropagation();
        onPointerOver();
      }}
    >
      <boxGeometry args={[length, radial, radial]} />
      {/* oxlint-disable-next-line tau-lint/no-hardcoded-color -- fully transparent hull; diffuse color irrelevant */}
      <meshBasicMaterial depthTest={false} depthWrite={false} opacity={0} transparent />
    </mesh>
  );
}

function AxesWebGpuFatLine({
  sx,
  sy,
  sz,
  ex,
  ey,
  ez,
  color,
  linewidth,
  opacity,
}: Readonly<{
  color: string;
  ex: number;
  ey: number;
  ez: number;
  linewidth: number;
  opacity: number;
  sx: number;
  sy: number;
  sz: number;
}>): React.JSX.Element {
  const fatLineObject = React.useMemo(() => {
    const geometry = new LineGeometry();
    geometry.setPositions([sx, sy, sz, ex, ey, ez]);

    const material = new Line2NodeMaterial({
      color: new THREE.Color(color),
      depthTest: true,
      depthWrite: false,
      linewidth,
      opacity,
      transparent: true,
      worldUnits: false,
    });

    return new Line2WebGpu(geometry, material);
  }, [sx, sy, sz, ex, ey, ez, color, linewidth, opacity]);

  React.useEffect(
    () => () => {
      fatLineObject.geometry.dispose();
      fatLineObject.material.dispose();
    },
    [fatLineObject],
  );

  return <primitive object={fatLineObject} renderOrder={topMostRenderOrder} />;
}

export function AxesHelper({
  size = 50_000,
  xAxisColor = axesHelperColors.x,
  yAxisColor = axesHelperColors.y,
  zAxisColor = axesHelperColors.z,
  thickness = 1.25,
  hoverThickness = 2,
}: CustomAxesHelperProps): React.JSX.Element {
  const [hoveredAxis, setHoveredAxis] = React.useState<'x' | 'y' | 'z' | undefined>(undefined);
  const graphicsBackend = useThreeGraphicsBackend();

  const axes = React.useMemo(
    () =>
      [
        {
          color: xAxisColor,
          id: 'x',
          negativeEnd: new THREE.Vector3(-size, 0, 0),
          origin: new THREE.Vector3(0, 0, 0),
          positiveEnd: new THREE.Vector3(size, 0, 0),
        },
        {
          color: yAxisColor,
          id: 'y',
          negativeEnd: new THREE.Vector3(0, -size, 0),
          origin: new THREE.Vector3(0, 0, 0),
          positiveEnd: new THREE.Vector3(0, size, 0),
        },
        {
          color: zAxisColor,
          id: 'z',
          negativeEnd: new THREE.Vector3(0, 0, -size),
          origin: new THREE.Vector3(0, 0, 0),
          positiveEnd: new THREE.Vector3(0, 0, size),
        },
      ] satisfies readonly AxisSegmentDefinition[],
    [size, xAxisColor, yAxisColor, zAxisColor],
  );

  return (
    <group userData={sceneTagData(sceneTag.previewOnly)}>
      {axes.map((axis) => {
        const isHovered = hoveredAxis === axis.id;
        const start = isHovered ? axis.negativeEnd : axis.origin;
        const end = axis.positiveEnd;

        const length = start.distanceTo(end);
        const midpointVector = start.clone().add(end).multiplyScalar(0.5);
        const direction = end.clone().sub(start).normalize();
        const pickQuaternion = new THREE.Quaternion().setFromUnitVectors(canonicalAxisDirection, direction);

        const sx = start.x;
        const sy = start.y;
        const sz = start.z;
        const ex = end.x;
        const ey = end.y;
        const ez = end.z;

        const pickRadial = axisPickRadial(length, thickness);

        return (
          <Fragment key={axis.id}>
            {graphicsBackend === 'webgpu' ? (
              <AxesWebGpuFatLine
                color={axis.color}
                ex={ex}
                ey={ey}
                ez={ez}
                linewidth={isHovered ? hoverThickness : thickness}
                opacity={axesHelperOpacity}
                sx={sx}
                sy={sy}
                sz={sz}
              />
            ) : (
              <Line
                color={axis.color}
                lineWidth={isHovered ? hoverThickness : thickness}
                opacity={axesHelperOpacity}
                points={[start, end]}
                renderOrder={topMostRenderOrder}
                transparent
              />
            )}
            <AxisPickHitbox
              length={length}
              midpoint={[midpointVector.x, midpointVector.y, midpointVector.z]}
              quaternion={pickQuaternion}
              radial={pickRadial}
              renderOrder={topMostRenderOrder}
              onPointerOut={() => {
                setHoveredAxis(undefined);
              }}
              onPointerOver={() => {
                setHoveredAxis(axis.id);
              }}
            />
          </Fragment>
        );
      })}
    </group>
  );
}
