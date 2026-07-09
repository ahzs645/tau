/**
 * Headless variant renderer for the playground pilot projects.
 *
 * Renders each project's OpenSCAD original and OpenCASCADE port through the
 * real kernels and writes GLB files for side-by-side comparison. Run from
 * packages/testing (so workspace deps resolve):
 *
 *   npx tsx scripts/render-variants.ts [outDir]
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { createRuntimeClient } from '@taucad/runtime';
import { inProcessTransport } from '@taucad/runtime/transport/in-process';
import { fromMemoryFs } from '@taucad/runtime/filesystem';
import { esbuild } from '@taucad/runtime/bundler';
import { opencascade } from '@taucad/runtime/kernels';
import { openscad } from '@taucad/openscad';

const projectsDirectory = resolve(import.meta.dirname, '../../../apps/ui/app/routes/playground/projects');
const outDirectory = process.argv[2] ?? resolve(import.meta.dirname, '../renders');

type VariantSpec = { project: string; variant: string; entry: string };

const specs: VariantSpec[] = [
  { project: '3d-rack-scad', variant: 'openscad', entry: 'main.scad' },
  { project: '3d-rack-scad', variant: 'opencascade', entry: 'main.occt.ts' },
  { project: 'catan-insert', variant: 'openscad', entry: 'main.scad' },
  { project: 'catan-insert', variant: 'opencascade', entry: 'main.occt.ts' },
  { project: 'pendant-lamp', variant: 'openscad', entry: 'Main.scad' },
  { project: 'pendant-lamp', variant: 'opencascade', entry: 'main.occt.ts' },
  { project: 'vane-trap', variant: 'openscad', entry: 'main.scad' },
  { project: 'vane-trap', variant: 'opencascade', entry: 'main.occt.ts' },
  { project: 'pre-chamber-nozzle-insert', variant: 'openscad', entry: 'prechamber_nozzle_insert_BOSL2_threads.scad' },
  { project: 'pre-chamber-nozzle-insert', variant: 'opencascade', entry: 'main.occt.ts' },
  { project: 'parametric-gel-comb', variant: 'openscad', entry: 'main.scad' },
  { project: 'parametric-gel-comb', variant: 'opencascade', entry: 'main.occt.ts' },
];

function projectFiles(project: string): Record<string, string> {
  const root = join(projectsDirectory, project);
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, `${prefix}${entry.name}/`);
      } else if (/\.(ts|js|scad|json|txt|svg)$/u.test(entry.name)) {
        files[`/${prefix}${entry.name}`] = readFileSync(path, 'utf8');
      }
    }
  };
  walk(root, '');
  return files;
}

async function renderVariant(spec: VariantSpec): Promise<void> {
  const files = projectFiles(spec.project);
  const entryPath = `/${spec.entry}`;
  if (!files[entryPath]) {
    throw new Error(`${spec.project}: missing entry ${entryPath}`);
  }

  const client = createRuntimeClient({
    transport: inProcessTransport({ fileSystem: fromMemoryFs(files) }),
    kernels: [openscad(), opencascade()],
    bundlers: [esbuild()],
  });

  try {
    const started = Date.now();
    const result = await client.export('glb', { file: entryPath });
    if (!result.success) {
      throw new Error(
        `${spec.project}/${spec.variant} export failed:\n${result.issues
          .map((issue) => `- ${issue.message}`)
          .join('\n')}`,
      );
    }

    const outPath = join(outDirectory, `${spec.project}--${spec.variant}.glb`);
    writeFileSync(outPath, result.data.bytes);
    console.log(
      `✔ ${spec.project}/${spec.variant} → ${outPath} (${result.data.bytes.length} bytes, ${Date.now() - started}ms)`,
    );
  } finally {
    client.terminate();
  }
}

mkdirSync(outDirectory, { recursive: true });
for (const spec of specs) {
  // Sequential on purpose: two OCCT WASM instances at once double peak memory.
  await renderVariant(spec);
}
