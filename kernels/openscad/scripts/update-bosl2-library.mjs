import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const bosl2Version = 'v2.0.744';
const bosl2ArchiveUrl = `https://github.com/BelfrySCAD/BOSL2/archive/refs/tags/${bosl2Version}.tar.gz`;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = dirname(scriptDirectory);
const outputPath = join(packageDirectory, 'src/bosl2-library.generated.ts');

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tau-bosl2-'));
const archivePath = join(temporaryDirectory, `BOSL2-${bosl2Version}.tar.gz`);

try {
  await download(bosl2ArchiveUrl, archivePath);
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
  const entries = [];

  for (const file of files) {
    const libraryPath = `BOSL2/${relative(rootDirectory, file).replaceAll('\\', '/')}`;
    const content = await readFile(file, 'utf8');
    entries.push([libraryPath, content]);
  }

  const fileMap = entries.map(([path, content]) => `  ${JSON.stringify(path)}: ${JSON.stringify(content)},`).join('\n');
  await writeFile(
    outputPath,
    `// Generated from BelfrySCAD/BOSL2 ${bosl2Version}.\n// Run scripts/update-bosl2-library.mjs to refresh.\n\nexport const bosl2Version = '${bosl2Version}';\n\nexport const bosl2LibraryFiles: Readonly<Record<string, string>> = {\n${fileMap}\n};\n`,
  );

  console.log(`Wrote ${entries.length} BOSL2 files to ${outputPath}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
