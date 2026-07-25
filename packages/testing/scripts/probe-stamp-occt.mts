import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { createRuntimeClient } from '@taucad/runtime';
import { inProcessTransport } from '@taucad/runtime/transport/in-process';
import { fromMemoryFs } from '@taucad/runtime/filesystem';
import { esbuild } from '@taucad/runtime/bundler';
import { opencascade } from '@taucad/runtime/kernels';
import { boundsOf, isWatertight, meshVolume, readMesh } from './lib/glb-measure.js';

const root = resolve(import.meta.dirname, '../../../apps/ui/app/routes/playground/projects/stamp');
const outDirectory = resolve(import.meta.dirname, '../renders');
const files: Record<string, string> = {};
const walk = (directory: string, prefix: string): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path, `${prefix}${entry.name}/`);
    } else if (/\.(ts|js|scad|json|svg)$/u.test(entry.name)) {
      files[`/${prefix}${entry.name}`] = readFileSync(path, 'utf8');
    }
  }
};
walk(root, '');

const client = createRuntimeClient({
  transport: inProcessTransport({ fileSystem: fromMemoryFs(files) }),
  kernels: [opencascade()],
  bundlers: [esbuild()],
});
for (const simplifyAngleDeg of process.argv.slice(2).map(Number).filter(Number.isFinite)) {
  const started = Date.now();
  const result = await client.export('glb', {
    file: '/main.occt.ts',
    parameters: { simplifyAngleDeg },
    coordinateSystem: 'z-up',
  } as never);
  if (!result.success) {
    console.log(
      `${String(simplifyAngleDeg).padStart(3)}°  FAILED after ${Date.now() - started}ms — ${result.issues
        .map((issue) => issue.message)
        .join('; ')
        .slice(0, 90)}`,
    );
    continue;
  }

  const mesh = readMesh(result.data.bytes);
  const bounds = boundsOf(mesh);
  writeFileSync(join(outDirectory, `stamp-occt-${simplifyAngleDeg}.glb`), result.data.bytes);
  console.log(
    `${String(simplifyAngleDeg).padStart(3)}°  OK ${String(Date.now() - started).padStart(6)}ms  vol ${meshVolume(mesh).toFixed(1).padStart(8)} mm³  tris ${String(mesh.indices.length / 3).padStart(6)}  watertight ${isWatertight(mesh) ? 'yes' : 'NO'}  size ${bounds.max.map((value, axis) => (value - bounds.min[axis]!).toFixed(1)).join(' x ')}`,
  );
}
client.terminate();
