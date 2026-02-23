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
  -h, --help              Show this help message
`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (values.compare && values.compare.length === 2) {
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

  console.log(`\nRunning ${cases.length} benchmarks × ${iterations} iterations\n`);

  const result = await runBenchmarks(cases, {
    iterations,
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

  console.log(`\nComparison report written to: ${htmlPath}`);
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
