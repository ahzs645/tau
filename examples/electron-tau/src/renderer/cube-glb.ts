/**
 * Synthetic cube `.glb` builder used by the PoC renderer to drive the
 * bbox viewer end-to-end without booting the OpenSCAD WASM kernel.
 *
 * Real production renders flow through `RuntimeClient.openFile()` over
 * the IPC bridge wired in `main/index.ts`; for the PoC's e2e validation
 * we just need a glTF whose bbox tracks the user-supplied `length` so
 * the bbox-viewer assertion (p1-electron-validate-bbox) is meaningful.
 */

import type { GltfJson } from './gltf-inspector.js';
import { packGlbForTest } from './gltf-inspector.js';

export function buildCubeGlb(length: number): ArrayBuffer {
  const half = length / 2;
  const json: GltfJson = {
    asset: { version: '2.0', generator: 'tau-electron-poc' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0 },
            indices: 1,
          },
        ],
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 8,
        type: 'VEC3',
        min: [-half, -half, -half],
        max: [half, half, half],
      },
      {
        bufferView: 1,
        componentType: 5123,
        count: 36,
        type: 'SCALAR',
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 96 },
      { buffer: 0, byteOffset: 96, byteLength: 72 },
    ],
    buffers: [{ byteLength: 168 }],
  };
  return packGlbForTest(json);
}
