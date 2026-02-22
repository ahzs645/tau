import type { AnyShape, Drawing } from 'replicad';
import type { SetRequired } from 'type-fest';
import type { GeometrySvg } from '@taucad/types';
import { normalizeColor } from '#kernels/replicad/utils/normalize-color.js';
import type { GeometryReplicad } from '#kernels/replicad/replicad.types.js';

type Meshable = SetRequired<AnyShape, 'mesh' | 'meshEdges'>;

type Svgable = SetRequired<Drawing, 'toSVGPaths' | 'toSVGViewBox'>;

export type InputShape = {
  shape: AnyShape;
  name?: string;
  color?: string;
  opacity?: number;
  strokeType?: string;
};

type SvgShapeConfiguration = {
  name: string;
  shape: Svgable;
  color?: string;
  opacity?: number;
  strokeType?: string;
};

type MeshableConfiguration = {
  name: string;
  shape: Meshable;
  color?: string;
  opacity?: number;
};

export type MainResultShapes = AnyShape | AnyShape[] | InputShape | InputShape[] | undefined;

const isSvgable = (shape: unknown): shape is Svgable => {
  return (
    typeof shape === 'object' &&
    shape !== null &&
    Boolean((shape as Svgable).toSVGPaths) &&
    Boolean((shape as Svgable).toSVGViewBox)
  );
};

const isMeshable = (shape: unknown): shape is Meshable => {
  return (
    typeof shape === 'object' &&
    shape !== null &&
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime defensive guard against nullish values
    Boolean((shape as Meshable).mesh && (shape as Meshable).meshEdges)
  );
};

const isInputShape = (shape: unknown): shape is InputShape => {
  return typeof shape === 'object' && shape !== null && Boolean((shape as InputShape).shape);
};

function createBasicShapeConfig(
  inputShapes: MainResultShapes,
  baseName = 'AnyShape',
): Array<InputShape & { name: string }> {
  // We accept a single shape or an array of shapes
  const raw: Array<AnyShape | InputShape | undefined> = Array.isArray(inputShapes) ? inputShapes : [inputShapes];

  // Filter out nullish entries (e.g., from main() returning undefined)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime values can be nullish despite types
  const shapes = raw.filter((shape): shape is AnyShape | InputShape => shape !== null && shape !== undefined);

  return shapes
    .map((inputShape) => {
      if (isInputShape(inputShape)) {
        return inputShape;
      }

      return {
        shape: inputShape,
      };
    })
    .map((inputShape, index_) => {
      // We accept unamed shapes
      const { name, ...rest } = inputShape;
      const index = shapes.length > 1 ? ` ${index_}` : '';

      return {
        name: name ?? `${baseName} ${index}`,
        ...rest,
      };
    });
}

function normalizeColorAndOpacity<T extends InputShape>(shape: T): InputShape {
  const { color, opacity, ...rest } = shape;

  const normalizedColor: undefined | { color: string; alpha: number } = color ? normalizeColor(color) : undefined;
  let configuredOpacity: undefined | number = opacity;
  if (normalizedColor && normalizedColor.alpha !== 1) {
    configuredOpacity = opacity ?? normalizedColor.alpha;
  }

  return {
    ...rest,
    color: normalizedColor?.color,
    opacity: configuredOpacity,
  };
}

function renderSvg(shapeConfig: SvgShapeConfiguration): GeometrySvg {
  const { name, shape, color, strokeType, opacity } = shapeConfig;
  return {
    format: 'svg',
    name,
    color,
    strokeType,
    opacity,
    paths: shape.toSVGPaths() as string[],
    viewbox: shape.toSVGViewBox(),
  };
}

function renderMesh(shapeConfig: MeshableConfiguration) {
  const { name, shape, color, opacity } = shapeConfig;
  const geometry: GeometryReplicad = {
    format: 'replicad',
    name,
    color,
    opacity,
    faces: {
      triangles: [],
      vertices: [],
      normals: [],
      faceGroups: [],
    },
    edges: {
      lines: [],
      edgeGroups: [],
    },
  };

  geometry.faces = shape.mesh({
    tolerance: 0.1,
    angularTolerance: 30,
  });
  geometry.edges = shape.meshEdges({
    tolerance: 0.1,
    angularTolerance: 30,
  });

  return geometry;
}

export function render(shapes: InputShape[]): Array<GeometrySvg | GeometryReplicad> {
  return shapes.map((shapeConfig) => {
    if (isSvgable(shapeConfig.shape)) {
      // TODO: fix this type
      return renderSvg(shapeConfig as unknown as SvgShapeConfiguration);
    }

    if (isMeshable(shapeConfig.shape)) {
      // TODO: fix this type
      return renderMesh(shapeConfig as unknown as MeshableConfiguration);
    }

    throw new Error('Invalid shape');
  });
}

export function renderOutput(
  shapes: MainResultShapes,
  beforeRender?: (shapes: InputShape[]) => InputShape[],
  defaultName = 'AnyShape',
): Array<GeometrySvg | GeometryReplicad> {
  const baseShape = createBasicShapeConfig(shapes, defaultName).map((element) => normalizeColorAndOpacity(element));

  const config = beforeRender ? beforeRender(baseShape) : baseShape;

  return render(config);
}
