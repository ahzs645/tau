import type { AnyShape, Drawing } from 'replicad';
import type { SetRequired } from 'type-fest';
import type { GeometrySvg } from '@taucad/types';
import { normalizeColor } from '#kernels/replicad/utils/normalize-color.js';
import type { GeometryReplicad } from '#kernels/replicad/replicad.types.js';

type Tessellation = {
  linearTolerance: number;
  angularTolerance: number;
};

type Meshable = SetRequired<AnyShape, 'mesh' | 'meshEdges'>;

type Svgable = SetRequired<Drawing, 'toSVGPaths' | 'toSVGViewBox'>;

/**
 * A shape with optional display and material metadata for rendering.
 *
 * Returned from a Replicad model's `main()` function to control per-shape
 * appearance in both GLTF preview rendering and STEP export.
 *
 * @public
 *
 * @example <caption>Shape with PBR material properties</caption>
 * ```typescript
 * import { makeCylinder } from 'replicad';
 *
 * export default function main() {
 *   return {
 *     shape: makeCylinder(10, 30),
 *     color: '#C0C0C0',
 *     metalness: 0.9,
 *     roughness: 0.2,
 *     density: 7.85,
 *   };
 * }
 * ```
 */
export type InputShape = {
  shape: AnyShape;
  name?: string;
  /** CSS hex color string (e.g. `'#ff0000'`). Applied to GLTF baseColor and STEP surface color. */
  color?: string;
  /** Opacity from 0 (transparent) to 1 (opaque). Maps to GLTF alpha and STEP transparency. */
  opacity?: number;
  strokeType?: string;
  /** PBR metalness factor (0 = dielectric, 1 = metal). Threaded to GLTF metallicFactor and STEP visual material. */
  metalness?: number;
  /** PBR roughness factor (0 = mirror, 1 = diffuse). Threaded to GLTF roughnessFactor and STEP visual material. */
  roughness?: number;
  /** Physical density in g/cm³. Written to STEP as XCAFDoc_Material for mass computation. */
  density?: number;
};

type SvgShapeConfiguration = InputShape & { shape: Svgable };

type MeshableConfiguration = InputShape & { shape: Meshable };

/** Union of all valid return types from a Replicad model's main function. */
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
    // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime defensive guard against nullish values
    Boolean((shape as Meshable).mesh && (shape as Meshable).meshEdges)
  );
};

const hasSvgableShape = (config: InputShape): config is SvgShapeConfiguration => isSvgable(config.shape);

const hasMeshableShape = (config: InputShape): config is MeshableConfiguration => isMeshable(config.shape);

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
  // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime values can be nullish despite types
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
  const { name = 'Shape', shape, color, strokeType, opacity } = shapeConfig;
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

const defaultPreviewTessellation: Tessellation = {
  linearTolerance: 0.1,
  angularTolerance: 30,
};

function renderMesh(shapeConfig: MeshableConfiguration, tessellation: Tessellation, withBrepEdges: boolean) {
  const { name = 'Shape', shape, color, opacity, metalness, roughness } = shapeConfig;
  const geometry: GeometryReplicad = {
    format: 'replicad',
    name,
    color,
    opacity,
    metalness,
    roughness,
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

  const angularToleranceRad = tessellation.angularTolerance * (Math.PI / 180);

  geometry.faces = shape.mesh({
    tolerance: tessellation.linearTolerance,
    angularTolerance: angularToleranceRad,
  });

  if (withBrepEdges) {
    geometry.edges = shape.meshEdges({
      tolerance: tessellation.linearTolerance,
      angularTolerance: angularToleranceRad,
    });
  }

  return geometry;
}

/**
 * Renders an array of input shapes into geometry representations.
 *
 * @param shapes - The shapes to render with optional color/name metadata
 * @param tessellation - Tessellation quality settings (defaults to preview quality)
 * @param withBrepEdges - Whether to include BRep edge lines in the output
 * @returns An array of SVG or Replicad geometry objects
 */
export function render(
  shapes: InputShape[],
  tessellation: Tessellation = defaultPreviewTessellation,
  withBrepEdges = false,
): Array<GeometrySvg | GeometryReplicad> {
  return shapes.map((shapeConfig) => {
    if (hasSvgableShape(shapeConfig)) {
      return renderSvg(shapeConfig);
    }

    if (hasMeshableShape(shapeConfig)) {
      return renderMesh(shapeConfig, tessellation, withBrepEdges);
    }

    throw new Error('Invalid shape');
  });
}

/**
 * Normalizes, optionally transforms, and renders shapes from a model's main function output.
 *
 * @param options - Shapes, optional beforeRender, defaultName, tessellation, and withBrepEdges
 * @returns An array of SVG or Replicad geometry objects
 */
export function renderOutput({
  shapes,
  beforeRender,
  defaultName = 'AnyShape',
  tessellation,
  withBrepEdges = false,
}: {
  shapes: MainResultShapes;
  beforeRender?: (shapes: InputShape[]) => InputShape[];
  defaultName?: string;
  tessellation?: Tessellation;
  withBrepEdges?: boolean;
}): Array<GeometrySvg | GeometryReplicad> {
  const baseShape = createBasicShapeConfig(shapes, defaultName).map((element) => normalizeColorAndOpacity(element));

  const config = beforeRender ? beforeRender(baseShape) : baseShape;

  return render(config, tessellation, withBrepEdges);
}
