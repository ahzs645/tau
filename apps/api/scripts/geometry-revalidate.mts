// oxlint-disable-next-line import/no-unassigned-import -- reflect-metadata has intentional side effects
import 'reflect-metadata';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createGeometryRenderer, validateGeometry } from '#benchmarks/model-benchmark-geometry.js';
import { benchmarkSuite } from '#benchmarks/model-benchmark-suite.js';
import type { ModelBenchmarkCase } from '#benchmarks/model-benchmark-suite.js';
import { generateHtmlReport, serializeRunResult } from '#benchmarks/model-benchmark-report.js';
import type { ModelBenchmarkRunResult, ModelBenchmarkResult } from '#benchmarks/model-benchmark-runner.js';
import process from 'node:process';

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('Usage: node geometry-revalidate.mts <path-to-benchmark.json>');
  process.exit(1);
}

const jsonPath = resolve(reportPath);
if (!existsSync(jsonPath)) {
  console.error(`File not found: ${jsonPath}`);
  process.exit(1);
}

const codeDirectory = jsonPath.replace('.json', '-code');
if (!existsSync(codeDirectory)) {
  console.error(`Code directory not found: ${codeDirectory}`);
  process.exit(1);
}

const run = JSON.parse(readFileSync(jsonPath, 'utf8')) as ModelBenchmarkRunResult;
const caseMap = new Map<string, ModelBenchmarkCase>(benchmarkSuite.map((c) => [c.name, c]));

const targets = run.results.filter((r) => {
  if (r.status === 'skipped' || r.status === 'error') {
    return false;
  }
  const benchmarkCase = caseMap.get(r.caseName);
  if (!benchmarkCase?.geometryExpectations) {
    return false;
  }
  const modelDirectory = join(codeDirectory, r.modelId, r.caseName);
  return existsSync(join(modelDirectory, 'main.scad')) || existsSync(join(modelDirectory, 'main.ts'));
});

console.log(`Found ${targets.length} results with code to validate geometry\n`);

const client = createGeometryRenderer();
let attempted = 0;
let rendered = 0;
let renderFailed = 0;
let geometryPassed = 0;
let geometryFailed = 0;

function detectMainFile(directory: string): string {
  if (existsSync(join(directory, 'main.scad'))) {
    return 'main.scad';
  }
  return 'main.ts';
}

try {
  for (const result of targets) {
    attempted++;
    const modelDirectory = join(codeDirectory, result.modelId, result.caseName);
    const detectedMain = detectMainFile(modelDirectory);
    const code = readFileSync(join(modelDirectory, detectedMain), 'utf8');
    const files: Record<string, string> = { [detectedMain]: code };

    const otherFiles = readdirSync(modelDirectory).filter((f) => f !== detectedMain && f !== 'geometry.glb');
    for (const f of otherFiles) {
      const fPath = join(modelDirectory, f);
      if (statSync(fPath).isFile()) {
        files[f] = readFileSync(fPath, 'utf8');
      }
    }

    const benchmarkCase = caseMap.get(result.caseName)!;
    console.log(`  [${attempted}/${targets.length}] ${result.modelId} / ${result.caseName}`);

    // oxlint-disable-next-line no-await-in-loop -- sequential by design: shared runtime client is not thread-safe
    const validation = await validateGeometry({
      client,
      files,
      mainFile: detectedMain,
      expectations: benchmarkCase.geometryExpectations!,
    });

    result.geometryValidation = validation;
    (result as ModelBenchmarkResult & { glbData?: Uint8Array<ArrayBuffer> }).glbData = validation.glb;

    if (validation.renderSuccess) {
      rendered++;
    } else {
      renderFailed++;
      console.log(`    ✗ Render failed: ${validation.renderError}`);
    }

    const allChecks = [...result.checks, ...validation.checks];
    const passedCount = allChecks.filter((c) => c.passed).length;
    const score = allChecks.length > 0 ? passedCount / allChecks.length : 0;

    result.checks = allChecks;
    result.score = score;
    result.status = score >= 0.8 ? 'passed' : 'failed';

    const allGeometryPassed = validation.checks.every((c) => c.passed);
    if (allGeometryPassed) {
      geometryPassed++;
      console.log(`    ✓ All geometry checks passed`);
    } else {
      geometryFailed++;
      const failedChecks = validation.checks.filter((c) => !c.passed);
      for (const c of failedChecks) {
        console.log(`    ✗ ${c.name}: ${c.detail ?? 'failed'}`);
      }
    }

    if (validation.glb) {
      writeFileSync(join(modelDirectory, 'geometry.glb'), validation.glb);
    }
  }
} finally {
  client.terminate();
}

run.geometrySummary = { attempted, rendered, renderFailed, geometryPassed, geometryFailed };

const passed = run.results.filter((r) => r.status === 'passed').length;
const failed = run.results.filter((r) => r.status === 'failed').length;
const skipped = run.results.filter((r) => r.status === 'skipped').length;
const errored = run.results.filter((r) => r.status === 'error').length;
const scoredResults = run.results.filter((r) => r.status === 'passed' || r.status === 'failed');
const meanScore =
  scoredResults.length > 0 ? scoredResults.reduce((sum, r) => sum + r.score, 0) / scoredResults.length : 0;

run.summary = { total: run.results.length, passed, failed, skipped, errored, meanScore };

const outputDirectory = resolve('reports');
if (!existsSync(outputDirectory)) {
  mkdirSync(outputDirectory, { recursive: true });
}

const timestamp = new Date().toISOString().replaceAll(/[.:]/g, '-');
const htmlPath = join(outputDirectory, `benchmark-geometry-${timestamp}.html`);
const jsonOutPath = join(outputDirectory, `benchmark-geometry-${timestamp}.json`);

writeFileSync(htmlPath, generateHtmlReport(run));
writeFileSync(jsonOutPath, serializeRunResult(run));

console.log(`\n=== Geometry Summary ===`);
console.log(`  Attempted:       ${attempted}`);
console.log(`  Rendered:        ${rendered}`);
console.log(`  Render Failed:   ${renderFailed}`);
console.log(`  Geometry Passed: ${geometryPassed}`);
console.log(`  Geometry Failed: ${geometryFailed}`);
console.log(`\n=== Output ===`);
console.log(`  HTML: ${htmlPath}`);
console.log(`  JSON: ${jsonOutPath}`);
