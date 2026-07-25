import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRuntimeClient } from '@taucad/runtime';
import { inProcessTransport } from '@taucad/runtime/transport/in-process';
import { fromMemoryFs } from '@taucad/runtime/filesystem';
import { openscad } from '@taucad/openscad';
import { boundsOf, meshVolume, readMesh } from './lib/glb-measure.js';

const root = resolve(import.meta.dirname, '../../../apps/ui/app/routes/playground/projects/stamp');
const outDirectory = process.argv[2] ?? resolve(import.meta.dirname, '../renders');
const files: Record<string, string> = {};
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && /\.(scad|svg|json|stl)$/u.test(entry.name)) {
    files[`/${entry.name}`] = readFileSync(join(root, entry.name), 'utf8');
  }
}

// A deliberately different artwork: a thick square ring, unmistakable against the script logo.
files['/artwork.svg'] =
  '<?xml version="1.0"?><svg viewBox="0 0 208 128" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M24 24 H184 V104 H24 Z" fill="none" stroke="#000" stroke-width="10"/>' +
  '<path d="M60 56 H148" fill="none" stroke="#000" stroke-width="10"/></svg>';

const client = createRuntimeClient({
  transport: inProcessTransport({ fileSystem: fromMemoryFs(files) }),
  kernels: [openscad()],
});
for (const [label, parameters] of [
  ['shipped yaa.svg', {}],
  ['uploaded artwork.svg', { svg_file: 'artwork.svg' }],
] as const) {
  const result = await client.export('glb', { file: '/Main.scad', parameters } as never);
  if (!result.success) {
    console.log(
      `${label.padEnd(22)} FAILED ${result.issues
        .map((issue) => issue.message)
        .join('; ')
        .slice(0, 200)}`,
    );
    continue;
  }

  const mesh = readMesh(result.data.bytes);
  const bounds = boundsOf(mesh);
  writeFileSync(join(outDirectory, `stamp--${label.split(' ')[0]}.glb`), result.data.bytes);
  console.log(
    `${label.padEnd(22)} vol ${meshVolume(mesh).toFixed(1).padStart(10)} mm³  tris ${String(mesh.indices.length / 3).padStart(6)}  size ${bounds.max.map((value, axis) => (value - bounds.min[axis]!).toFixed(1)).join(' x ')}`,
  );
}
client.terminate();
