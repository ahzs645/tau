type NativeTriangle = readonly [number, number, number];
type VertexLink = Map<number, Set<number>>;

const linkEdge = (links: Map<number, VertexLink>, center: number, edge: readonly [number, number]): void => {
  let link = links.get(center);
  if (!link) {
    link = new Map();
    links.set(center, link);
  }
  const [left, right] = edge;
  const forward = link.get(left) ?? new Set<number>();
  const reverse = link.get(right) ?? new Set<number>();
  forward.add(right);
  reverse.add(left);
  link.set(left, forward);
  link.set(right, reverse);
};

const connectedLink = (link: VertexLink): boolean => {
  if ([...link.values()].some((neighbors) => neighbors.size !== 2)) {
    return false;
  }
  const start = link.keys().next().value;
  if (start === undefined) {
    return false;
  }
  const pending = [start];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const vertex = pending.pop();
    if (vertex === undefined || visited.has(vertex)) {
      continue;
    }
    visited.add(vertex);
    pending.push(...(link.get(vertex) ?? []));
  }
  return visited.size === link.size;
};

/** Test exact native identities, opposite edge winding and connected vertex links without welding. */
export const closedNativeTopology = (triangles: readonly NativeTriangle[]): boolean => {
  const edges = new Map<string, { count: number; winding: number }>();
  const links = new Map<number, VertexLink>();
  for (const [a, b, c] of triangles) {
    if (a === b || b === c || c === a) {
      return false;
    }
    for (const [left, right] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = left < right ? `${left}:${right}` : `${right}:${left}`;
      const edge = edges.get(key) ?? { count: 0, winding: 0 };
      edge.count += 1;
      edge.winding += left < right ? 1 : -1;
      edges.set(key, edge);
    }
    linkEdge(links, a, [b, c]);
    linkEdge(links, b, [c, a]);
    linkEdge(links, c, [a, b]);
  }
  return (
    edges.size > 0 &&
    [...edges.values()].every(({ count, winding }) => count === 2 && winding === 0) &&
    [...links.values()].every((link) => connectedLink(link))
  );
};

const itemAt = <Item>(items: readonly Item[], index: number): Item => {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`Invalid OFF reference at index ${index}.`);
  }
  return item;
};

/** Preserve the original viewer's native-index body partition and first-face owner order. */
export const splitClassicBodies = <Triangle extends { readonly indices: NativeTriangle }>(
  vertexCount: number,
  triangles: readonly Triangle[],
): Triangle[][] => {
  const parents = Array.from({ length: vertexCount }, (_vertex, index) => index);
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
  for (const triangle of triangles) {
    const [a, b, c] = triangle.indices;
    parents[find(b)] = find(a);
    parents[find(c)] = find(a);
  }
  const bodies = new Map<number, Triangle[]>();
  for (const triangle of triangles) {
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
