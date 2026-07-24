/**
 * Thread-helper comparison: raw opencascade.js against Replicad.
 *
 * The vane trap cannot answer whether a thread helper actually works — its
 * thread mask is a no-op that intersects nothing, so the model renders
 * identically whether the sweep produced a helix or garbage. This script builds
 * the threads on their own and measures them.
 *
 * Three implementations, same nominal thread:
 *   occt-sampled   projects/vane-trap/lib/threads.ts               (BSpline spine through sampled points)
 *   occt-analytic  projects/pre-chamber-nozzle-insert/lib/threads.ts (exact helix on a cylindrical surface)
 *   replicad       projects/vane-trap/lib/threads.replicad.ts       (sketchHelix + sweepSketch)
 *
 * Four checks per implementation, all measured from the exported mesh so no
 * kernel gets to grade its own homework:
 *   1. ridge     — volume against the analytic swept-profile volume (Pappus)
 *   2. rod       — core + ridge fused: watertight, plausible volume
 *   3. nut       — block minus (rod + clearance): does the female cut survive
 *   4. fit       — intersect(rod, nut): a real mating pair barely touches;
 *                  a failed thread cut leaves a large overlap
 *
 * Run from packages/testing:
 *
 *   npx tsx scripts/compare-threads.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { createRuntimeClient } from '@taucad/runtime';
import { inProcessTransport } from '@taucad/runtime/transport/in-process';
import { fromMemoryFs } from '@taucad/runtime/filesystem';
import { esbuild } from '@taucad/runtime/bundler';
import { opencascade, replicad } from '@taucad/runtime/kernels';

const projectsDirectory = resolve(import.meta.dirname, '../../../apps/ui/app/routes/playground/projects');
const read = (path: string): string => readFileSync(resolve(projectsDirectory, path), 'utf8');

// M14 x 2, 20 mm of thread — a normal fastener, not a tuned-for-the-test case.
const MAJOR_DIAMETER = 14;
const PITCH = 2;
const LENGTH = 20;
const CLEARANCE = 0.4;
const DEPTH = 0.5413 * PITCH;
const CORE_RADIUS = MAJOR_DIAMETER / 2 - DEPTH;

/**
 * Expected ridge volume by Pappus: the trapezoid profile area swept along the
 * helical path traced by its centroid. Exact for a revolve, and within a
 * fraction of a percent for a helix this shallow, so it is a real independent
 * check on the swept solid rather than a cross-check between kernels.
 */
function analyticRidgeVolume(): number {
  const flankAngleDeg = 30;
  const apexWidth = PITCH / 8;
  const rootWidth = apexWidth + 2 * DEPTH * Math.tan((flankAngleDeg * Math.PI) / 180);
  const rootInset = Math.min(0.2, DEPTH * 0.25);
  const height = DEPTH + rootInset;
  const area = ((rootWidth + apexWidth) / 2) * height;

  // Centroid of a trapezoid, measured from the wide (root) side.
  const centroidOffset = (height * (2 * apexWidth + rootWidth)) / (3 * (apexWidth + rootWidth));
  const centroidRadius = CORE_RADIUS - rootInset + centroidOffset;

  const turns = LENGTH / PITCH;
  const pathLength = turns * Math.hypot(2 * Math.PI * centroidRadius, PITCH);
  return area * pathLength;
}

const models: Record<string, Record<string, string>> = {
  'occt-sampled': {
    'threads.ts': read('vane-trap/lib/threads.ts'),
    'occt-utils.ts': read('vane-trap/lib/occt-utils.ts'),
    'ridge.ts': `import { helicalRidge } from './threads.js';
export default function main() {
  return helicalRidge({ baseRadius: ${CORE_RADIUS}, pitch: ${PITCH}, length: ${LENGTH}, depth: ${DEPTH} });
}`,
    'rod.ts': `import { threadedRod } from './threads.js';
export default function main() {
  return threadedRod({ majorDiameter: ${MAJOR_DIAMETER}, length: ${LENGTH}, pitch: ${PITCH} });
}`,
    'nut.ts': `import { threadedRod } from './threads.js';
import { boxAt, cut } from './occt-utils.js';
export default function main() {
  return cut(
    boxAt([0, 0, ${LENGTH / 2}], ${MAJOR_DIAMETER + 8}, ${MAJOR_DIAMETER + 8}, ${LENGTH}),
    threadedRod({ majorDiameter: ${MAJOR_DIAMETER}, length: ${LENGTH}, pitch: ${PITCH}, clearance: ${CLEARANCE} }),
  );
}`,
    'fit.ts': `import { threadedRod } from './threads.js';
import { boxAt, cut, intersect } from './occt-utils.js';
export default function main() {
  const nut = cut(
    boxAt([0, 0, ${LENGTH / 2}], ${MAJOR_DIAMETER + 8}, ${MAJOR_DIAMETER + 8}, ${LENGTH}),
    threadedRod({ majorDiameter: ${MAJOR_DIAMETER}, length: ${LENGTH}, pitch: ${PITCH}, clearance: ${CLEARANCE} }),
  );
  return intersect(nut, threadedRod({ majorDiameter: ${MAJOR_DIAMETER}, length: ${LENGTH}, pitch: ${PITCH} }));
}`,
  },
  'occt-analytic': {
    'threads.ts': read('pre-chamber-nozzle-insert/lib/threads.ts'),
    'occt-utils.ts': read('pre-chamber-nozzle-insert/lib/occt-utils.ts'),
    'ridge.ts': `import { helicalRidge } from './threads.js';
export default function main() {
  return helicalRidge({ baseRadius: ${CORE_RADIUS}, pitch: ${PITCH}, length: ${LENGTH}, depth: ${DEPTH} });
}`,
    'rod.ts': `import { threadedRod } from './threads.js';
export default function main() {
  return threadedRod({ majorDiameter: ${MAJOR_DIAMETER}, length: ${LENGTH}, pitch: ${PITCH} });
}`,
    'nut.ts': `import { threadedRod } from './threads.js';
import { boxAt, cut } from './occt-utils.js';
export default function main() {
  return cut(
    boxAt([0, 0, ${LENGTH / 2}], ${MAJOR_DIAMETER + 8}, ${MAJOR_DIAMETER + 8}, ${LENGTH}),
    threadedRod({ majorDiameter: ${MAJOR_DIAMETER}, length: ${LENGTH}, pitch: ${PITCH}, clearance: ${CLEARANCE} }),
  );
}`,
    'fit.ts': `import { threadedRod } from './threads.js';
import { boxAt, cut, intersect } from './occt-utils.js';
export default function main() {
  const nut = cut(
    boxAt([0, 0, ${LENGTH / 2}], ${MAJOR_DIAMETER + 8}, ${MAJOR_DIAMETER + 8}, ${LENGTH}),
    threadedRod({ majorDiameter: ${MAJOR_DIAMETER}, length: ${LENGTH}, pitch: ${PITCH}, clearance: ${CLEARANCE} }),
  );
  return intersect(nut, threadedRod({ majorDiameter: ${MAJOR_DIAMETER}, length: ${LENGTH}, pitch: ${PITCH} }));
}`,
  },
  replicad: {
    'threads.ts': read('vane-trap/lib/threads.replicad.ts'),
    'ridge.ts': `import { helicalRidge } from './threads.js';
export default function main() {
  return helicalRidge({ baseRadius: ${CORE_RADIUS}, pitch: ${PITCH}, length: ${LENGTH}, depth: ${DEPTH} });
}`,
    'rod.ts': `import { threadedRod } from './threads.js';
export default function main() {
  return threadedRod({ majorDiameter: ${MAJOR_DIAMETER}, length: ${LENGTH}, pitch: ${PITCH} });
}`,
    'nut.ts': `import { makeBaseBox } from 'replicad';
import { threadedRod } from './threads.js';
export default function main() {
  return makeBaseBox(${MAJOR_DIAMETER + 8}, ${MAJOR_DIAMETER + 8}, ${LENGTH}).cut(
    threadedRod({ majorDiameter: ${MAJOR_DIAMETER}, length: ${LENGTH}, pitch: ${PITCH}, clearance: ${CLEARANCE} }),
  );
}`,
    'fit.ts': `import { makeBaseBox } from 'replicad';
import { threadedRod } from './threads.js';
export default function main() {
  const nut = makeBaseBox(${MAJOR_DIAMETER + 8}, ${MAJOR_DIAMETER + 8}, ${LENGTH}).cut(
    threadedRod({ majorDiameter: ${MAJOR_DIAMETER}, length: ${LENGTH}, pitch: ${PITCH}, clearance: ${CLEARANCE} }),
  );
  return nut.intersect(threadedRod({ majorDiameter: ${MAJOR_DIAMETER}, length: ${LENGTH}, pitch: ${PITCH} }));
}`,
  },
};

type Mesh = { positions: Float32Array; indices: Uint32Array };

/** Positions and indices out of the GLB binary chunk. */
function readMesh(bytes: Uint8Array): Mesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as {
    meshes: Array<{ primitives: Array<{ attributes: { POSITION: number }; indices: number }> }>;
    accessors: Array<{ bufferView: number; count: number; componentType: number; byteOffset?: number }>;
    bufferViews: Array<{ byteOffset?: number; byteLength: number; byteStride?: number }>;
  };
  const binaryOffset = 20 + jsonLength + 8;

  const positions: number[] = [];
  const indices: number[] = [];
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      const vertexBase = positions.length / 3;
      const positionAccessor = json.accessors[primitive.attributes.POSITION]!;
      const positionView = json.bufferViews[positionAccessor.bufferView]!;
      // OCCT's RWGltf_CafWriter packs several accessors into one bufferView, so
      // the accessor's own byteOffset (and any stride) has to be honoured.
      const positionBase = binaryOffset + (positionView.byteOffset ?? 0) + (positionAccessor.byteOffset ?? 0);
      const positionStride = positionView.byteStride ?? 12;
      for (let vertex = 0; vertex < positionAccessor.count; vertex += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          positions.push(view.getFloat32(positionBase + vertex * positionStride + axis * 4, true));
        }
      }

      const indexAccessor = json.accessors[primitive.indices]!;
      const indexView = json.bufferViews[indexAccessor.bufferView]!;
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
function meshVolume({ positions, indices }: Mesh): number {
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
function isWatertight({ positions, indices }: Mesh): boolean {
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

function boundsOf({ positions }: Mesh): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, positions[index + axis]! * 1000);
      max[axis] = Math.max(max[axis]!, positions[index + axis]! * 1000);
    }
  }

  return { min, max };
}

type CaseResult = { volume: number; watertight: boolean; triangles: number; span: number; milliseconds: number };

const results: Record<string, Record<string, CaseResult | string>> = {};

for (const [implementation, files] of Object.entries(models)) {
  const kernel = implementation === 'replicad' ? replicad() : opencascade();
  const client = createRuntimeClient({
    transport: inProcessTransport({
      fileSystem: fromMemoryFs(Object.fromEntries(Object.entries(files).map(([name, code]) => [`/${name}`, code]))),
    }),
    kernels: [kernel],
    bundlers: [esbuild()],
  });

  results[implementation] = {};
  for (const testCase of ['ridge', 'rod', 'nut', 'fit']) {
    const started = Date.now();
    try {
      const result = await client.export('glb', { file: `/${testCase}.ts`, coordinateSystem: 'z-up' } as never);
      if (!result.success) {
        results[implementation]![testCase] = `FAILED: ${result.issues.map((issue) => issue.message).join('; ')}`;
        continue;
      }

      const mesh = readMesh(result.data.bytes);
      const bounds = boundsOf(mesh);
      results[implementation]![testCase] = {
        volume: meshVolume(mesh),
        watertight: isWatertight(mesh),
        triangles: mesh.indices.length / 3,
        span: Math.max(...bounds.max.map((value, axis) => value - bounds.min[axis]!)),
        milliseconds: Date.now() - started,
      };
    } catch (error) {
      results[implementation]![testCase] = `THREW: ${String(error).split('\n')[0]}`;
    }
  }

  client.terminate();
}

const expectedRidge = analyticRidgeVolume();
// Rod ≈ core cylinder + ridge; nut ≈ block − (rod grown by the clearance).
const expectedRod = Math.PI * CORE_RADIUS ** 2 * LENGTH + expectedRidge;
const blockVolume = (MAJOR_DIAMETER + 8) ** 2 * LENGTH;

console.log(`\nM${MAJOR_DIAMETER} x ${PITCH}, ${LENGTH} mm thread, ${CLEARANCE} mm clearance`);
console.log(`analytic ridge volume (Pappus): ${expectedRidge.toFixed(1)} mm³`);
console.log(`analytic rod volume:            ${expectedRod.toFixed(1)} mm³`);
console.log(`block volume (nut stock):       ${blockVolume.toFixed(1)} mm³\n`);

const pad = (value: string, width: number): string => value.padEnd(width);
console.log(
  `${pad('implementation', 16)}${pad('case', 7)}${pad('volume mm³', 13)}${pad('vs analytic', 13)}${pad('watertight', 12)}${pad('tris', 8)}time`,
);
for (const [implementation, cases] of Object.entries(results)) {
  for (const [testCase, result] of Object.entries(cases)) {
    if (typeof result === 'string') {
      console.log(`${pad(implementation, 16)}${pad(testCase, 7)}${result}`);
      continue;
    }

    const expected =
      testCase === 'ridge'
        ? expectedRidge
        : testCase === 'rod'
          ? expectedRod
          : testCase === 'nut'
            ? blockVolume - expectedRod
            : undefined;
    const deviation = expected === undefined ? '—' : `${(((result.volume - expected) / expected) * 100).toFixed(1)}%`;
    console.log(
      `${pad(implementation, 16)}${pad(testCase, 7)}${pad(result.volume.toFixed(1), 13)}${pad(deviation, 13)}` +
        `${pad(result.watertight ? 'yes' : 'NO', 12)}${pad(String(result.triangles), 8)}${result.milliseconds}ms`,
    );
  }
}

console.log(`
'fit' is the mating check: intersect(nut, rod) with ${CLEARANCE} mm of clearance.
A thread pair that actually screws together leaves only clearance-scale slivers.
A failed female cut (a plain bore) leaves the male crests overlapping: the male
thread's ridge volume is ${expectedRidge.toFixed(0)} mm³, so an overlap near that
number means the parts cannot be assembled.`);

if (Object.values(results).some((cases) => Object.values(cases).some((result) => typeof result === 'string'))) {
  process.exitCode = 1;
}
