/**
 * Headless variant renderer for the playground projects.
 *
 * Renders every kernel variant a project declares in its `project.json` through
 * the real kernels, writes a GLB per variant, and reports the geometry each one
 * produced (bounding box, triangle count, render time) so ports can be compared
 * against their original instead of only checked for "did it render".
 *
 * The variant list is read from `project.json` — the same source the playground
 * loads — so a new variant is covered here the moment it is declared.
 *
 * Run from packages/testing (so workspace deps resolve):
 *
 *   npx tsx scripts/render-variants.ts [outDir] [--project <id>]
 */
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { createRuntimeClient } from '@taucad/runtime';
import { inProcessTransport } from '@taucad/runtime/transport/in-process';
import { fromMemoryFs } from '@taucad/runtime/filesystem';
import { esbuild } from '@taucad/runtime/bundler';
import { opencascade, replicad } from '@taucad/runtime/kernels';
import { openscad } from '@taucad/openscad';

type RuntimeClientInstance = ReturnType<typeof createRuntimeClient>;

const projectsDirectory = resolve(import.meta.dirname, '../../../apps/ui/app/routes/playground/projects');
const positional = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const projectFilterIndex = process.argv.indexOf('--project');
const projectFilter = projectFilterIndex === -1 ? undefined : process.argv[projectFilterIndex + 1];
const outDirectory = positional[0] ?? resolve(import.meta.dirname, '../renders');

type VariantSpec = { project: string; variant: string; entry: string };
type Bounds = { min: [number, number, number]; max: [number, number, number] };
type VariantReport = VariantSpec & {
  bytes: number;
  milliseconds: number;
  triangles: number;
  bounds: Bounds;
};

/** Every declared variant of every project, defaulting to the single entry. */
function discoverSpecs(): VariantSpec[] {
  const specs: VariantSpec[] = [];
  for (const project of readdirSync(projectsDirectory).sort()) {
    const metadataPath = join(projectsDirectory, project, 'project.json');
    if (!existsSync(metadataPath) || (projectFilter && project !== projectFilter)) {
      continue;
    }

    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
      entry: string;
      hidden?: boolean;
      variants?: Array<{ id: string; entry: string }>;
    };
    if (metadata.hidden || !metadata.entry.match(/\.(scad|ts|js)$/u)) {
      continue;
    }

    if (metadata.variants) {
      specs.push(...metadata.variants.map((variant) => ({ project, variant: variant.id, entry: variant.entry })));
      continue;
    }

    specs.push({ project, variant: 'default', entry: metadata.entry });
  }

  return specs;
}

/**
 * Every project's sources under `/<project>/…` in one filesystem, because a run
 * shares one client per kernel. Two runtime constraints force that shape:
 *
 * - A second OpenCascade kernel client in the same process fails with an embind
 *   registry error ("Expected null or instance of TopoDS_Shape, got an instance
 *   of TopoDS_Shape"), so a client per spec can only render one OCCT model.
 * - Within one client, the kernel that handled the first file keeps handling
 *   later ones, so a `.ts` entry exported after a `.scad` entry is fed to
 *   OpenSCAD and fails with "syntax error".
 *
 * One client per kernel, each seeing every project's files, satisfies both.
 */
function allProjectFiles(specs: readonly VariantSpec[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const project of new Set(specs.map((spec) => spec.project))) {
    for (const [path, content] of Object.entries(projectFiles(project))) {
      files[`/${project}${path}`] = content;
    }
  }

  return files;
}

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

/**
 * Positions and index count straight out of the GLB, so the comparison is on
 * the geometry that ships rather than on the kernel's internal shape.
 */
function measureGlb(bytes: Uint8Array): { bounds: Bounds; triangles: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as {
    meshes?: Array<{ primitives: Array<{ attributes: { POSITION: number }; indices?: number }> }>;
    accessors?: Array<{ count: number; min?: number[]; max?: number[] }>;
  };

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;

  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      const position = json.accessors?.[primitive.attributes.POSITION];
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis]!, position?.min?.[axis] ?? Infinity);
        max[axis] = Math.max(max[axis]!, position?.max?.[axis] ?? -Infinity);
      }

      const indices = primitive.indices === undefined ? undefined : json.accessors?.[primitive.indices];
      triangles += Math.floor((indices?.count ?? position?.count ?? 0) / 3);
    }
  }

  return { bounds: { min, max }, triangles };
}

type KernelName = 'openscad' | 'opencascade' | 'replicad';

/** The kernel the runtime will route this entry to (extension, then imports). */
function kernelForSpec(spec: VariantSpec, files: Record<string, string>): KernelName {
  if (spec.entry.endsWith('.scad')) {
    return 'openscad';
  }

  const source = files[`/${spec.project}/${spec.entry}`] ?? '';
  return /from\s+['"]opencascade\.js['"]/u.test(source) ? 'opencascade' : 'replicad';
}

function createClient(kernel: KernelName, files: Record<string, string>): RuntimeClientInstance {
  const kernels = {
    openscad: [openscad()],
    opencascade: [opencascade()],
    replicad: [replicad()],
  }[kernel];

  return createRuntimeClient({
    transport: inProcessTransport({ fileSystem: fromMemoryFs(files) }),
    kernels,
    bundlers: [esbuild()],
  });
}

async function renderVariant(client: RuntimeClientInstance, spec: VariantSpec): Promise<VariantReport> {
  const entryPath = `/${spec.project}/${spec.entry}`;

  {
    const started = Date.now();
    const result = await client.export('glb', { file: entryPath });
    if (!result.success) {
      throw new Error(
        `${spec.project}/${spec.variant} export failed:\n${result.issues
          .map((issue) => `- ${issue.message}`)
          .join('\n')}`,
      );
    }

    const milliseconds = Date.now() - started;
    writeFileSync(join(outDirectory, `${spec.project}--${spec.variant}.glb`), result.data.bytes);
    return {
      ...spec,
      bytes: result.data.bytes.length,
      milliseconds,
      ...measureGlb(result.data.bytes),
    };
  }
}

// glTF positions are metres; models are authored in millimetres.
const toMillimetres = (value: number): number => value * 1000;
const format = (value: number): string => toMillimetres(value).toFixed(1).padStart(8);
const formatBounds = (bounds: Bounds): string =>
  `[${bounds.min.map((value) => format(value)).join(' ')} ] → [${bounds.max.map((value) => format(value)).join(' ')} ]`;

mkdirSync(outDirectory, { recursive: true });
const reports: VariantReport[] = [];
const failures: Array<{ spec: VariantSpec; error: unknown }> = [];
const specs = discoverSpecs();
const files = allProjectFiles(specs);
const byKernel = new Map<KernelName, VariantSpec[]>();
for (const spec of specs) {
  const kernel = kernelForSpec(spec, files);
  byKernel.set(kernel, [...(byKernel.get(kernel) ?? []), spec]);
}

for (const [kernel, kernelSpecs] of byKernel) {
  const client = createClient(kernel, files);
  try {
    for (const spec of kernelSpecs) {
      // Sequential on purpose: two OCCT WASM instances at once double peak memory.
      try {
        const report = await renderVariant(client, spec);
        reports.push(report);
        console.log(
          `✔ ${report.project}/${report.variant} ${String(report.milliseconds).padStart(6)}ms ` +
            `${String(report.triangles).padStart(7)} tris  ${formatBounds(report.bounds)}`,
        );
      } catch (error) {
        failures.push({ spec, error });
        console.error(`✘ ${spec.project}/${spec.variant}: ${String(error).replaceAll('\n', ' ')}`);
      }
    }
  } finally {
    client.terminate();
  }
}

// Per-project parity: every variant of a project should agree on the model's
// extents, whatever kernel produced it.
console.log('\nVariant parity (max bounding-box delta against the default variant):');
for (const project of [...new Set(reports.map((report) => report.project))]) {
  const projectReports = reports.filter((report) => report.project === project);
  const [reference, ...others] = projectReports;
  if (!reference || others.length === 0) {
    continue;
  }

  for (const other of others) {
    const delta = toMillimetres(
      Math.max(
        ...reference.bounds.min.map((value, axis) => Math.abs(value - other.bounds.min[axis]!)),
        ...reference.bounds.max.map((value, axis) => Math.abs(value - other.bounds.max[axis]!)),
      ),
    );
    console.log(
      `  ${project}: ${reference.variant} vs ${other.variant} → ${delta.toFixed(3)} mm ${delta < 0.5 ? '✔' : '✘'}`,
    );
  }
}

if (failures.length > 0) {
  process.exitCode = 1;
}
