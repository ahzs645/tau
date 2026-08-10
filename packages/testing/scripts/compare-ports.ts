/**
 * Differential test of a project's OpenCascade and Replicad ports.
 *
 * Two ports of the same model agreeing on their default parameters proves very
 * little: a port can be right at one point in parameter space and wrong
 * everywhere else (a branch that never runs, a radius clamp, a boolean that
 * only degenerates when a wall gets thin). This script asks the kernel for the
 * model's resolved defaults, generates a sweep around them, and renders both
 * ports for every set, comparing bounding box and volume.
 *
 * The replicad kernel emits Y-up glTF while the opencascade kernel emits Z-up,
 * so replicad bounds are mapped back to Z-up before comparing — a genuinely
 * rotated port still fails, only the known convention difference is cancelled.
 *
 * Run from packages/testing:
 *
 *   npx tsx scripts/compare-ports.ts [--project <id>] [--sets 12]
 */
/* oxlint-disable no-await-in-loop -- parameter sets render one at a time on purpose: concurrent OCCT WASM instances multiply peak memory, and the table has to stay in sweep order */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { createRuntimeClient } from '@taucad/runtime';
import { inProcessTransport } from '@taucad/runtime/transport/in-process';
import { fromMemoryFs } from '@taucad/runtime/filesystem';
import { esbuild } from '@taucad/runtime/bundler';
import { opencascade, replicad } from '@taucad/runtime/kernels';
import { boundsOf, meshVolume, readMesh, toZup } from '#scripts/lib/glb-measure.js';
import type { Bounds } from '#scripts/lib/glb-measure.js';

const projectsDirectory = resolve(import.meta.dirname, '../../../apps/ui/app/routes/playground/projects');
const argumentValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const projectFilter = argumentValue('project');
const maximumSets = Number(argumentValue('sets') ?? 12);
// Deltas above these are reported as failures. Tessellation differs between the
// two kernels' meshers, so volume needs more slack than extents.
const boundsToleranceMm = 0.05;
const volumeTolerancePercent = 1;

type Pair = { project: string; occtEntry: string; replicadEntry: string };

function discoverPairs(): Pair[] {
  const pairs: Pair[] = [];
  for (const project of readdirSync(projectsDirectory).sort()) {
    const metadataPath = join(projectsDirectory, project, 'project.json');
    if (!existsSync(metadataPath) || (projectFilter && project !== projectFilter)) {
      continue;
    }

    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
      variants?: Array<{ id: string; entry: string }>;
    };
    const occtEntry = metadata.variants?.find((variant) => variant.id === 'opencascade')?.entry;
    const replicadEntry = metadata.variants?.find((variant) => variant.id === 'replicad')?.entry;
    if (occtEntry && replicadEntry) {
      pairs.push({ project, occtEntry, replicadEntry });
    }
  }

  return pairs;
}

function projectFiles(project: string): Record<string, string> {
  const root = join(projectsDirectory, project);
  const files: Record<string, string> = {};
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
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

/**
 * Defaults plus one set per parameter, nudged off its default. Numbers move by
 * ±25% (or ±1 for small integers), booleans flip. One parameter at a time keeps
 * a failure attributable to the parameter that caused it.
 */
function parameterSets(
  defaults: Record<string, unknown>,
): Array<{ label: string; parameters: Record<string, unknown> }> {
  const sets: Array<{ label: string; parameters: Record<string, unknown> }> = [{ label: 'defaults', parameters: {} }];
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === 'boolean') {
      sets.push({ label: `${key}=${!value}`, parameters: { [key]: !value } });
      continue;
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      continue;
    }

    const current: number = value;
    for (const factor of [0.75, 1.25]) {
      const isSmallInteger = Number.isInteger(current) && Math.abs(current) <= 8;
      const next: number = isSmallInteger
        ? Math.max(1, current + (factor < 1 ? -1 : 1))
        : Number((current * factor).toFixed(4));
      if (next !== current) {
        sets.push({ label: `${key}=${next}`, parameters: { [key]: next } });
      }
    }
  }

  return sets.slice(0, maximumSets);
}

type Measurement = { bounds: Bounds; volume: number; triangles: number; milliseconds: number };

async function measure(
  client: ReturnType<typeof createRuntimeClient>,
  file: string,
  { parameters, zUpCorrection }: { parameters: Record<string, unknown>; zUpCorrection: boolean },
): Promise<Measurement | string> {
  const started = Date.now();
  const result = await client.export('glb', { file, parameters, coordinateSystem: 'z-up' });
  if (!result.success) {
    return `FAILED: ${result.issues.map((issue) => issue.message).join('; ')}`;
  }

  const mesh = readMesh(result.data.bytes);
  if (mesh.indices.length === 0) {
    return 'FAILED: empty geometry';
  }

  const bounds = boundsOf(mesh);
  return {
    bounds: zUpCorrection ? toZup(bounds) : bounds,
    volume: meshVolume(mesh),
    triangles: mesh.indices.length / 3,
    milliseconds: Date.now() - started,
  };
}

/** Resolved defaults straight from the kernel, so the sweep matches the model. */
async function resolveDefaults(
  client: ReturnType<typeof createRuntimeClient>,
  file: string,
): Promise<Record<string, unknown>> {
  let defaults: Record<string, unknown> = {};
  const unsubscribe = client.on('parametersResolved', (result) => {
    if (result.success) {
      defaults = result.data.defaultParameters;
    }
  });
  await client.openFile({ file });
  unsubscribe();
  return defaults;
}

let failures = 0;
const pairs = discoverPairs();
if (pairs.length === 0) {
  console.log('No project declares both an opencascade and a replicad variant.');
}

for (const pair of pairs) {
  const files = projectFiles(pair.project);
  // One client per kernel: a second OpenCascade client in a process fails, and
  // within one client the first file's kernel keeps handling later files.
  const occtClient = createRuntimeClient({
    transport: inProcessTransport({ fileSystem: fromMemoryFs(files) }),
    kernels: [opencascade()],
    bundlers: [esbuild()],
  });
  const replicadClient = createRuntimeClient({
    transport: inProcessTransport({ fileSystem: fromMemoryFs(files) }),
    kernels: [replicad()],
    bundlers: [esbuild()],
  });

  try {
    const defaults = await resolveDefaults(occtClient, `/${pair.occtEntry}`);
    const sets = parameterSets(defaults);
    console.log(`\n${pair.project}: ${sets.length} parameter set(s), ${Object.keys(defaults).length} parameter(s)`);
    console.log(
      `  ${'parameter set'.padEnd(30)}${'occt mm³'.padEnd(13)}${'replicad mm³'.padEnd(14)}${'Δvol'.padEnd(9)}${'Δbbox'.padEnd(10)}verdict`,
    );

    for (const set of sets) {
      const [occtResult, replicadResult] = [
        await measure(occtClient, `/${pair.occtEntry}`, { parameters: set.parameters, zUpCorrection: false }),
        await measure(replicadClient, `/${pair.replicadEntry}`, { parameters: set.parameters, zUpCorrection: true }),
      ];

      if (typeof occtResult === 'string' || typeof replicadResult === 'string') {
        failures += 1;
        console.log(
          `  ${set.label.padEnd(30)}${typeof occtResult === 'string' ? `occt ${occtResult}` : ''}` +
            `${typeof replicadResult === 'string' ? ` replicad ${replicadResult}` : ''}`,
        );
        continue;
      }

      const boundsDelta = Math.max(
        ...occtResult.bounds.min.map((value, axis) => Math.abs(value - replicadResult.bounds.min[axis]!)),
        ...occtResult.bounds.max.map((value, axis) => Math.abs(value - replicadResult.bounds.max[axis]!)),
      );
      const volumeDeltaPercent =
        occtResult.volume === 0 ? 0 : ((replicadResult.volume - occtResult.volume) / occtResult.volume) * 100;
      const passed = boundsDelta <= boundsToleranceMm && Math.abs(volumeDeltaPercent) <= volumeTolerancePercent;
      if (!passed) {
        failures += 1;
      }

      console.log(
        `  ${set.label.padEnd(30)}${occtResult.volume.toFixed(1).padEnd(13)}${replicadResult.volume.toFixed(1).padEnd(14)}` +
          `${`${volumeDeltaPercent.toFixed(2)}%`.padEnd(9)}${`${boundsDelta.toFixed(3)}mm`.padEnd(10)}${passed ? '✔' : '✘'}`,
      );
    }
  } finally {
    occtClient.terminate();
    replicadClient.terminate();
  }
}

console.log(
  failures === 0
    ? '\nAll parameter sets agree within tolerance.'
    : `\n${failures} parameter set(s) outside tolerance (${boundsToleranceMm} mm bounds, ${volumeTolerancePercent}% volume).`,
);
if (failures > 0) {
  process.exitCode = 1;
}
