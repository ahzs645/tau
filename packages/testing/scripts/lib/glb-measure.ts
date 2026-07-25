/**
 * Geometry measurement straight out of an exported GLB.
 *
 * Shared by the variant and port comparison scripts so both grade kernels by
 * the same ruler, and so neither kernel gets to report on its own shape.
 */

export type Mesh = { positions: Float32Array; indices: Uint32Array };
export type Bounds = { min: [number, number, number]; max: [number, number, number] };

/** Positions and indices out of the GLB binary chunk. */
export function readMesh(bytes: Uint8Array): Mesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as {
    meshes?: Array<{ primitives: Array<{ attributes: { POSITION: number }; indices?: number; mode?: number }> }>;
    accessors?: Array<{ bufferView: number; count: number; componentType: number; byteOffset?: number }>;
    bufferViews?: Array<{ byteOffset?: number; byteLength: number; byteStride?: number }>;
  };
  const binaryOffset = 20 + jsonLength + 8;

  const positions: number[] = [];
  const indices: number[] = [];
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      // Triangles only (mode 4, the glTF default). The OpenCascade kernel also
      // emits the model's native BRep edges as a points/lines primitive, which
      // is not surface geometry and must not reach the volume sum.
      if ((primitive.mode ?? 4) !== 4) {
        continue;
      }

      const vertexBase = positions.length / 3;
      const positionAccessor = json.accessors?.[primitive.attributes.POSITION];
      const positionView = json.bufferViews?.[positionAccessor?.bufferView ?? -1];
      if (!positionAccessor || !positionView) {
        continue;
      }

      // OCCT's RWGltf_CafWriter packs several accessors into one bufferView, so
      // the accessor's own byteOffset (and any stride) has to be honoured.
      const positionBase = binaryOffset + (positionView.byteOffset ?? 0) + (positionAccessor.byteOffset ?? 0);
      const positionStride = positionView.byteStride ?? 12;
      for (let vertex = 0; vertex < positionAccessor.count; vertex += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          positions.push(view.getFloat32(positionBase + vertex * positionStride + axis * 4, true));
        }
      }

      const indexAccessor = json.accessors?.[primitive.indices ?? -1];
      const indexView = json.bufferViews?.[indexAccessor?.bufferView ?? -1];
      if (!indexAccessor || !indexView) {
        continue;
      }

      // 5125 = UNSIGNED_INT, 5123 = UNSIGNED_SHORT, 5121 = UNSIGNED_BYTE.
      const stride = indexAccessor.componentType === 5125 ? 4 : indexAccessor.componentType === 5123 ? 2 : 1;
      const indexBase = binaryOffset + (indexView.byteOffset ?? 0) + (indexAccessor.byteOffset ?? 0);
      for (let index = 0; index < indexAccessor.count; index += 1) {
        const offset = indexBase + index * stride;
        const value =
          stride === 4
            ? view.getUint32(offset, true)
            : stride === 2
              ? view.getUint16(offset, true)
              : view.getUint8(offset);
        indices.push(vertexBase + value);
      }
    }
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Signed volume by summing tetrahedra to the origin; mm³ from metre positions. */
export function meshVolume({ positions, indices }: Mesh): number {
  let volume = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const [a, b, c] = [indices[index]! * 3, indices[index + 1]! * 3, indices[index + 2]! * 3];
    const ax = positions[a]!;
    const ay = positions[a + 1]!;
    const az = positions[a + 2]!;
    const bx = positions[b]!;
    const by = positions[b + 1]!;
    const bz = positions[b + 2]!;
    const cx = positions[c]!;
    const cy = positions[c + 1]!;
    const cz = positions[c + 2]!;
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }

  return Math.abs(volume) * 1e9;
}

/**
 * Closed and manifold: every edge shared by exactly two triangles. Vertices are
 * quantised to a micron first, because the kernels emit split vertices per face.
 */
export function isWatertight({ positions, indices }: Mesh): boolean {
  const key = (vertex: number): string => {
    const base = vertex * 3;
    return `${Math.round(positions[base]! * 1e6)},${Math.round(positions[base + 1]! * 1e6)},${Math.round(positions[base + 2]! * 1e6)}`;
  };

  const edges = new Map<string, number>();
  for (let index = 0; index < indices.length; index += 3) {
    const corners = [key(indices[index]!), key(indices[index + 1]!), key(indices[index + 2]!)];
    for (let corner = 0; corner < 3; corner += 1) {
      const [from, to] = [corners[corner]!, corners[(corner + 1) % 3]!];
      const edge = from < to ? `${from}|${to}` : `${to}|${from}`;
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
    }
  }

  return [...edges.values()].every((count) => count === 2);
}

/** Bounds in millimetres. */
export function boundsOf({ positions }: Mesh): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis]! * 1000;
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }

  return { min, max };
}

/**
 * Undo the Z-up→Y-up vertex transform (x' = x, y' = z, z' = -y) that the
 * replicad and jscad kernel paths apply unconditionally, so their bounds can be
 * compared against the OpenCascade kernel's Z-up output axis for axis. A port
 * that is genuinely rotated still shows up as a mismatch — only the known
 * kernel-level convention difference is cancelled.
 */
export function toZUp(bounds: Bounds): Bounds {
  return {
    min: [bounds.min[0], -bounds.max[2], bounds.min[1]],
    max: [bounds.max[0], -bounds.min[2], bounds.max[1]],
  };
}
