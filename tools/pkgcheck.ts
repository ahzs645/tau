/* eslint-disable n/prefer-global/process, unicorn/no-process-exit -- CLI tool */

/**
 * Package Check Orchestrator
 *
 * Validates that a publishable package is ready for npm publication by running
 * a suite of checks: publint, attw (are-the-types-wrong), and madge (circular deps).
 *
 * Usage: tsx tools/pkgcheck.ts <projectRoot>
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

type CheckResult = {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  details?: string[];
};

type PackageJson = Record<string, unknown> & {
  name?: string;
  publishConfig?: Record<string, unknown>;
  'size-limit'?: unknown;
};

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('Usage: tsx tools/pkgcheck.ts <projectRoot>');
  process.exit(1);
}

const absoluteRoot = resolve(projectRoot);
const packageJsonPath = join(absoluteRoot, 'package.json');

if (!existsSync(packageJsonPath)) {
  console.error(`No package.json found at ${packageJsonPath}`);
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse returns any
const packageJson: PackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const packageName = packageJson.name ?? projectRoot;

console.log(`\n${packageName} package check`);
console.log('='.repeat(`${packageName} package check`.length));
console.log();

const results: CheckResult[] = [];

async function runPublint(): Promise<CheckResult> {
  try {
    const { publint } = await import('publint');
    const { formatMessage } = await import('publint/utils');

    const { messages, pkg } = await publint({
      pkgDir: absoluteRoot,
      level: 'warning',
    });

    if (messages.length === 0) {
      return { name: 'publint', status: 'pass', details: ['package structure valid'] };
    }

    const formatted = messages
      .map((message) => formatMessage(message, pkg))
      .filter((m): m is string => m !== undefined);
    return {
      name: 'publint',
      status: 'fail',
      details: [`${String(messages.length)} issue(s) found`, ...formatted],
    };
  } catch (error) {
    return {
      name: 'publint',
      status: 'fail',
      details: [`error running publint: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/**
 * Apply publishConfig overrides to a package.json object, the same way
 * `npm publish` / `pnpm publish` does at publish time.
 */
function applyPublishConfig(pkg: PackageJson): PackageJson {
  const result = { ...pkg };
  const { publishConfig } = pkg;
  if (!publishConfig) {
    return result;
  }

  for (const [key, value] of Object.entries(publishConfig)) {
    if (key === 'access' || key === 'registry' || key === 'tag') {
      continue;
    }

    result[key] = value;
  }

  delete result.publishConfig;
  return result;
}

/**
 * Create a publish-ready staging directory with publishConfig applied,
 * then pack and run attw against the tarball.
 *
 * pnpm pack does NOT apply publishConfig.exports, so we must do it manually.
 */
async function runAttw(): Promise<CheckResult> {
  const stagingDir = join(tmpdir(), `pkgcheck-attw-${Date.now()}`);

  try {
    mkdirSync(stagingDir, { recursive: true });

    const publishPkg = applyPublishConfig(packageJson);
    writeFileSync(join(stagingDir, 'package.json'), JSON.stringify(publishPkg, undefined, 2));

    const distSrc = join(absoluteRoot, 'dist');
    if (existsSync(distSrc)) {
      cpSync(distSrc, join(stagingDir, 'dist'), { recursive: true });
    }

    const readmeSrc = join(absoluteRoot, 'README.md');
    if (existsSync(readmeSrc)) {
      cpSync(readmeSrc, join(stagingDir, 'README.md'));
    }

    const attwConfigSrc = join(absoluteRoot, '.attw.json');
    if (existsSync(attwConfigSrc)) {
      cpSync(attwConfigSrc, join(stagingDir, '.attw.json'));
    }

    const output = execSync('pnpm attw --pack . --format table', {
      cwd: stagingDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return { name: 'attw', status: 'pass', details: ['types resolve correctly', output.trim()] };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; status?: number };
    const output = (execError.stdout ?? '') + (execError.stderr ?? '');
    const lines = output.split('\n').filter((line) => line.trim().length > 0);

    return {
      name: 'attw',
      status: 'fail',
      details: ['type resolution issues found', ...lines],
    };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

async function runMadge(): Promise<CheckResult> {
  try {
    const madgeModule = await import('madge');
    const madge = madgeModule.default;

    const tsconfigPath = existsSync(join(absoluteRoot, 'tsconfig.lib.json'))
      ? join(absoluteRoot, 'tsconfig.lib.json')
      : join(absoluteRoot, 'tsconfig.json');

    const result = await madge(join(absoluteRoot, 'src'), {
      fileExtensions: ['ts', 'tsx', 'js', 'jsx'],
      tsConfig: tsconfigPath,
      excludeRegExp: [/\.test\./, /\.spec\./, /\/testing\//],
    });

    const circular = result.circular();

    if (circular.length === 0) {
      return { name: 'madge', status: 'pass', details: ['no circular dependencies'] };
    }

    const cycles = circular.map((cycle) => cycle.join(' → '));
    return {
      name: 'madge',
      status: 'fail',
      details: [`${String(circular.length)} circular dependency chain(s) found`, ...cycles],
    };
  } catch (error) {
    return {
      name: 'madge',
      status: 'fail',
      details: [`error running madge: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

async function runSizeLimit(): Promise<CheckResult> {
  if (!packageJson['size-limit']) {
    return { name: 'size-limit', status: 'skip', details: ['no config found in package.json'] };
  }

  try {
    const output = execSync('pnpm size-limit', {
      cwd: absoluteRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return { name: 'size-limit', status: 'pass', details: [output.trim()] };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string };
    const output = (execError.stdout ?? '') + (execError.stderr ?? '');
    return {
      name: 'size-limit',
      status: 'fail',
      details: ['bundle size budget exceeded', output.trim()],
    };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }

  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} kB`;
  }

  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

function walkDir(dir: string): string[] {
  const paths: string[] = [];
  if (!existsSync(dir)) {
    return paths;
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...walkDir(fullPath));
    } else {
      paths.push(fullPath);
    }
  }

  return paths;
}

type ExportsCondition = {
  types?: string;
  default?: string;
};

type ExportsEntry = {
  require?: ExportsCondition;
  import?: ExportsCondition;
};

type ExportsMap = Record<string, ExportsEntry | string>;

function fileSize(relativePath: string | undefined): number {
  if (!relativePath) {
    return 0;
  }

  const fullPath = join(absoluteRoot, relativePath);
  return existsSync(fullPath) ? statSync(fullPath).size : 0;
}

function collectAssets(dir: string): Map<string, { count: number; bytes: number }> {
  const byExt = new Map<string, { count: number; bytes: number }>();
  for (const f of walkDir(dir)) {
    if (/\.(js|cjs|mjs|d\.ts|d\.cts|d\.mts)$/.test(basename(f))) {
      continue;
    }

    const ext = basename(f).split('.').pop() ?? '?';
    const entry = byExt.get(ext) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += statSync(f).size;
    byExt.set(ext, entry);
  }

  return byExt;
}

type ExportRow = {
  specifier: string;
  jsBytes: number;
  dtsBytes: number;
  assets: Map<string, { count: number; bytes: number }>;
  total: number;
};

function buildExportRows(): ExportRow[] {
  const publishPkg = applyPublishConfig(packageJson);
  const exports = publishPkg['exports'] as ExportsMap | undefined;
  if (!exports) {
    return [];
  }

  const rows: ExportRow[] = [];
  for (const [specifier, value] of Object.entries(exports)) {
    if (typeof value === 'string') {
      const size = fileSize(value);
      rows.push({ specifier, jsBytes: size, dtsBytes: 0, assets: new Map(), total: size });
      continue;
    }

    const jsBytes = fileSize(value.import?.default);
    const dtsBytes = fileSize(value.import?.types);
    const esmDir = value.import?.default ? dirname(join(absoluteRoot, value.import.default)) : undefined;
    const isRootExport = esmDir === join(absoluteRoot, 'dist', 'esm');
    const assets =
      esmDir && !isRootExport && existsSync(esmDir)
        ? collectAssets(esmDir)
        : new Map<string, { count: number; bytes: number }>();
    const assetBytes = [...assets.values()].reduce((sum, { bytes }) => sum + bytes, 0);

    rows.push({ specifier, jsBytes, dtsBytes, assets, total: jsBytes + dtsBytes + assetBytes });
  }

  return rows;
}

function formatAssetCell(bytes: number, count: number, width: number): string {
  const sizeText = formatBytes(bytes);
  return `${sizeText} (${String(count)})`.padStart(width);
}

function printExportsSummary(): void {
  const rows = buildExportRows();
  if (rows.length === 0) {
    return;
  }

  const allAssetTypes = [...new Set(rows.flatMap((r) => [...r.assets.keys()]))].sort();
  const sizeCol = 10;
  const specCol = Math.max(...rows.map((r) => r.specifier.length), 10);
  const assetColWidth = 15;

  const assetHeaders = allAssetTypes.map((ext) => `.${ext}`.padStart(assetColWidth)).join('');
  const header = `  ${'Specifier'.padEnd(specCol)}${'JS'.padStart(sizeCol)}${'Types'.padStart(sizeCol)}${assetHeaders}${'Total'.padStart(sizeCol)}`;
  const divider = '─'.repeat(header.length - 2);

  console.log('\n  Exports');
  console.log(`  ${divider}`);
  console.log(header);
  console.log(`  ${divider}`);

  for (const row of rows) {
    const assetCells = allAssetTypes
      .map((ext) => {
        const entry = row.assets.get(ext);
        return entry ? formatAssetCell(entry.bytes, entry.count, assetColWidth) : '—'.padStart(assetColWidth);
      })
      .join('');

    const dtsCell = row.dtsBytes > 0 ? formatBytes(row.dtsBytes).padStart(sizeCol) : '—'.padStart(sizeCol);
    console.log(
      `  ${row.specifier.padEnd(specCol)}${formatBytes(row.jsBytes).padStart(sizeCol)}${dtsCell}${assetCells}${formatBytes(row.total).padStart(sizeCol)}`,
    );
  }

  let totalJs = 0;
  let totalDts = 0;
  let totalAll = 0;
  for (const row of rows) {
    totalJs += row.jsBytes;
    totalDts += row.dtsBytes;
    totalAll += row.total;
  }

  const totalAssetCells = allAssetTypes
    .map((ext) => {
      let bytes = 0;
      let count = 0;
      for (const row of rows) {
        const entry = row.assets.get(ext);
        if (entry) {
          bytes += entry.bytes;
          count += entry.count;
        }
      }

      return bytes > 0 ? formatAssetCell(bytes, count, assetColWidth) : '—'.padStart(assetColWidth);
    })
    .join('');

  console.log(`  ${divider}`);
  const totalDtsCell = totalDts > 0 ? formatBytes(totalDts).padStart(sizeCol) : '—'.padStart(sizeCol);
  console.log(
    `  ${`Total (${String(rows.length)} exports)`.padEnd(specCol)}${formatBytes(totalJs).padStart(sizeCol)}${totalDtsCell}${totalAssetCells}${formatBytes(totalAll).padStart(sizeCol)}`,
  );
}

type DistRow = {
  label: string;
  fileCount: number;
  jsBytes: number;
  dtsBytes: number;
  assets: Map<string, { count: number; bytes: number }>;
  total: number;
};

function buildDistRows(): DistRow[] {
  const distDir = join(absoluteRoot, 'dist');
  if (!existsSync(distDir)) {
    return [];
  }

  const rows: DistRow[] = [];
  const subdirs = readdirSync(distDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const sub of subdirs) {
    const files = walkDir(join(distDir, sub));
    let jsBytes = 0;
    let dtsBytes = 0;
    let total = 0;
    const assets = new Map<string, { count: number; bytes: number }>();

    for (const f of files) {
      const { size } = statSync(f);
      total += size;
      const name = basename(f);

      if (/\.(js|cjs|mjs)$/.test(name)) {
        jsBytes += size;
      } else if (/\.(d\.ts|d\.cts|d\.mts)$/.test(name)) {
        dtsBytes += size;
      } else {
        const ext = name.split('.').pop() ?? '?';
        const entry = assets.get(ext) ?? { count: 0, bytes: 0 };
        entry.count += 1;
        entry.bytes += size;
        assets.set(ext, entry);
      }
    }

    rows.push({ label: `dist/${sub}`, fileCount: files.length, jsBytes, dtsBytes, assets, total });
  }

  const topLevelFiles = readdirSync(distDir, { withFileTypes: true }).filter((d) => d.isFile());
  for (const file of topLevelFiles) {
    const { size } = statSync(join(distDir, file.name));
    rows.push({
      label: `dist/${file.name}`,
      fileCount: 1,
      jsBytes: 0,
      dtsBytes: 0,
      assets: new Map([['other', { count: 1, bytes: size }]]),
      total: size,
    });
  }

  return rows;
}

function printSizeSummary(): void {
  const rows = buildDistRows();
  if (rows.length === 0) {
    return;
  }

  const allAssetTypes = [...new Set(rows.flatMap((r) => [...r.assets.keys()]))].sort();
  const sizeCol = 10;
  const labelCol = Math.max(...rows.map((r) => r.label.length), 10);
  const filesCol = 8;
  const assetColWidth = 15;

  const assetHeaders = allAssetTypes.map((ext) => `.${ext}`.padStart(assetColWidth)).join('');
  const header = `  ${''.padEnd(labelCol)}${'Files'.padStart(filesCol)}${'JS'.padStart(sizeCol)}${'Types'.padStart(sizeCol)}${assetHeaders}${'Total'.padStart(sizeCol)}`;
  const divider = '─'.repeat(header.length - 2);

  console.log('\n  Size');
  console.log(`  ${divider}`);
  console.log(header);
  console.log(`  ${divider}`);

  for (const row of rows) {
    const assetCells = allAssetTypes
      .map((ext) => {
        const entry = row.assets.get(ext);
        return entry ? formatAssetCell(entry.bytes, entry.count, assetColWidth) : '—'.padStart(assetColWidth);
      })
      .join('');

    console.log(
      `  ${row.label.padEnd(labelCol)}${String(row.fileCount).padStart(filesCol)}${formatBytes(row.jsBytes).padStart(sizeCol)}${formatBytes(row.dtsBytes).padStart(sizeCol)}${assetCells}${formatBytes(row.total).padStart(sizeCol)}`,
    );
  }

  let sumFiles = 0;
  let sumJs = 0;
  let sumDts = 0;
  let sumTotal = 0;
  for (const row of rows) {
    sumFiles += row.fileCount;
    sumJs += row.jsBytes;
    sumDts += row.dtsBytes;
    sumTotal += row.total;
  }

  const totalAssetCells = allAssetTypes
    .map((ext) => {
      let bytes = 0;
      let count = 0;
      for (const row of rows) {
        const entry = row.assets.get(ext);
        if (entry) {
          bytes += entry.bytes;
          count += entry.count;
        }
      }

      return bytes > 0 ? formatAssetCell(bytes, count, assetColWidth) : '—'.padStart(assetColWidth);
    })
    .join('');

  console.log(`  ${divider}`);
  console.log(
    `  ${'Total'.padEnd(labelCol)}${String(sumFiles).padStart(filesCol)}${formatBytes(sumJs).padStart(sizeCol)}${formatBytes(sumDts).padStart(sizeCol)}${totalAssetCells}${formatBytes(sumTotal).padStart(sizeCol)}`,
  );
}

function printResult(result: CheckResult): void {
  const icon = result.status === 'pass' ? '✓' : result.status === 'fail' ? '✗' : '⊘';
  const tag = result.status.toUpperCase();
  const summary = result.details?.[0] ?? '';

  console.log(`  [${tag}] ${icon} ${result.name} -- ${summary}`);

  if (result.status === 'fail' && result.details && result.details.length > 1) {
    for (const detail of result.details.slice(1)) {
      for (const line of detail.split('\n')) {
        console.log(`         ${line}`);
      }
    }
  }
}

async function main(): Promise<void> {
  results.push(await runPublint());
  printResult(results.at(-1)!);

  results.push(await runAttw());
  printResult(results.at(-1)!);

  results.push(await runMadge());
  printResult(results.at(-1)!);

  results.push(await runSizeLimit());
  printResult(results.at(-1)!);

  printExportsSummary();
  printSizeSummary();

  const failures = results.filter((r) => r.status === 'fail');
  console.log();

  if (failures.length > 0) {
    console.log(`${String(failures.length)} check(s) failed. Package is NOT ready for publishing.`);
    process.exit(1);
  }

  console.log('All checks passed. Package is ready for publishing.');
}

await main();
