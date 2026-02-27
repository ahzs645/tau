/* eslint-disable n/prefer-global/process -- CLI script requires direct process access */
/* eslint-disable unicorn/no-process-exit -- CLI script uses process.exit for error codes */
/**
 * Kernel Benchmarking CLI
 *
 * Run with: pnpm nx benchmark kernels
 *
 * Usage:
 *   pnpm nx benchmark kernels
 *   pnpm nx benchmark kernels -- --iterations 10 --filter "primitives,booleans"
 *   pnpm nx benchmark kernels -- --compare reports/benchmark-before.json reports/benchmark-after.json
 *   pnpm nx benchmark kernels -- --output ./my-reports
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { filterBenchmarks, benchmarkCategories } from '#benchmarks/benchmark-suite.js';
import { runBenchmarks, type BenchmarkRunResult } from '#benchmarks/benchmark-runner.js';
import { generateHtmlReport, serializeRunResult } from '#benchmarks/benchmark-report.js';

const { values } = parseArgs({
  options: {
    iterations: { type: 'string', short: 'n', default: '5' },
    filter: { type: 'string', short: 'f' },
    compare: { type: 'string', short: 'c', multiple: true },
    output: { type: 'string', short: 'o', default: 'reports' },
    ocProfile: { type: 'boolean', default: false },
    noTracing: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  console.log(`
Kernel Benchmarking CLI

Usage:
  pnpm nx benchmark kernels [-- options]

Options:
  -n, --iterations <n>    Number of iterations per benchmark (default: 5)
  -f, --filter <cats>     Comma-separated categories: ${benchmarkCategories.join(', ')}
  -c, --compare <files>   Compare two JSON report files (provide two paths)
  -o, --output <dir>      Output directory (default: reports)
      --ocProfile         Use per-call OC tracing for deep profiling
      --noTracing         Disable OC tracing entirely for pure timing
  -h, --help              Show this help message
`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (values.compare?.length === 2) {
    runComparison(values.compare[0]!, values.compare[1]!);
    return;
  }

  await runSuite();
}

async function runSuite(): Promise<void> {
  const iterations = Number.parseInt(values.iterations ?? '5', 10);
  const filterCats = values.filter?.split(',').map((s) => s.trim());
  const cases = filterBenchmarks(filterCats);

  if (cases.length === 0) {
    console.error('No benchmark cases match the filter.');
    process.exit(1);
  }

  const ocTracing = values.noTracing
    ? ('off' as const)
    : values.ocProfile
      ? ('per-call' as const)
      : ('summary' as const);
  console.log(`\nRunning ${cases.length} benchmarks × ${iterations} iterations (tracing: ${ocTracing})\n`);

  const result = await runBenchmarks(cases, {
    iterations,
    ocTracing,
    onProgress(completed, total, caseName) {
      if (caseName === 'done') {
        console.log(`\n✓ All ${total} benchmarks complete`);
      } else {
        console.log(`  [${completed + 1}/${total}] ${caseName}...`);
      }
    },
  });

  const outputDir = resolve(values.output ?? 'reports');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = result.timestamp.replaceAll(/[:.]/g, '-');
  const htmlPath = join(outputDir, `benchmark-${timestamp}.html`);
  const jsonPath = join(outputDir, `benchmark-${timestamp}.json`);

  writeFileSync(htmlPath, generateHtmlReport(result));
  writeFileSync(jsonPath, serializeRunResult(result));

  console.log(`\nReports written to:`);
  console.log(`  HTML: ${htmlPath}`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`\nTotal duration: ${(result.totalDurationMs / 1000).toFixed(1)}s`);

  if (result.wasmSizes) {
    const formatMegabytes = (b: number): string => `${(b / (1024 * 1024)).toFixed(1)} MB`;
    const formatKilobytes = (b: number): string => `${(b / 1024).toFixed(0)} kB`;
    console.log(`\nWASM sizes:`);
    console.log(
      `  single.wasm:     ${formatMegabytes(result.wasmSizes.singleWasmBytes)} (JS: ${formatKilobytes(result.wasmSizes.singleJsBytes)})`,
    );
    if (result.wasmSizes.exceptionsWasmBytes) {
      console.log(
        `  exceptions.wasm: ${formatMegabytes(result.wasmSizes.exceptionsWasmBytes)} (JS: ${formatKilobytes(result.wasmSizes.exceptionsJsBytes ?? 0)})`,
      );
    }
  }

  printSummaryTable(result);
}

function runComparison(beforePath: string, afterPath: string): void {
  const before = JSON.parse(readFileSync(resolve(beforePath), 'utf8')) as BenchmarkRunResult;
  const after = JSON.parse(readFileSync(resolve(afterPath), 'utf8')) as BenchmarkRunResult;

  const outputDir = resolve(values.output ?? 'reports');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const htmlPath = join(outputDir, `benchmark-comparison-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.html`);
  writeFileSync(htmlPath, generateHtmlReport(after, before));

  printComparisonTable(before, after);

  console.log(`\nComparison report written to: ${htmlPath}`);
}

function printComparisonTable(before: BenchmarkRunResult, after: BenchmarkRunResult): void {
  const w = 12;
  console.log(`\n${'═'.repeat(90)}`);
  console.log(
    `  ${'Operation'.padEnd(26)} ${'Before'.padStart(w)} ${'After'.padStart(w)} ${'Delta'.padStart(w)} ${'Change'.padStart(w)}`,
  );
  console.log(`${'─'.repeat(90)}`);

  for (const afterResult of after.results) {
    const beforeResult = before.results.find((r) => r.name === afterResult.name);
    const bMedian = beforeResult?.median ?? 0;
    const aMedian = afterResult.median;
    const delta = bMedian > 0 ? ((aMedian - bMedian) / bMedian) * 100 : 0;
    const sign = delta > 0 ? '+' : '';
    const indicator = delta < -2 ? ' FASTER' : delta > 2 ? ' SLOWER' : '';

    console.log(
      `  ${afterResult.name.padEnd(26)} ${formatMs(bMedian).padStart(w)} ${formatMs(aMedian).padStart(w)} ${(sign + delta.toFixed(1) + '%').padStart(w)} ${indicator}`,
    );
  }

  console.log(`${'─'.repeat(90)}`);

  if (before.wasmSizes && after.wasmSizes) {
    const bSize = before.wasmSizes.singleWasmBytes;
    const aSize = after.wasmSizes.singleWasmBytes;
    const sizeDelta = bSize > 0 ? ((aSize - bSize) / bSize) * 100 : 0;
    const formatSize = (b: number): string =>
      b > 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} kB`;

    console.log(
      `\n  WASM Size: ${formatSize(bSize)} -> ${formatSize(aSize)} (${sizeDelta > 0 ? '+' : ''}${sizeDelta.toFixed(1)}%)`,
    );
  }

  console.log(`${'═'.repeat(90)}\n`);
}

function printSummaryTable(result: BenchmarkRunResult): void {
  console.log(`\n${'─'.repeat(80)}`);
  console.log(
    `  ${'Operation'.padEnd(30)} ${'Mean'.padStart(10)} ${'Median'.padStart(10)} ${'P95'.padStart(10)} ${'Stddev'.padStart(10)}`,
  );
  console.log(`${'─'.repeat(80)}`);

  for (const r of result.results) {
    const name = r.name.padEnd(30);
    const mean = formatMs(r.mean).padStart(10);
    const median = formatMs(r.median).padStart(10);
    const p95 = formatMs(r.p95).padStart(10);
    const stddev = formatMs(r.stddev).padStart(10);
    console.log(`  ${name} ${mean} ${median} ${p95} ${stddev}`);
  }

  console.log(`${'─'.repeat(80)}\n`);
}

function formatMs(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

await main();
