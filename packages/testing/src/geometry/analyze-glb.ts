import { NodeIO } from '@gltf-transform/core';
import { inspect } from '@gltf-transform/functions';
import { countConnectedComponents } from '#geometry/connected-components.js';
import { isWatertight } from '#geometry/watertight.js';
import type { GeometryStats } from '#geometry/types.js';

/**
 * Parses a GLB binary and returns geometry statistics.
 *
 * Handles the common case where Node.js Buffers from Socket.IO have a
 * non-zero byteOffset into a shared pool ArrayBuffer by copying into
 * an aligned Uint8Array when necessary.
 *
 * @param glb - Raw GLB binary data
 * @returns Geometry statistics including vertex/mesh counts, connected components,
 *   watertight status, and bounding box
 * @public
 */
export const analyzeGlb = async (glb: Uint8Array<ArrayBuffer>): Promise<GeometryStats> => {
  const io = new NodeIO();
  // Node.js Buffers from Socket.IO may have a non-zero byteOffset into a
  // shared pool ArrayBuffer (https://github.com/nodejs/node/issues/2888).
  // gltf-transform's GLB parser creates Uint32Array views at glb.byteOffset,
  // which requires 4-byte alignment. Copying into a fresh Uint8Array
  // guarantees byteOffset === 0.
  const aligned = glb.byteOffset % 4 === 0 ? glb : new Uint8Array(glb);
  const document = await io.readBinary(aligned);
  const report = inspect(document);

  const vertexCount = report.meshes.properties.reduce((sum, mesh) => sum + mesh.vertices, 0);
  const meshCount = report.meshes.properties.length;

  let boundingBox: GeometryStats['boundingBox'];
  if (report.scenes.properties.length > 0) {
    const scene = report.scenes.properties[0]!;
    if (scene.bboxMax.length >= 3 && scene.bboxMin.length >= 3) {
      boundingBox = {
        size: [
          scene.bboxMax[0]! - scene.bboxMin[0]!,
          scene.bboxMax[1]! - scene.bboxMin[1]!,
          scene.bboxMax[2]! - scene.bboxMin[2]!,
        ],
        center: [
          (scene.bboxMax[0]! + scene.bboxMin[0]!) / 2,
          (scene.bboxMax[1]! + scene.bboxMin[1]!) / 2,
          (scene.bboxMax[2]! + scene.bboxMin[2]!) / 2,
        ],
      };
    }
  }

  // Memoise per-tolerance lookups so repeated `evaluateRequirement` calls
  // against the same stats object don't re-traverse primitives. The check
  // table is small (callers typically supply 0–2 distinct tolerances per GLB).
  const cache = new Map<number, number>();
  const connectedComponents = (toleranceMm: number): number => {
    const cached = cache.get(toleranceMm);
    if (cached !== undefined) {
      return cached;
    }
    const value = countConnectedComponents(document, toleranceMm);
    cache.set(toleranceMm, value);
    return value;
  };
  const watertight = isWatertight(document);

  return { vertexCount, meshCount, connectedComponents, watertight, boundingBox };
};
