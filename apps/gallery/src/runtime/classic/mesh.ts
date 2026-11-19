import {
  detectEdges,
  formatShapeName,
  srgbTupleToLinear,
  transformNormalArray,
  transformVertexArray,
  writeGlb,
} from '@taucad/geometry-core';
import type { GeometryOutputTransformOptions, GlbNode, GlbPrimitive } from '@taucad/geometry-core';
import { cadEdgeOverlayMaterialDefaults, cadMaterialDefaults } from '@taucad/runtime/types';
import { classicCanonicalSurface } from '#runtime/classic/canonical.js';

type Point = readonly [number, number, number];
type Color = readonly [number, number, number, number];
type ClassicTriangle = Readonly<{ indices: readonly [number, number, number]; color: Color }>;

/** Native OpenSCAD OFF positions are Z-up millimetres; face colors are normalized sRGB RGBA. */
export type ClassicMesh = Readonly<{
  vertices: readonly Point[];
  triangles: readonly ClassicTriangle[];
}>;

type MeshOptions = Readonly<{
  includeEdges?: boolean;
  coordinateSystem?: 'y-up' | 'z-up';
  unit?: 'meter' | 'millimeter';
}>;

const finiteNumber = (token: string | undefined, label: string): number => {
  if (token === undefined || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(token)) {
    throw new TypeError(`Invalid OFF ${label}: expected a finite decimal number.`);
  }
  const value = Number(token);
  if (!Number.isFinite(value)) {
    throw new RangeError(`Invalid OFF ${label}: expected a finite decimal number.`);
  }
  return value;
};

const nonnegativeInteger = (token: string | undefined, label: string): number => {
  if (token === undefined || !/^\d+$/u.test(token)) {
    throw new TypeError(`Invalid OFF ${label}: expected a nonnegative integer.`);
  }
  const value = Number(token);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Invalid OFF ${label}: integer is outside the safe range.`);
  }
  return value;
};

const itemAt = <Item>(items: readonly Item[], index: number): Item => {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`Invalid OFF reference at index ${index}.`);
  }
  return item;
};

const subtract = (left: Point, right: Point): Point => [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
const cross = (left: Point, right: Point): Point => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];
const dot = (left: Point, right: Point): number => left[0] * right[0] + left[1] * right[1] + left[2] * right[2];

const triangleNormal = (vertices: readonly Point[], indices: ClassicTriangle['indices']): Point => {
  const [a, b, c] = indices.map((index) => itemAt(vertices, index));
  if (!a || !b || !c) {
    throw new RangeError('Invalid OFF triangle: three vertices are required.');
  }
  const normal = cross(subtract(b, a), subtract(c, a));
  const length = Math.hypot(...normal);
  if (!Number.isFinite(length) || length === 0) {
    throw new RangeError('Invalid OFF triangle: face has no finite nonzero area.');
  }
  return [normal[0] / length, normal[1] / length, normal[2] / length];
};

const parseColor = (tokens: readonly string[]): Color => {
  if (tokens.length === 0) {
    return [1, 1, 1, 1];
  }
  if (tokens.length !== 3 && tokens.length !== 4) {
    throw new RangeError('Invalid OFF face color: expected RGB or RGBA.');
  }
  const channels = tokens.map((token) => finiteNumber(token, 'face color'));
  // Original OpenSCAD OFF uses integer bytes. All-integer 0/1 tuples are ambiguous,
  // so only explicitly floating-point tuples in [0,1] select normalized color.
  const normalized =
    channels.every((channel) => channel >= 0 && channel <= 1) && tokens.some((token) => /[.eE]/u.test(token));
  const divisor = normalized ? 1 : 255;
  if (channels.some((channel) => channel < 0 || channel > divisor || (!normalized && !Number.isInteger(channel)))) {
    throw new RangeError('Invalid OFF face color: use integer bytes or an explicit normalized RGB/RGBA tuple.');
  }
  return [
    itemAt(channels, 0) / divisor,
    itemAt(channels, 1) / divisor,
    itemAt(channels, 2) / divisor,
    (channels[3] ?? divisor) / divisor,
  ];
};

const assertConvexPolygon = (vertices: readonly Point[], indices: readonly number[], normal: Point): void => {
  const points = indices.map((index) => itemAt(vertices, index));
  const origin = itemAt(points, 0);
  const extent = Math.max(...points.map((point) => Math.hypot(...subtract(point, origin))));
  const distanceTolerance = Math.max(1, extent) * 1e-8;
  if (points.some((point) => Math.abs(dot(subtract(point, origin), normal)) > distanceTolerance)) {
    throw new RangeError('Invalid OFF polygon: fan triangulation requires a planar face.');
  }
  for (const [index, point] of points.entries()) {
    const next = itemAt(points, (index + 1) % points.length);
    const edge = subtract(next, point);
    if (
      points.some(
        (candidate) => dot(cross(edge, subtract(candidate, point)), normal) < -distanceTolerance * Math.max(1, extent),
      )
    ) {
      throw new RangeError('Invalid OFF polygon: fan triangulation requires a convex face in boundary order.');
    }
  }
};

const parseFace = (line: string, vertices: readonly Point[]): ClassicTriangle[] => {
  const tokens = line.split(/\s+/u);
  const count = nonnegativeInteger(tokens[0], 'face vertex count');
  if (count < 3 || tokens.length < count + 1) {
    throw new RangeError('Invalid OFF face: at least three complete vertex references are required.');
  }
  const indices = tokens.slice(1, count + 1).map((token) => nonnegativeInteger(token, 'vertex index'));
  if (indices.some((index) => index >= vertices.length) || new Set(indices).size !== indices.length) {
    throw new RangeError('Invalid OFF face: vertex indices are missing or repeated.');
  }
  const color = parseColor(tokens.slice(count + 1));
  const first: ClassicTriangle['indices'] = [itemAt(indices, 0), itemAt(indices, 1), itemAt(indices, 2)];
  const normal = triangleNormal(vertices, first);
  if (count > 3) {
    assertConvexPolygon(vertices, indices, normal);
  }
  const triangles: ClassicTriangle[] = [];
  for (let index = 1; index < count - 1; index += 1) {
    const triangle: ClassicTriangle = {
      indices: [first[0], itemAt(indices, index), itemAt(indices, index + 1)],
      color,
    };
    triangleNormal(vertices, triangle.indices);
    triangles.push(triangle);
  }
  return triangles;
};

/** Parse native OFF without repairing faces, guessing colors, or discarding malformed records. */
export const parseClassicOff = (text: string): ClassicMesh => {
  const lines = text
    .split(/\r\n|\n|\r/u)
    .map((line) => line.replace(/#.*$/u, '').trim())
    .filter(Boolean);
  const header = lines[0]?.split(/\s+/u);
  if (header?.[0] !== 'OFF') {
    throw new TypeError('Invalid OFF file: missing OFF header.');
  }
  const separateCounts = header.length === 1;
  const counts = separateCounts ? lines[1]?.split(/\s+/u) : header.slice(1);
  if (counts?.length !== 3) {
    throw new RangeError('Invalid OFF file: expected vertex, face and edge counts.');
  }
  const vertexCount = nonnegativeInteger(counts[0], 'vertex count');
  const faceCount = nonnegativeInteger(counts[1], 'face count');
  nonnegativeInteger(counts[2], 'edge count');
  const start = separateCounts ? 2 : 1;
  if (lines.length !== start + vertexCount + faceCount) {
    throw new RangeError('Invalid OFF file: declared counts do not match complete vertex and face records.');
  }
  const vertices: Point[] = [];
  for (let index = 0; index < vertexCount; index += 1) {
    const tokens = itemAt(lines, start + index).split(/\s+/u);
    if (tokens.length !== 3) {
      throw new RangeError(`Invalid OFF vertex ${index}: expected exactly three coordinates.`);
    }
    vertices.push([
      finiteNumber(tokens[0], 'vertex'),
      finiteNumber(tokens[1], 'vertex'),
      finiteNumber(tokens[2], 'vertex'),
    ]);
  }
  const triangles: ClassicTriangle[] = [];
  for (let index = 0; index < faceCount; index += 1) {
    triangles.push(...parseFace(itemAt(lines, start + vertexCount + index), vertices));
  }
  return { vertices, triangles };
};

const splitBodies = (mesh: ClassicMesh): ClassicTriangle[][] => {
  const parents = mesh.vertices.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (itemAt(parents, root) !== root) {
      root = itemAt(parents, root);
    }
    let current = index;
    while (current !== root) {
      const next = itemAt(parents, current);
      parents[current] = root;
      current = next;
    }
    return root;
  };
  for (const triangle of mesh.triangles) {
    const [a, b, c] = triangle.indices;
    parents[find(b)] = find(a);
    parents[find(c)] = find(a);
  }
  const bodies = new Map<number, ClassicTriangle[]>();
  for (const triangle of mesh.triangles) {
    const root = find(triangle.indices[0]);
    const body = bodies.get(root);
    if (body) {
      body.push(triangle);
    } else {
      bodies.set(root, [triangle]);
    }
  }
  return [...bodies.values()];
};

const surfacePrimitive = (
  vertices: readonly Point[],
  triangles: readonly ClassicTriangle[],
  transform: GeometryOutputTransformOptions,
): GlbPrimitive => {
  const sourcePositions = new Float64Array(triangles.length * 9);
  const sourceNormals = new Float64Array(sourcePositions.length);
  for (const [index, triangle] of triangles.entries()) {
    const normal = triangleNormal(vertices, triangle.indices);
    for (const [corner, vertexIndex] of triangle.indices.entries()) {
      const offset = index * 9 + corner * 3;
      sourcePositions.set(itemAt(vertices, vertexIndex), offset);
      sourceNormals.set(normal, offset);
    }
  }
  const color = srgbTupleToLinear(itemAt(triangles, 0).color);
  return {
    mode: 4,
    positions: transformVertexArray(sourcePositions, transform),
    normals: transformNormalArray(sourceNormals, transform),
    material: {
      pbrMetallicRoughness: {
        baseColorFactor: color,
        metallicFactor: cadMaterialDefaults.metalnessFactor,
        roughnessFactor: cadMaterialDefaults.roughnessFactor,
      },
      doubleSided: true,
      alphaMode: color[3] < 1 ? 'BLEND' : 'OPAQUE',
    },
  };
};

const edgePrimitive = (surfaces: readonly GlbPrimitive[]): GlbPrimitive | undefined => {
  const positions = new Float32Array(surfaces.reduce((count, surface) => count + surface.positions.length, 0));
  let offset = 0;
  for (const surface of surfaces) {
    positions.set(surface.positions, offset);
    offset += surface.positions.length;
  }
  // Weld only for this body's overlay classification. Surface geometry and body identity stay unchanged.
  const edges = detectEdges(positions, undefined).positions;
  if (edges.length === 0) {
    return undefined;
  }
  return {
    mode: 1,
    positions: edges,
    material: {
      pbrMetallicRoughness: {
        baseColorFactor: [...cadEdgeOverlayMaterialDefaults.baseColorFactor],
        metallicFactor: cadEdgeOverlayMaterialDefaults.metallicFactor,
        roughnessFactor: cadEdgeOverlayMaterialDefaults.roughnessFactor,
      },
      doubleSided: cadEdgeOverlayMaterialDefaults.doubleSided,
      alphaMode: cadEdgeOverlayMaterialDefaults.alphaMode,
      extensions: { KHR_materials_unlit: {} },
    },
  };
};

/** Serialize OFF face colors and flat normals through the public writer, defaulting to canonical GLB Y-up metres. */
export const classicMeshToGlb = (mesh: ClassicMesh, options: MeshOptions = {}): Uint8Array<ArrayBuffer> => {
  const transform: GeometryOutputTransformOptions = {
    coordinateSystem: options.coordinateSystem ?? 'y-up',
    unit: { length: options.unit ?? 'meter' },
  };
  const nodes: GlbNode[] = splitBodies(mesh).map((body, index) => {
    const colors = new Map<string, ClassicTriangle[]>();
    for (const triangle of body) {
      const key = triangle.color.join(',');
      const bucket = colors.get(key);
      if (bucket) {
        bucket.push(triangle);
      } else {
        colors.set(key, [triangle]);
      }
    }
    const colorRuns = [...colors.values()];
    const primitives = colorRuns.map((triangles) => surfacePrimitive(mesh.vertices, triangles, transform));
    // Mixed surface/overlay nodes keep their existing ownership. Canonical exports contain triangles only.
    const canonical =
      options.includeEdges === true
        ? undefined
        : classicCanonicalSurface(
            primitives,
            colorRuns.flatMap((run) => run.map(({ indices }) => indices)),
          );
    const edges = options.includeEdges === true ? edgePrimitive(primitives) : undefined;
    if (edges) {
      primitives.push(edges);
    }
    return {
      name: formatShapeName(index),
      primitives: canonical?.primitives ?? primitives,
      ...(canonical ? { manifoldTopology: canonical.topology } : {}),
    };
  });
  return writeGlb({ nodes });
};
