import { roundClassicOffCoordinate } from '#runtime/classic/rounding.js';

type Point = readonly [number, number, number];
type Triangle = readonly [Point, Point, Point];
type IndexedTriangle = readonly [number, number, number];
type OffRounder = (value: Point) => Point;
type NativeOff = {
  lines: string[];
  vertexStart: number;
  vertices: Point[];
  faces: number[][];
};

const at = <Item>(items: readonly Item[], index: number): Item => {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError('Incomplete native OFF/STL precision records.');
  }
  return item;
};

const finite = (token: string): number => {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(token)) {
    throw new TypeError('Native precision coordinates must be decimal numbers.');
  }
  const value = Number(token);
  if (!Number.isFinite(value)) {
    throw new RangeError('Native precision coordinates must be finite.');
  }
  return value;
};

const integer = (token: string): number => {
  const value = Number(token);
  if (!/^\d+$/u.test(token) || !Number.isSafeInteger(value)) {
    throw new RangeError('Invalid native OFF count or index.');
  }
  return value;
};

const point = (tokens: readonly string[]): Point => {
  if (tokens.length !== 3) {
    throw new RangeError('Native precision coordinates require exactly three components.');
  }
  return [finite(at(tokens, 0)), finite(at(tokens, 1)), finite(at(tokens, 2))];
};

const readOff = (text: string): NativeOff => {
  const lines = text
    .split(/\r\n|\n|\r/u)
    .map((line) => line.replace(/#.*$/u, '').trim())
    .filter(Boolean);
  const header = at(lines, 0).split(/\s+/u);
  if (header[0] !== 'OFF') {
    throw new TypeError('Native precision input requires an OFF header.');
  }
  const vertexStart = header.length === 1 ? 2 : 1;
  const counts = vertexStart === 2 ? at(lines, 1).split(/\s+/u) : header.slice(1);
  if (counts.length !== 3) {
    throw new RangeError('Native OFF requires vertex, face and edge counts.');
  }
  const vertexCount = integer(at(counts, 0));
  const faceCount = integer(at(counts, 1));
  integer(at(counts, 2));
  if (lines.length !== vertexStart + vertexCount + faceCount) {
    throw new RangeError('Native OFF precision records do not match their declared counts.');
  }
  const vertices = lines.slice(vertexStart, vertexStart + vertexCount).map((line) => point(line.split(/\s+/u)));
  const faces = lines.slice(vertexStart + vertexCount).map((line) => {
    const tokens = line.split(/\s+/u);
    const count = integer(at(tokens, 0));
    if (count < 3 || tokens.length < count + 1) {
      throw new RangeError('Native OFF has an incomplete face.');
    }
    const indices = tokens.slice(1, count + 1).map((token) => integer(token));
    if (indices.some((index) => index >= vertexCount) || new Set(indices).size !== indices.length) {
      throw new RangeError('Native OFF has an invalid or repeated face index.');
    }
    return indices;
  });
  return { lines, vertexStart, vertices, faces };
};

const readAsciiStl = (text: string): Triangle[] => {
  const lines = text
    .split(/\r\n|\n|\r/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!/^solid(?:\s.*)?$/u.test(at(lines, 0)) || !/^endsolid(?:\s.*)?$/u.test(at(lines, lines.length - 1))) {
    throw new TypeError('Native precision output must be a complete ASCII STL solid.');
  }
  const triangles: Triangle[] = [];
  for (let index = 1; index < lines.length - 1; index += 7) {
    const normal = at(lines, index).split(/\s+/u);
    if (
      normal[0] !== 'facet' ||
      normal[1] !== 'normal' ||
      at(lines, index + 1) !== 'outer loop' ||
      at(lines, index + 5) !== 'endloop' ||
      at(lines, index + 6) !== 'endfacet'
    ) {
      throw new TypeError('Native ASCII STL has an incomplete or unexpected facet record.');
    }
    point(normal.slice(2));
    const vertex = (offset: number): Point => {
      const tokens = at(lines, index + offset).split(/\s+/u);
      if (tokens[0] !== 'vertex') {
        throw new TypeError('Native ASCII STL facet is missing a vertex.');
      }
      return point(tokens.slice(1));
    };
    triangles.push([vertex(2), vertex(3), vertex(4)]);
  }
  if (lines.length !== 2 + triangles.length * 7) {
    throw new RangeError('Native ASCII STL contains extra records.');
  }
  return triangles;
};

const samePoint = (left: Point, right: Point): boolean =>
  left[0] === right[0] && left[1] === right[1] && left[2] === right[2];

// Cache exact rounding within one native operation; repeated corners still retain distinct OFF identities.
const createOffRounder = (): OffRounder => {
  const coordinates = new Map<number, number>();
  const coordinate = (value: number): number => {
    const existing = coordinates.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const rounded = roundClassicOffCoordinate(value);
    coordinates.set(value, rounded);
    return rounded;
  };
  return (value) => [coordinate(value[0]), coordinate(value[1]), coordinate(value[2])];
};

const compatible = (known: Point | undefined, candidate: Point): boolean =>
  known === undefined || samePoint(known, candidate);

const matchingRotations = (
  face: readonly number[],
  triangle: Triangle,
  state: { original: readonly Point[]; recovered: ReadonlyMap<number, Point>; offPoint: OffRounder },
): Triangle[] => {
  const candidates: Triangle[] = [];
  for (let rotation = 0; rotation < 3; rotation += 1) {
    const candidate: Triangle = [
      at(triangle, rotation),
      at(triangle, (rotation + 1) % 3),
      at(triangle, (rotation + 2) % 3),
    ];
    if (
      face.every(
        (id, corner) =>
          samePoint(at(state.original, id), state.offPoint(at(candidate, corner))) &&
          compatible(state.recovered.get(id), at(candidate, corner)),
      )
    ) {
      candidates.push(candidate);
    }
  }
  return candidates;
};

const recoverTriangles = (off: NativeOff, triangles: readonly Triangle[], offPoint: OffRounder): Map<number, Point> => {
  if (off.faces.length !== triangles.length) {
    throw new RangeError('Native OFF and ASCII STL triangle counts disagree.');
  }
  const recovered = new Map<number, Point>();
  let pending = off.faces.map((_face, index) => index);
  while (pending.length > 0) {
    const unresolved: number[] = [];
    for (const index of pending) {
      const face = at(off.faces, index);
      const candidates = matchingRotations(face, at(triangles, index), { original: off.vertices, recovered, offPoint });
      if (candidates.length === 0) {
        throw new RangeError(`Native OFF/STL face ${index} has inconsistent indexed corners or winding.`);
      }
      if (candidates.length !== 1) {
        unresolved.push(index);
        continue;
      }
      const candidate = at(candidates, 0);
      for (const [corner, id] of face.entries()) {
        recovered.set(id, at(candidate, corner));
      }
    }
    if (unresolved.length === pending.length) {
      throw new RangeError('Native OFF/STL vertex correspondence remains ambiguous.');
    }
    pending = unresolved;
  }
  return recovered;
};

const edgeKey = (left: number, right: number): string => (left < right ? `${left}:${right}` : `${right}:${left}`);

/** A convex polygon's native triangles must preserve every oriented boundary edge exactly once. */
const assertPolygonBoundary = (face: readonly number[], triangles: readonly IndexedTriangle[]): void => {
  if (triangles.length !== face.length - 2) {
    throw new RangeError('Native STL does not completely triangulate an OFF polygon.');
  }
  const boundary = new Map<string, number>();
  for (const [index, left] of face.entries()) {
    const right = at(face, (index + 1) % face.length);
    boundary.set(edgeKey(left, right), left < right ? 1 : -1);
  }
  const edges = new Map<string, { count: number; winding: number }>();
  for (const triangle of triangles) {
    for (const [index, left] of triangle.entries()) {
      const right = at(triangle, (index + 1) % 3);
      const key = edgeKey(left, right);
      const edge = edges.get(key) ?? { count: 0, winding: 0 };
      edge.count += 1;
      edge.winding += left < right ? 1 : -1;
      edges.set(key, edge);
    }
  }
  const complete = [...boundary.keys()].every((key) => edges.has(key));
  const oriented = [...edges].every(([key, edge]) => {
    const expected = boundary.get(key);
    return edge.count === (expected === undefined ? 2 : 1) && edge.winding === (expected ?? 0);
  });
  if (!complete || !oriented) {
    throw new RangeError('Native STL polygon triangulation changes an OFF boundary or its winding.');
  }
};

const recoverPolygons = (off: NativeOff, triangles: readonly Triangle[], offPoint: OffRounder): Map<number, Point> => {
  const byPosition = new Map<string, number[]>();
  for (const [id, vertex] of off.vertices.entries()) {
    const key = vertex.join(',');
    const existing = byPosition.get(key) ?? [];
    existing.push(id);
    byPosition.set(key, existing);
  }
  const memberships = off.vertices.map(() => new Set<number>());
  for (const [index, face] of off.faces.entries()) {
    for (const id of face) {
      at(memberships, id).add(index);
    }
  }
  const recovered = new Map<number, Point>();
  const assigned = off.faces.map((): IndexedTriangle[] => []);
  const recoverVertex = (vertex: Point): number => {
    const candidates = byPosition.get(offPoint(vertex).join(','));
    if (candidates?.length !== 1) {
      throw new RangeError('Native OFF/STL polygon vertex correspondence is missing or ambiguous.');
    }
    const id = at(candidates, 0);
    if (!compatible(recovered.get(id), vertex)) {
      throw new RangeError('Native ASCII STL disagrees on a shared OFF vertex identity.');
    }
    recovered.set(id, vertex);
    return id;
  };
  for (const triangle of triangles) {
    const ids: IndexedTriangle = [recoverVertex(triangle[0]), recoverVertex(triangle[1]), recoverVertex(triangle[2])];
    if (new Set(ids).size !== 3) {
      throw new RangeError('Native ASCII STL repeats a polygon vertex.');
    }
    const candidates = [...at(memberships, ids[0])].filter(
      (face) => at(memberships, ids[1]).has(face) && at(memberships, ids[2]).has(face),
    );
    if (candidates.length !== 1) {
      throw new RangeError('Native ASCII STL triangle has no unambiguous OFF polygon owner.');
    }
    at(assigned, at(candidates, 0)).push(ids);
  }
  for (const [index, face] of off.faces.entries()) {
    assertPolygonBoundary(face, at(assigned, index));
  }
  return recovered;
};

/**
 * Recover the pinned OFF writer's lost decimal precision from its paired native ASCII STL output.
 * Both files must come from the same CLI invocation. Original vertex identities, indexed faces and
 * color records are retained; inconsistent or ambiguous correspondence fails instead of welding or repairing.
 * The caller still applies the ordinary strict OFF geometry parser to the returned records.
 */
export const restoreClassicOffPrecision = (offText: string, asciiStlText: string): string => {
  const off = readOff(offText);
  const triangles = readAsciiStl(asciiStlText);
  const offPoint = createOffRounder();
  const recovered = off.faces.every((face) => face.length === 3)
    ? recoverTriangles(off, triangles, offPoint)
    : recoverPolygons(off, triangles, offPoint);
  if (recovered.size !== off.vertices.length) {
    throw new RangeError('Native ASCII STL does not account for every original OFF vertex.');
  }
  const lines = [...off.lines];
  for (const [id, vertex] of recovered) {
    lines[off.vertexStart + id] = vertex.join(' ');
  }
  return `${lines.join('\n')}\n`;
};
