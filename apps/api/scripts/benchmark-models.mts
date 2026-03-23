// oxlint-disable-next-line import/no-unassigned-import -- reflect-metadata has intentional side effects
import 'reflect-metadata';

/**
 * Model Benchmarking CLI
 *
 * Run with: pnpm nx benchmark:models api
 *
 * Usage:
 *   pnpm nx benchmark:models api
 *   pnpm nx benchmark:models api -- --providers together,cerebras
 *   pnpm nx benchmark:models api -- --models together-deepseek-v3.1,cerebras-glm-4.7
 *   pnpm nx benchmark:models api -- --filter smoke,tool-use
 *   pnpm nx benchmark:models api -- --compare reports/before.json reports/after.json
 *   pnpm nx benchmark:models api -- --output ./my-reports
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import process from 'node:process';

// Timed-out model runs may leave lingering fetch/stream operations whose AbortError
// surfaces as an unhandled rejection after Phase 1 completes. Catch them here so
// the geometry phase can proceed.
process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error && (reason.name === 'AbortError' || reason.message.includes('aborted'))) {
    return;
  }
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});
import { filterModels, filterBenchmarks, benchmarkCategories } from '#benchmarks/model-benchmark-suite.js';
import { runModelBenchmarks } from '#benchmarks/model-benchmark-runner.js';
import type {
  ModelBenchmarkRunResult,
  ModelBenchmarkResult,
  ProgressInfo,
  GeometryProgressInfo,
} from '#benchmarks/model-benchmark-runner.js';
import { generateHtmlReport, serializeRunResult } from '#benchmarks/model-benchmark-report.js';

// ── ANSI color helpers ──────────────────────────────────────────────

const useColor = Boolean(process.stdout.isTTY);

const c = {
  reset: useColor ? '\u001B[0m' : '',
  bold: useColor ? '\u001B[1m' : '',
  dim: useColor ? '\u001B[2m' : '',
  cyan: useColor ? '\u001B[36m' : '',
  green: useColor ? '\u001B[32m' : '',
  yellow: useColor ? '\u001B[33m' : '',
  red: useColor ? '\u001B[31m' : '',
  magenta: useColor ? '\u001B[35m' : '',
  blue: useColor ? '\u001B[34m' : '',
  white: useColor ? '\u001B[37m' : '',
  bgBlue: useColor ? '\u001B[44m' : '',
};

function heading(text: string): void {
  console.log(`\n${c.bold}${c.cyan}═══ ${text} ═══${c.reset}`);
}

function label(key: string, value: string): void {
  console.log(`  ${c.dim}${key}:${c.reset} ${c.bold}${value}${c.reset}`);
}

function success(text: string): void {
  console.log(`${c.green}✓${c.reset} ${text}`);
}

// ── CLI parsing ─────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    providers: { type: 'string', short: 'p' },
    models: { type: 'string', short: 'm' },
    filter: { type: 'string', short: 'f' },
    compare: { type: 'string', short: 'c', multiple: true },
    output: { type: 'string', short: 'o', default: 'reports' },
    timeout: { type: 'string', short: 't', default: '180000' },
    concurrency: { type: 'string', default: '0' },
    'skip-geometry': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  console.log(`
${c.bold}Model Benchmarking CLI${c.reset}

${c.dim}Usage:${c.reset}
  pnpm nx benchmark:models api [-- options]

${c.dim}Options:${c.reset}
  ${c.cyan}-p${c.reset}, ${c.cyan}--providers${c.reset} <ids>    Comma-separated provider IDs (e.g. together,cerebras)
  ${c.cyan}-m${c.reset}, ${c.cyan}--models${c.reset} <ids>       Comma-separated model IDs
  ${c.cyan}-f${c.reset}, ${c.cyan}--filter${c.reset} <cats>      Comma-separated categories: ${benchmarkCategories.join(', ')}
  ${c.cyan}-c${c.reset}, ${c.cyan}--compare${c.reset} <files>    Compare two JSON report files (provide two paths)
  ${c.cyan}-o${c.reset}, ${c.cyan}--output${c.reset} <dir>       Output directory (default: reports)
  ${c.cyan}-t${c.reset}, ${c.cyan}--timeout${c.reset} <ms>       Timeout per model run in ms (default: 180000)
  ${c.cyan}--concurrency${c.reset} <n>        Max parallel runs (default: 0 = unlimited)
  ${c.cyan}--skip-geometry${c.reset}          Skip geometry validation (Phase 1 only)
  ${c.cyan}-h${c.reset}, ${c.cyan}--help${c.reset}               Show this help message
`);
  process.exit(0);
}

// ── Progress display ────────────────────────────────────────────────

function getStatusIcon(status: string): string {
  switch (status) {
    case 'passed': {
      return `${c.green}✓${c.reset}`;
    }
    case 'failed': {
      return `${c.red}✗${c.reset}`;
    }
    case 'error': {
      return `${c.yellow}⚠${c.reset}`;
    }
    case 'skipped': {
      return `${c.dim}○${c.reset}`;
    }
    default: {
      return ' ';
    }
  }
}

function getProviderColor(provider: string): string {
  const colors: Record<string, string> = {
    anthropic: c.magenta,
    openai: c.green,
    vertexai: c.blue,
    together: c.yellow,
    cerebras: c.magenta,
    ollama: c.blue,
  };
  return colors[provider] ?? c.dim;
}

function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(cost: number): string {
  if (cost === 0) {
    return '$0';
  }
  if (cost < 0.001) {
    return `$${cost.toFixed(6)}`;
  }
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(3)}`;
}

function printResultsTable(results: ModelBenchmarkResult[]): void {
  heading('Results');

  const activeResults = results.filter((r) => r.status !== 'skipped');
  if (activeResults.length === 0) {
    console.log(`  ${c.dim}No active results.${c.reset}`);
    return;
  }

  const w = 10;
  console.log(
    `  ${c.bold}${'Model'.padEnd(35)} ${'Case'.padEnd(18)} ${'Status'.padEnd(8)} ${'Score'.padStart(w)} ${'Duration'.padStart(w)} ${'Cost'.padStart(w)}${c.reset}`,
  );
  console.log(`  ${c.dim}${'─'.repeat(100)}${c.reset}`);

  for (const r of activeResults) {
    const provColor = getProviderColor(r.provider);
    const icon = getStatusIcon(r.status);
    const model = `${provColor}${r.provider}${c.reset}/${r.modelName}`;
    const displayModel = model.length > 50 ? model.slice(0, 47) + '…' : model;

    const scoreColor = r.score >= 0.8 ? c.green : r.score >= 0.5 ? c.yellow : c.red;
    const score = `${scoreColor}${(r.score * 100).toFixed(0)}%${c.reset}`;
    const duration = formatMs(r.durationMs);
    const cost = r.cost ? formatCost(r.cost.totalCost) : '—';

    console.log(
      `  ${icon} ${displayModel.padEnd(34)} ${r.caseName.padEnd(18)} ${r.status.padEnd(8)} ${score.padStart(w + 9)} ${duration.padStart(w)} ${cost.padStart(w)}`,
    );

    if (r.status === 'failed' || r.status === 'error') {
      const failedChecks = r.checks.filter((ch) => !ch.passed);
      if (failedChecks.length > 0) {
        const checkNames = failedChecks.map((ch) => ch.name).join(', ');
        console.log(`    ${c.dim}Failed checks: ${checkNames}${c.reset}`);
      }
      if (r.error) {
        const truncatedError = r.error.length > 120 ? r.error.slice(0, 120) + '…' : r.error;
        console.log(`    ${c.red}${truncatedError}${c.reset}`);
      }
    }
  }

  console.log(`  ${c.dim}${'─'.repeat(100)}${c.reset}`);

  const skippedCount = results.filter((r) => r.status === 'skipped').length;
  if (skippedCount > 0) {
    console.log(`  ${c.dim}${skippedCount} models skipped (missing API keys)${c.reset}`);
  }
}

function printSummary(run: ModelBenchmarkRunResult): void {
  heading('Summary');
  const { summary } = run;
  label('Total', `${summary.total}`);
  label('Passed', `${c.green}${summary.passed}${c.reset}`);
  label('Failed', `${c.red}${summary.failed}${c.reset}`);
  label('Errors', `${c.yellow}${summary.errored}${c.reset}`);
  label('Skipped', `${c.dim}${summary.skipped}${c.reset}`);
  label('Mean Score', `${(summary.meanScore * 100).toFixed(0)}%`);
  label('Duration', formatMs(run.totalDurationMs));
  label('Total Cost', formatCost(run.totalCost));

  if (run.geometrySummary) {
    const gs = run.geometrySummary;
    heading('Geometry Summary');
    label('Attempted', `${gs.attempted}`);
    label('Rendered', `${c.green}${gs.rendered}${c.reset}`);
    label('Render Failed', gs.renderFailed > 0 ? `${c.red}${gs.renderFailed}${c.reset}` : `${gs.renderFailed}`);
    label('Geometry Passed', `${c.green}${gs.geometryPassed}${c.reset}`);
    label('Geometry Failed', gs.geometryFailed > 0 ? `${c.red}${gs.geometryFailed}${c.reset}` : `${gs.geometryFailed}`);
  }
}

function printComparisonTable(before: ModelBenchmarkRunResult, after: ModelBenchmarkRunResult): void {
  heading('Comparison');
  const w = 12;
  console.log(
    `  ${c.bold}${'Model / Case'.padEnd(40)} ${'Before'.padStart(w)} ${'After'.padStart(w)} ${'Delta'.padStart(w)} ${'Change'.padStart(w)}${c.reset}`,
  );
  console.log(`  ${c.dim}${'─'.repeat(90)}${c.reset}`);

  const afterActive = after.results.filter((r) => r.status !== 'skipped');
  for (const afterResult of afterActive) {
    const beforeResult = before.results.find(
      (r) => r.modelId === afterResult.modelId && r.caseName === afterResult.caseName,
    );
    const bDur = beforeResult?.durationMs ?? 0;
    const aDur = afterResult.durationMs;
    const delta = bDur > 0 ? ((aDur - bDur) / bDur) * 100 : 0;
    const sign = delta > 0 ? '+' : '';
    const deltaColor = delta < -5 ? c.green : delta > 5 ? c.red : c.dim;
    const indicator = delta < -5 ? ` ${c.green}FASTER${c.reset}` : delta > 5 ? ` ${c.red}SLOWER${c.reset}` : '';
    const name = `${afterResult.provider}/${afterResult.modelName} / ${afterResult.caseName}`;
    const displayName = name.length > 40 ? name.slice(0, 37) + '…' : name;

    console.log(
      `  ${displayName.padEnd(40)} ${formatMs(bDur).padStart(w)} ${formatMs(aDur).padStart(w)} ${deltaColor}${(sign + delta.toFixed(1) + '%').padStart(w)}${c.reset}${indicator}`,
    );
  }

  console.log(`  ${c.dim}${'─'.repeat(90)}${c.reset}`);

  const bScore = before.summary.meanScore;
  const aScore = after.summary.meanScore;
  const scoreDelta = aScore - bScore;
  const scoreColor = scoreDelta > 0 ? c.green : scoreDelta < 0 ? c.red : c.dim;
  console.log(
    `\n  ${c.bold}Mean Score:${c.reset} ${(bScore * 100).toFixed(0)}% → ${(aScore * 100).toFixed(0)}% (${scoreColor}${scoreDelta > 0 ? '+' : ''}${(scoreDelta * 100).toFixed(0)}pp${c.reset})`,
  );

  const bCost = before.totalCost;
  const aCost = after.totalCost;
  const costDelta = aCost - bCost;
  const costColor = costDelta > 0 ? c.red : c.green;
  console.log(
    `  ${c.bold}Total Cost:${c.reset} ${formatCost(bCost)} → ${formatCost(aCost)} (${costColor}${costDelta > 0 ? '+' : ''}${formatCost(costDelta)}${c.reset})`,
  );
}

// ── File I/O ────────────────────────────────────────────────────────

function writeResults(run: ModelBenchmarkRunResult): void {
  const outputDirectory = resolve(values.output);
  if (!existsSync(outputDirectory)) {
    mkdirSync(outputDirectory, { recursive: true });
  }

  const timestamp = run.timestamp.replaceAll(/[.:]/g, '-');
  const htmlPath = join(outputDirectory, `benchmark-${timestamp}.html`);
  const jsonPath = join(outputDirectory, `benchmark-${timestamp}.json`);
  const codeDirectory = join(outputDirectory, `benchmark-${timestamp}-code`);

  writeFileSync(jsonPath, serializeRunResult(run));
  writeFileSync(htmlPath, generateHtmlReport(run));

  let filesWritten = 0;
  let glbFilesWritten = 0;
  for (const result of run.results) {
    const hasCode = Object.keys(result.filesCreated).length > 0;
    const hasGlb = result.glbData && result.glbData.length > 0;

    if (!hasCode && !hasGlb) {
      continue;
    }

    const modelDirectory = join(codeDirectory, result.modelId, result.caseName);
    mkdirSync(modelDirectory, { recursive: true });

    for (const [filePath, content] of Object.entries(result.filesCreated)) {
      const normalizedPath = filePath.replace(/^\//, '');
      writeFileSync(join(modelDirectory, normalizedPath), content);
      filesWritten++;
    }

    if (hasGlb) {
      writeFileSync(join(modelDirectory, 'geometry.glb'), result.glbData!);
      glbFilesWritten++;
    }
  }

  heading('Output');
  label('HTML', htmlPath);
  label('JSON', jsonPath);
  if (filesWritten > 0) {
    label('Code', `${codeDirectory} (${filesWritten} files)`);
  }
  if (glbFilesWritten > 0) {
    label('GLB', `${glbFilesWritten} geometry artifacts`);
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (values.compare?.length === 2) {
    const beforePath = values.compare[0];
    const afterPath = values.compare[1];
    if (beforePath && afterPath) {
      runComparison(beforePath, afterPath);
    }
    return;
  }

  if (values.compare) {
    console.error(`${c.red}--compare requires exactly 2 file paths.${c.reset}`);
    process.exit(1);
  }

  await runSuite();
}

async function runSuite(): Promise<void> {
  const providers = values.providers?.split(',').map((s) => s.trim());
  const models = values.models?.split(',').map((s) => s.trim());
  const filterCats = values.filter?.split(',').map((s) => s.trim());
  const timeoutMs = Number.parseInt(values.timeout, 10);
  const rawConcurrency = Number.parseInt(values.concurrency, 10);
  const concurrency = rawConcurrency > 0 ? rawConcurrency : Infinity;
  const skipGeometry = values['skip-geometry'];

  const cases = filterBenchmarks(filterCats);
  if (cases.length === 0) {
    console.error(`${c.red}No benchmark cases match the filter.${c.reset}`);
    process.exit(1);
  }

  const { active, skipped } = filterModels({ providers, models });
  if (active.length === 0) {
    console.error(`${c.red}No models available (check API keys and filters).${c.reset}`);
    if (skipped.length > 0) {
      console.error(`${c.yellow}${skipped.length} models skipped due to missing API keys.${c.reset}`);
    }
    process.exit(1);
  }

  const concurrencyLabel = concurrency === Infinity ? 'unlimited (parallel)' : `${concurrency}`;

  heading('Model Benchmark Run');
  label('Models', `${active.length} active, ${skipped.length} skipped`);
  label('Cases', `${cases.length}`);
  label(
    'Categories',
    cases
      .map((c) => c.category)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(', '),
  );
  label('Total runs', `${active.length * cases.length}`);
  label('Concurrency', concurrencyLabel);
  label('Timeout', `${timeoutMs}ms`);
  label('Geometry', skipGeometry ? 'skipped' : 'enabled');
  console.log('');

  const result = await runModelBenchmarks({
    models: active,
    cases,
    skippedModels: skipped,
    options: {
      timeoutMs,
      concurrency,
      skipGeometry,
      onProgress(info: ProgressInfo) {
        console.log(`  ${c.dim}[started]${c.reset} ${info.model} / ${info.caseName}`);
      },
      onGeometryProgress(info: GeometryProgressInfo) {
        console.log(`  ${c.dim}[geometry ${info.current}/${info.total}]${c.reset} ${info.modelId} / ${info.caseName}`);
      },
    },
  });

  printResultsTable(result.results);
  printSummary(result);
  writeResults(result);

  const failed = result.summary.failed + result.summary.errored;
  if (failed > 0) {
    console.log(`\n${c.yellow}${failed} model(s) had failures or errors. Check the HTML report for details.${c.reset}`);
  } else {
    success('All models passed!');
  }
}

function runComparison(beforePath: string, afterPath: string): void {
  const before = JSON.parse(readFileSync(resolve(beforePath), 'utf8')) as ModelBenchmarkRunResult;
  const after = JSON.parse(readFileSync(resolve(afterPath), 'utf8')) as ModelBenchmarkRunResult;

  const outputDirectory = resolve(values.output);
  if (!existsSync(outputDirectory)) {
    mkdirSync(outputDirectory, { recursive: true });
  }

  const timestamp = new Date().toISOString().replaceAll(/[.:]/g, '-');
  const htmlPath = join(outputDirectory, `benchmark-comparison-${timestamp}.html`);
  writeFileSync(htmlPath, generateHtmlReport(after, before));

  printComparisonTable(before, after);
  success(`Comparison report written to: ${htmlPath}`);
}

await main();
