import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

const execFile = promisify(execFileCallback);
const bosl2Version = 'v2.0.744';
const bosl2ArchiveUrl = `https://github.com/BelfrySCAD/BOSL2/archive/refs/tags/${bosl2Version}.tar.gz`;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = dirname(scriptDirectory);
const outputPath = join(packageDirectory, 'src/bosl2-library.generated.ts');
const assetPath = join(packageDirectory, 'src/bosl2-library.generated.json.gz');

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tau-bosl2-'));
const archivePath = join(temporaryDirectory, `BOSL2-${bosl2Version}.tar.gz`);

try {
  const response = await fetch(bosl2ArchiveUrl);
  if (!response.ok) {
    throw new Error(`Failed to download ${bosl2ArchiveUrl}: ${response.status} ${response.statusText}`);
  }

  await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
  await execFile('tar', ['-xzf', archivePath, '-C', temporaryDirectory]);

  const { stdout: rootStdout } = await execFile('find', [
    temporaryDirectory,
    '-mindepth',
    '1',
    '-maxdepth',
    '1',
    '-type',
    'd',
  ]);
  const rootDirectory = rootStdout.trim().split('\n')[0];
  if (!rootDirectory) {
    throw new Error('Could not find extracted BOSL2 root directory');
  }

  const { stdout } = await execFile('find', [rootDirectory, '-type', 'f', '-name', '*.scad']);
  const files = stdout.trim().split('\n').filter(Boolean).sort();

  const entries = await Promise.all(
    files.map(async (file) => {
      const libraryPath = `BOSL2/${relative(rootDirectory, file).replaceAll('\\', '/')}`;
      return [libraryPath, await readFile(file, 'utf8')];
    }),
  );

  const jsonPayload = JSON.stringify(Object.fromEntries(entries));
  const compressedPayload = gzipSync(jsonPayload, { level: 9 });
  await writeFile(assetPath, compressedPayload);

  await writeFile(
    outputPath,
    `// Generated from BelfrySCAD/BOSL2 ${bosl2Version}.\n// Run scripts/update-bosl2-library.mjs to refresh.\n\nexport const bosl2Version = '${bosl2Version}';\nexport const bosl2LibraryUrl = new URL('bosl2-library.generated.json.gz', import.meta.url).href;\n`,
  );

  console.log(`Wrote ${entries.length} BOSL2 files to ${assetPath}`);
  console.log(`Wrote BOSL2 asset metadata to ${outputPath}`);
  console.log(`BOSL2 JSON: ${jsonPayload.length} bytes, gzip: ${compressedPayload.length} bytes`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
