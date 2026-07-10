import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

type ManifestEntry = {
  readonly module: string;
  readonly imports?: readonly string[];
};

type ReactRouterManifest = {
  readonly entry: ManifestEntry;
  readonly routes: Readonly<Record<string, ManifestEntry>>;
};

const kibibyte = 1024;
const mebibyte = 1024 * kibibyte;
const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
const clientDirectory = join(scriptDirectory, '..', 'build', 'client');
const assetsDirectory = join(clientDirectory, 'assets');

const manifestFile = readdirSync(assetsDirectory).find((file) => file.startsWith('manifest-') && file.endsWith('.js'));
if (!manifestFile) {
  throw new Error('Client bundle budget: React Router manifest asset is missing');
}

const manifestSource = readFileSync(join(assetsDirectory, manifestFile), 'utf8');
const assignmentIndex = manifestSource.indexOf('=');
const manifest = JSON.parse(manifestSource.slice(assignmentIndex + 1, -1)) as ReactRouterManifest;

const routeBudgets = [
  { name: 'gallery', routeIds: ['root', 'routes/_index/route'], gzipBytes: 400 * kibibyte },
  { name: 'playground', routeIds: ['root', 'routes/playground/route'], gzipBytes: 1250 * kibibyte },
] as const;

const filesForRoutes = (routeIds: readonly string[]): Set<string> => {
  const files = new Set([manifest.entry.module, ...(manifest.entry.imports ?? [])]);
  for (const routeId of routeIds) {
    const route = manifest.routes[routeId];
    if (!route) {
      throw new Error(`Client bundle budget: manifest route ${routeId} is missing`);
    }
    files.add(route.module);
    for (const imported of route.imports ?? []) {
      files.add(imported);
    }
  }
  return files;
};

let failed = false;
for (const budget of routeBudgets) {
  const files = filesForRoutes(budget.routeIds);
  let gzipBytes = 0;
  for (const assetPath of files) {
    const bytes = readFileSync(join(clientDirectory, assetPath));
    gzipBytes += gzipSync(bytes).byteLength;
  }
  console.info(`${budget.name}: ${gzipBytes} gzip bytes across ${files.size} initial JS assets`);
  if (gzipBytes > budget.gzipBytes) {
    console.error(`${budget.name} exceeds ${budget.gzipBytes} gzip bytes`);
    failed = true;
  }
}

const workerFile = readdirSync(assetsDirectory).find(
  (file) => file.startsWith('file-manager.worker-') && file.endsWith('.js'),
);
if (!workerFile) {
  throw new Error('Client bundle budget: file-manager worker asset is missing');
}

const workerBytes = statSync(join(assetsDirectory, workerFile)).size;
console.info(`file-manager worker: ${workerBytes} raw bytes`);
if (workerBytes > 2 * mebibyte) {
  console.error('file-manager worker exceeds 2 MiB; kernel declarations may have leaked back into startup');
  failed = true;
}

if (failed) {
  process.exitCode = 1;
}
