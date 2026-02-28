/* eslint-disable n/prefer-global/process -- CLI script requires direct process access */
/* eslint-disable unicorn/no-process-exit -- CLI script uses process.exit for error codes */
/**
 * Build Matrix Report Generator
 *
 * Generates a self-contained HTML dashboard comparing multiple WASM build
 * experiments. Shows size vs speed scatter plots, configuration matrices,
 * per-benchmark heatmaps, and size breakdown charts.
 *
 * Usage:
 *   pnpm nx build-matrix kernels -- --experiments ../../tarballs/experiments/
 *   pnpm nx build-matrix kernels -- --experiments ../../tarballs/experiments/ --baseline ../../tarballs/baselines/v8-rc4-O2-single
 *   pnpm nx build-matrix kernels -- --compare ../../tarballs/experiments/exp1 ../../tarballs/experiments/exp2
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { parseArgs } from 'node:util';
import type { BenchmarkRunResult, BuildProvenance } from '#benchmarks/benchmark-runner.js';

const { values } = parseArgs({
  options: {
    experiments: { type: 'string', short: 'e' },
    compare: { type: 'string', short: 'c', multiple: true },
    baseline: { type: 'string', short: 'b' },
    output: { type: 'string', short: 'o', default: '../../tarballs/comparisons' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  console.log(`
Build Matrix Report Generator

Usage:
  pnpm nx build-matrix kernels [-- options]

Options:
  -e, --experiments <dir>   Directory containing experiment subdirectories
  -c, --compare <dirs>      Compare specific experiment directories (multiple)
  -b, --baseline <dir>      Baseline experiment directory for delta calculation
  -o, --output <dir>        Output directory (default: ../../tarballs/comparisons)
  -h, --help                Show this help message
`);
  process.exit(0);
}

type ExperimentData = {
  name: string;
  dir: string;
  provenance?: BuildProvenance;
  benchmark?: BenchmarkRunResult;
  wasmSizeBytes: number;
};

function loadExperiment(dir: string): ExperimentData | undefined {
  if (!existsSync(dir)) {
    return undefined;
  }

  const name = basename(dir);
  const data: ExperimentData = { name, dir, wasmSizeBytes: 0 };

  const provPath = join(dir, 'provenance.json');
  if (existsSync(provPath)) {
    data.provenance = JSON.parse(readFileSync(provPath, 'utf8')) as BuildProvenance;
  }

  const benchFiles = readdirSync(dir).filter(
    (f) => f.startsWith('benchmark-') && f.endsWith('.json') && !f.includes('comparison'),
  );

  if (benchFiles.length > 0) {
    const latestBench = benchFiles.sort().at(-1)!;
    data.benchmark = JSON.parse(readFileSync(join(dir, latestBench), 'utf8')) as BenchmarkRunResult;
  }

  const unpackedDir = join(dir, 'unpacked');
  if (existsSync(unpackedDir)) {
    for (const f of readdirSync(unpackedDir)) {
      if (f.endsWith('.wasm')) {
        const { size } = statSync(join(unpackedDir, f));
        data.wasmSizeBytes += size;
      }
    }
  }

  if (data.wasmSizeBytes === 0 && data.provenance) {
    const { postOptSize } = data.provenance.postProcessing as { postOptSize?: number };
    if (typeof postOptSize === 'number' && postOptSize > 0) {
      data.wasmSizeBytes = postOptSize;
    }
  }

  return data;
}

function discoverExperiments(dir: string): ExperimentData[] {
  const experiments: ExperimentData[] = [];
  if (!existsSync(dir)) {
    return experiments;
  }

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      const experiment = loadExperiment(fullPath);
      if (experiment) {
        experiments.push(experiment);
      }
    }
  }

  return experiments.sort((a, b) => a.name.localeCompare(b.name));
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMs(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

function geometricMean(input: number[]): number {
  if (input.length === 0) {
    return 0;
  }

  const product = input.reduce((acc, v) => acc * v, 1);
  return product ** (1 / input.length);
}

function stripTimestampPrefix(name: string): string {
  return name.replace(/^\d+T\d+_/, '');
}

function generateSizeSpeedChart(experiments: ExperimentData[]): string {
  const dataPoints = experiments
    .filter((experiment) => experiment.benchmark && experiment.wasmSizeBytes > 0)
    .map((experiment) => ({
      name: experiment.name,
      sizeMb: experiment.wasmSizeBytes / (1024 * 1024),
      medianMs: geometricMean(experiment.benchmark!.results.map((r) => r.median)),
    }));

  if (dataPoints.length === 0) {
    return '<p>No experiments with both WASM size and benchmark data.</p>';
  }

  const minSize = Math.min(...dataPoints.map((d) => d.sizeMb)) * 0.95;
  const maxSize = Math.max(...dataPoints.map((d) => d.sizeMb)) * 1.05;
  const minTime = Math.min(...dataPoints.map((d) => d.medianMs)) * 0.9;
  const maxTime = Math.max(...dataPoints.map((d) => d.medianMs)) * 1.1;

  const chartW = 700;
  const chartH = 400;
  const padL = 70;
  const padR = 20;
  const padT = 20;
  const padB = 50;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;

  const scaleX = (v: number): number => padL + ((v - minSize) / (maxSize - minSize)) * plotW;
  const scaleY = (v: number): number => padT + plotH - ((v - minTime) / (maxTime - minTime)) * plotH;

  const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16'];

  let dots = '';
  let idx = 0;
  for (const dp of dataPoints) {
    const x = scaleX(dp.sizeMb);
    const y = scaleY(dp.medianMs);
    const color = colors[idx % colors.length]!;
    dots += `<circle cx="${x}" cy="${y}" r="6" fill="${color}" stroke="white" stroke-width="2"/>`;
    dots += `<text x="${x + 10}" y="${y + 4}" font-size="10" fill="#374151">${escapeHtml(stripTimestampPrefix(dp.name))}</text>`;
    idx++;
  }

  const axes = `
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#D1D5DB" stroke-width="1"/>
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#D1D5DB" stroke-width="1"/>
    <text x="${padL + plotW / 2}" y="${chartH - 5}" text-anchor="middle" font-size="12" fill="#6B7280">WASM Size (MB)</text>
    <text x="15" y="${padT + plotH / 2}" text-anchor="middle" font-size="12" fill="#6B7280" transform="rotate(-90, 15, ${padT + plotH / 2})">Geo-Mean Median (ms)</text>
  `;

  const gridLines: string[] = [];
  const xSteps = 5;
  const ySteps = 5;
  for (let i = 0; i <= xSteps; i++) {
    const xValue = minSize + ((maxSize - minSize) * i) / xSteps;
    const x = scaleX(xValue);
    gridLines.push(
      `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="#F3F4F6" stroke-width="1"/>`,
      `<text x="${x}" y="${padT + plotH + 18}" text-anchor="middle" font-size="10" fill="#9CA3AF">${xValue.toFixed(1)}</text>`,
    );
  }

  for (let i = 0; i <= ySteps; i++) {
    const yValue = minTime + ((maxTime - minTime) * i) / ySteps;
    const y = scaleY(yValue);
    gridLines.push(
      `<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="#F3F4F6" stroke-width="1"/>`,
      `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#9CA3AF">${yValue.toFixed(1)}</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${chartW}" height="${chartH}" viewBox="0 0 ${chartW} ${chartH}">
    <rect width="${chartW}" height="${chartH}" fill="white" rx="8"/>
    ${gridLines.join('\n')}
    ${axes}
    ${dots}
  </svg>`;
}

type CompilationInfo = {
  optimization?: string;
  lto?: boolean;
  exceptions?: string;
  threading?: string;
};

function computeDeltaHtml(experiment: ExperimentData, geoMean: number, baseline?: ExperimentData): string {
  if (!baseline?.benchmark || !experiment.benchmark) {
    return '<td>—</td><td>—</td>';
  }

  const baselineMedians = baseline.benchmark.results.map((r) => r.median);
  const baselineGeo = geometricMean(baselineMedians);
  const sizeDelta =
    baseline.wasmSizeBytes > 0
      ? ((experiment.wasmSizeBytes - baseline.wasmSizeBytes) / baseline.wasmSizeBytes) * 100
      : 0;
  const speedDelta = baselineGeo > 0 ? ((geoMean - baselineGeo) / baselineGeo) * 100 : 0;

  const sizeColor = sizeDelta > 2 ? '#EF4444' : sizeDelta < -2 ? '#10B981' : '#6B7280';
  const speedColor = speedDelta > 2 ? '#EF4444' : speedDelta < -2 ? '#10B981' : '#6B7280';
  return `<td style="color:${sizeColor}">${sizeDelta > 0 ? '+' : ''}${sizeDelta.toFixed(1)}% size</td>
    <td style="color:${speedColor}">${speedDelta > 0 ? '+' : ''}${speedDelta.toFixed(1)}% speed</td>`;
}

function generateConfigMatrix(experiments: ExperimentData[], baseline?: ExperimentData): string {
  let rows = '';

  for (const experiment of experiments) {
    const compilation = (experiment.provenance?.compilation ?? {}) as CompilationInfo;
    const sizeMb = experiment.wasmSizeBytes > 0 ? formatMb(experiment.wasmSizeBytes) : '—';

    const medians = experiment.benchmark?.results.map((r) => r.median) ?? [];
    const geoMean = medians.length > 0 ? geometricMean(medians) : 0;
    const deltaHtml = computeDeltaHtml(experiment, geoMean, baseline);

    const shortName = stripTimestampPrefix(experiment.name);
    rows += `<tr>
      <td><strong>${escapeHtml(shortName)}</strong></td>
      <td><code>${escapeHtml(compilation.optimization ?? '')}</code></td>
      <td>${compilation.lto ? 'Yes' : 'No'}</td>
      <td>${escapeHtml(compilation.exceptions ?? 'none')}</td>
      <td>${escapeHtml(compilation.threading ?? '')}</td>
      <td>${sizeMb}</td>
      <td>${geoMean > 0 ? formatMs(geoMean) : '—'}</td>
      ${deltaHtml}
    </tr>`;
  }

  return `<table>
    <thead>
      <tr>
        <th>Experiment</th>
        <th>Compile</th>
        <th>LTO</th>
        <th>Exceptions</th>
        <th>Threading</th>
        <th>WASM Size</th>
        <th>Geo-Mean</th>
        <th>vs Baseline (Size)</th>
        <th>vs Baseline (Speed)</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function deltaColor(delta: number): string {
  if (Math.abs(delta) < 2) {
    return '#F9FAFB';
  }

  if (delta < -10) {
    return '#D1FAE5';
  }

  if (delta < 0) {
    return '#ECFDF5';
  }

  return delta > 10 ? '#FEE2E2' : '#FEF2F2';
}

function generateHeatmapCell(experiment: ExperimentData, benchName: string, refMedian: number): string {
  const result = experiment.benchmark?.results.find((r) => r.name === benchName);
  if (!result || refMedian === 0) {
    return '<td style="text-align:center;color:#9CA3AF">—</td>';
  }

  const delta = ((result.median - refMedian) / refMedian) * 100;
  const bgColor = deltaColor(delta);
  const sign = delta > 0 ? '+' : '';
  return `<td style="text-align:center;background:${bgColor};font-size:0.8rem">${sign}${delta.toFixed(1)}%</td>`;
}

function generateHeatmap(experiments: ExperimentData[], baseline?: ExperimentData): string {
  const benchmarkNames = new Set<string>();
  for (const experiment of experiments) {
    if (experiment.benchmark) {
      for (const r of experiment.benchmark.results) {
        benchmarkNames.add(r.name);
      }
    }
  }

  const names = [...benchmarkNames].sort();
  if (names.length === 0) {
    return '<p>No benchmark data available for heatmap.</p>';
  }

  const ref = baseline ?? experiments[0];

  let header = '<th>Benchmark</th>';
  for (const experiment of experiments) {
    header += `<th>${escapeHtml(stripTimestampPrefix(experiment.name))}</th>`;
  }

  let rows = '';
  for (const benchName of names) {
    const refResult = ref?.benchmark?.results.find((r) => r.name === benchName);
    const refMedian = refResult?.median ?? 0;

    let cells = `<td><strong>${escapeHtml(benchName)}</strong></td>`;
    for (const experiment of experiments) {
      cells += generateHeatmapCell(experiment, benchName, refMedian);
    }

    rows += `<tr>${cells}</tr>`;
  }

  return `<div style="overflow-x:auto"><table>
    <thead><tr>${header}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function generateSizeBreakdown(experiments: ExperimentData[]): string {
  const barWidth = 60;
  const barGap = 20;
  const maxHeight = 300;
  const padL = 60;
  const padB = 80;
  const padT = 20;
  const padR = 20;

  const chartW = padL + (barWidth + barGap) * experiments.length + padR;
  const chartH = maxHeight + padT + padB;

  const maxSize = Math.max(...experiments.map((experiment) => experiment.wasmSizeBytes), 1);

  let bars = '';
  let idx = 0;
  for (const experiment of experiments) {
    const x = padL + idx * (barWidth + barGap);
    const sizePx = (experiment.wasmSizeBytes / maxSize) * maxHeight;
    const y = padT + maxHeight - sizePx;

    const postProcessing = experiment.provenance?.postProcessing ?? {};
    const preOpt = Number(postProcessing['preOptSize'] ?? 0);
    const postOpt = Number(postProcessing['postOptSize'] ?? experiment.wasmSizeBytes);

    if (preOpt > 0 && preOpt !== postOpt) {
      const preOptPx = (preOpt / maxSize) * maxHeight;
      const preY = padT + maxHeight - preOptPx;
      bars += `<rect x="${x}" y="${preY}" width="${barWidth}" height="${preOptPx}" fill="#E5E7EB" rx="4"/>`;
    }

    bars += `<rect x="${x}" y="${y}" width="${barWidth}" height="${sizePx}" fill="#3B82F6" rx="4"/>`;
    bars += `<text x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle" font-size="10" fill="#374151">${formatMb(experiment.wasmSizeBytes)}</text>`;

    const shortName = stripTimestampPrefix(experiment.name);
    bars += `<text x="${x + barWidth / 2}" y="${padT + maxHeight + 16}" text-anchor="middle" font-size="9" fill="#6B7280" transform="rotate(30, ${x + barWidth / 2}, ${padT + maxHeight + 16})">${escapeHtml(shortName)}</text>`;

    if (preOpt > 0 && preOpt > postOpt) {
      const reduction = ((1 - postOpt / preOpt) * 100).toFixed(1);
      bars += `<text x="${x + barWidth / 2}" y="${y - 18}" text-anchor="middle" font-size="8" fill="#10B981">-${reduction}%</text>`;
    }

    idx++;
  }

  const yAxis = `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + maxHeight}" stroke="#D1D5DB"/>`;
  const gridSteps = 5;
  let gridLines = '';
  for (let i = 0; i <= gridSteps; i++) {
    const gridValue = (maxSize * i) / gridSteps;
    const gridY = padT + maxHeight - (gridValue / maxSize) * maxHeight;
    gridLines += `<line x1="${padL}" y1="${gridY}" x2="${chartW - padR}" y2="${gridY}" stroke="#F3F4F6"/>`;
    gridLines += `<text x="${padL - 8}" y="${gridY + 4}" text-anchor="end" font-size="9" fill="#9CA3AF">${formatMb(gridValue)}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${chartW}" height="${chartH}" viewBox="0 0 ${chartW} ${chartH}">
    <rect width="${chartW}" height="${chartH}" fill="white" rx="8"/>
    ${gridLines}
    ${yAxis}
    ${bars}
  </svg>`;
}

function generateMatrixReport(experiments: ExperimentData[], baseline?: ExperimentData): string {
  const now = new Date().toISOString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WASM Build Matrix Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1F2937; background: #F9FAFB; padding: 2rem; max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.25rem; margin: 2rem 0 1rem; border-bottom: 1px solid #E5E7EB; padding-bottom: 0.5rem; }
  .meta { color: #6B7280; font-size: 0.875rem; margin-bottom: 1.5rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; font-size: 0.8rem; }
  th, td { padding: 0.4rem 0.6rem; text-align: left; border-bottom: 1px solid #E5E7EB; }
  th { background: #F3F4F6; font-weight: 600; color: #374151; position: sticky; top: 0; }
  tr:hover { background: #F9FAFB; }
  .chart-container { margin: 1.5rem 0; overflow-x: auto; }
  code { background: #F3F4F6; padding: 1px 4px; border-radius: 3px; font-size: 0.8rem; }
  .section { margin: 2rem 0; }
  .legend { display: flex; gap: 1rem; margin: 0.5rem 0; font-size: 0.75rem; color: #6B7280; }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-swatch { width: 12px; height: 12px; border-radius: 2px; }
  .footer { margin-top: 3rem; color: #9CA3AF; font-size: 0.75rem; border-top: 1px solid #E5E7EB; padding-top: 1rem; }
</style>
</head>
<body>
  <h1>WASM Build Matrix Report</h1>
  <p class="meta">Generated ${escapeHtml(now)} &bull; ${experiments.length} experiments${baseline ? ` &bull; Baseline: ${escapeHtml(baseline.name)}` : ''}</p>

  <div class="section">
    <h2>Size vs Speed</h2>
    <p class="meta">Each point represents an experiment. Lower-left is the Pareto-optimal zone (smaller AND faster).</p>
    <div class="chart-container">
      ${generateSizeSpeedChart(experiments)}
    </div>
  </div>

  <div class="section">
    <h2>Configuration Matrix</h2>
    ${generateConfigMatrix(experiments, baseline)}
  </div>

  <div class="section">
    <h2>Per-Benchmark Heatmap</h2>
    <p class="meta">Median time delta relative to ${baseline ? 'baseline' : 'first experiment'}. Green = faster, red = slower.</p>
    <div class="legend">
      <span class="legend-item"><span class="legend-swatch" style="background:#D1FAE5"></span> &gt;10% faster</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#ECFDF5"></span> 2-10% faster</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#F9FAFB"></span> Within 2%</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#FEF2F2"></span> 2-10% slower</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#FEE2E2"></span> &gt;10% slower</span>
    </div>
    ${generateHeatmap(experiments, baseline)}
  </div>

  <div class="section">
    <h2>Size Breakdown</h2>
    <div class="legend">
      <span class="legend-item"><span class="legend-swatch" style="background:#3B82F6"></span> Post wasm-opt</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#E5E7EB"></span> Pre wasm-opt</span>
    </div>
    <div class="chart-container">
      ${generateSizeBreakdown(experiments)}
    </div>
  </div>

  <div class="footer">
    Generated by Tau WASM Build Matrix Reporter &bull; ${experiments.length} experiments &bull; ${escapeHtml(now)}
  </div>
</body>
</html>`;
}

function main(): void {
  let experiments: ExperimentData[] = [];
  let baseline: ExperimentData | undefined;

  if (values.experiments) {
    const expDir = resolve(values.experiments);
    experiments = discoverExperiments(expDir);
    console.log(`Discovered ${experiments.length} experiments in ${expDir}`);
  }

  if (values.compare && values.compare.length > 0) {
    for (const dir of values.compare) {
      const experiment = loadExperiment(resolve(dir));
      if (experiment) {
        experiments.push(experiment);
      } else {
        console.warn(`Could not load experiment: ${dir}`);
      }
    }
  }

  if (values.baseline) {
    baseline = loadExperiment(resolve(values.baseline));
    if (baseline) {
      console.log(`Using baseline: ${baseline.name}`);
    } else {
      console.warn(`Baseline not found: ${values.baseline}`);
    }
  }

  if (experiments.length === 0) {
    console.error('No experiments found. Use --experiments <dir> or --compare <dir1> <dir2>.');
    process.exit(1);
  }

  const outputDir = resolve(values.output ?? '../../tarballs/comparisons');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const htmlPath = join(outputDir, `build-matrix-${timestamp}.html`);
  writeFileSync(htmlPath, generateMatrixReport(experiments, baseline));

  console.log(`\nBuild matrix report written to: ${htmlPath}`);
  console.log(`\nExperiments included:`);
  for (const experiment of experiments) {
    const sizeMb = experiment.wasmSizeBytes > 0 ? formatMb(experiment.wasmSizeBytes) : 'no WASM';
    const benchCount = experiment.benchmark?.results.length ?? 0;
    console.log(`  ${experiment.name}: ${sizeMb}, ${benchCount} benchmarks`);
  }
}

main();
