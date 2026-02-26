/**
 * Benchmark Report Generator
 *
 * Generates self-contained HTML reports from benchmark results.
 * Includes summary tables, OC tracing data, comparison mode, and inline SVG charts.
 * No external dependencies -- everything is inlined.
 */

import type { BenchmarkResult, BenchmarkRunResult } from '#benchmarks/benchmark-runner.js';

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function formatMs(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

function generateBarChart(results: BenchmarkResult[], comparison?: BenchmarkRunResult): string {
  const maxMean = Math.max(...results.map((r) => r.mean));
  const barHeight = 28;
  const labelWidth = 180;
  const chartWidth = 500;
  const totalWidth = labelWidth + chartWidth + 80;
  const totalHeight = results.length * (barHeight + 8) + 20;

  let bars = '';
  let rowIndex = 0;
  for (const result of results) {
    const y = rowIndex * (barHeight + 8) + 10;
    const width = maxMean > 0 ? (result.mean / maxMean) * chartWidth : 0;
    const color = getCategoryColor(result.category);

    bars += `<text x="${labelWidth - 8}" y="${y + barHeight / 2 + 5}" text-anchor="end" font-size="12" fill="#374151">${escapeHtml(result.name)}</text>`;
    bars += `<rect x="${labelWidth}" y="${y}" width="${width}" height="${barHeight}" fill="${color}" rx="3"/>`;
    bars += `<text x="${labelWidth + width + 6}" y="${y + barHeight / 2 + 5}" font-size="11" fill="#6B7280">${formatMs(result.mean)}</text>`;

    if (comparison) {
      const compResult = comparison.results.find((cr) => cr.name === result.name);
      if (compResult) {
        const compWidth = maxMean > 0 ? (compResult.mean / maxMean) * chartWidth : 0;
        bars += `<rect x="${labelWidth}" y="${y + barHeight - 6}" width="${compWidth}" height="4" fill="${color}" opacity="0.35" rx="2"/>`;
      }
    }

    rowIndex++;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}">${bars}</svg>`;
}

function getCategoryColor(category: string): string {
  const colors: Record<string, string> = {
    primitives: '#3B82F6',
    booleans: '#10B981',
    fillets: '#8B5CF6',
    extrusions: '#F59E0B',
    complex: '#EF4444',
    stress: '#EC4899',
  };
  return colors[category] ?? '#6B7280';
}

function generateSummaryTable(results: BenchmarkResult[], comparison?: BenchmarkRunResult): string {
  let rows = '';
  for (const result of results) {
    const compResult = comparison?.results.find((cr) => cr.name === result.name);
    let deltaHtml = '';
    if (compResult) {
      const delta = ((result.mean - compResult.mean) / compResult.mean) * 100;
      const sign = delta > 0 ? '+' : '';
      const color = delta > 2 ? '#EF4444' : delta < -2 ? '#10B981' : '#6B7280';
      deltaHtml = `<td style="color:${color};font-weight:600">${sign}${delta.toFixed(1)}%</td>`;
    }

    rows += `<tr>
      <td><span class="cat-badge" style="background:${getCategoryColor(result.category)}">${escapeHtml(result.category)}</span> ${escapeHtml(result.name)}</td>
      <td>${formatMs(result.mean)}</td>
      <td>${formatMs(result.median)}</td>
      <td>${formatMs(result.p95)}</td>
      <td>${formatMs(result.p99)}</td>
      <td>${formatMs(result.stddev)}</td>
      <td>${result.iterations}</td>
      ${deltaHtml}
    </tr>`;
  }

  const deltaHeader = comparison ? '<th>Delta</th>' : '';

  return `<table>
    <thead>
      <tr>
        <th>Operation</th>
        <th>Mean</th>
        <th>Median</th>
        <th>P95</th>
        <th>P99</th>
        <th>Stddev</th>
        <th>Iterations</th>
        ${deltaHeader}
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function generateOcTracingSection(results: BenchmarkResult[]): string {
  const withOc = results.filter((r) => r.ocSummary);
  if (withOc.length === 0) {
    return '';
  }

  let sections = '';
  for (const result of withOc) {
    if (!result.ocSummary) {
      continue;
    }

    const entries = Object.entries(result.ocSummary).sort((a, b) => b[1].totalMs - a[1].totalMs);
    let rows = '';
    for (const [className, stats] of entries) {
      rows += `<tr>
        <td><code>${escapeHtml(className)}</code></td>
        <td>${stats.calls}</td>
        <td>${formatMs(stats.totalMs)}</td>
        <td>${formatMs(stats.totalMs / stats.calls)}</td>
      </tr>`;
    }

    sections += `
      <details>
        <summary><strong>${escapeHtml(result.name)}</strong> (${entries.length} classes)</summary>
        <table class="oc-table">
          <thead><tr><th>OC Class</th><th>Calls</th><th>Total</th><th>Avg/Call</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>`;
  }

  return `<h2>OpenCASCADE API Tracing</h2>${sections}`;
}

/**
 * Generate a self-contained HTML benchmark report.
 */
export function generateHtmlReport(run: BenchmarkRunResult, comparison?: BenchmarkRunResult): string {
  const title = comparison ? 'Kernel Benchmark Comparison' : 'Kernel Benchmark Report';
  const comparisonNote = comparison
    ? `<p class="meta">Comparing against baseline from <strong>${escapeHtml(comparison.timestamp)}</strong></p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1F2937; background: #F9FAFB; padding: 2rem; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.25rem; margin: 2rem 0 1rem; border-bottom: 1px solid #E5E7EB; padding-bottom: 0.5rem; }
  .meta { color: #6B7280; font-size: 0.875rem; margin-bottom: 1.5rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; font-size: 0.875rem; }
  th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #E5E7EB; }
  th { background: #F3F4F6; font-weight: 600; color: #374151; }
  tr:hover { background: #F9FAFB; }
  .cat-badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; color: white; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; margin-right: 6px; }
  .chart-container { margin: 1.5rem 0; overflow-x: auto; }
  details { margin: 0.75rem 0; }
  summary { cursor: pointer; padding: 0.5rem; background: #F3F4F6; border-radius: 6px; font-size: 0.875rem; }
  summary:hover { background: #E5E7EB; }
  .oc-table { margin-top: 0.5rem; }
  .oc-table td, .oc-table th { padding: 0.35rem 0.5rem; }
  code { background: #F3F4F6; padding: 1px 4px; border-radius: 3px; font-size: 0.8rem; }
  .footer { margin-top: 3rem; color: #9CA3AF; font-size: 0.75rem; border-top: 1px solid #E5E7EB; padding-top: 1rem; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">Generated ${escapeHtml(run.timestamp)} &bull; Total duration: ${formatMs(run.totalDurationMs)}</p>
  ${comparisonNote}

  <h2>Summary</h2>
  ${generateSummaryTable(run.results, comparison)}

  <h2>Timing Distribution</h2>
  <div class="chart-container">
    ${generateBarChart(run.results, comparison)}
  </div>

  ${generateOcTracingSection(run.results)}

  <div class="footer">
    Generated by Tau Kernel Benchmarking CLI &bull; ${run.results.length} benchmarks &bull; ${escapeHtml(run.timestamp)}
  </div>
</body>
</html>`;
}

/**
 * Serialize a BenchmarkRunResult to JSON for later comparison.
 */
export function serializeRunResult(run: BenchmarkRunResult): string {
  const stripped = {
    ...run,
    results: run.results.map((r) => ({
      name: r.name,
      category: r.category,
      iterations: r.iterations,
      timings: r.timings,
      mean: r.mean,
      median: r.median,
      p95: r.p95,
      p99: r.p99,
      stddev: r.stddev,
      ocSummary: r.ocSummary,
    })),
    wasmSizes: run.wasmSizes,
  };
  return JSON.stringify(stripped, undefined, 2);
}
