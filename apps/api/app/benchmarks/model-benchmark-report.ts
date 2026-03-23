/**
 * Model Benchmark Report Generator
 *
 * Generates self-contained HTML reports from model benchmark results.
 * Includes summary cards, results table, bar charts, score heatmap,
 * transcript viewer, comparison mode, and failure diagnostics.
 * No external dependencies -- everything is inlined.
 */

import type { ModelBenchmarkResult, ModelBenchmarkRunResult } from '#benchmarks/model-benchmark-runner.js';

// =============================================================================
// Utilities
// =============================================================================

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
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

function getProviderColor(provider: string): string {
  const colors: Record<string, string> = {
    anthropic: '#7C3AED',
    openai: '#10B981',
    vertexai: '#3B82F6',
    together: '#F59E0B',
    cerebras: '#EC4899',
    ollama: '#6366F1',
  };
  return colors[provider] ?? '#6B7280';
}

function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    passed: '#10B981',
    failed: '#EF4444',
    skipped: '#6B7280',
    error: '#F59E0B',
  };
  return colors[status] ?? '#6B7280';
}

function getScoreColor(score: number): string {
  if (score >= 0.8) {
    return '#10B981';
  }
  if (score >= 0.5) {
    return '#F59E0B';
  }
  return '#EF4444';
}

function truncateLabel(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) + '…' : text;
}

// =============================================================================
// Summary Cards
// =============================================================================

function generateSummaryCards(run: ModelBenchmarkRunResult): string {
  const { summary, totalDurationMs, totalCost, geometrySummary } = run;
  const geometryCards = geometrySummary
    ? `<div class="card"><div class="card-label">Geometry Rendered</div><div class="card-value" style="color:#10B981">${geometrySummary.rendered}</div></div>
       <div class="card"><div class="card-label">Geometry Passed</div><div class="card-value" style="color:${geometrySummary.geometryFailed > 0 ? '#F59E0B' : '#10B981'}">${geometrySummary.geometryPassed}/${geometrySummary.attempted}</div></div>`
    : '';
  return `
    <div class="card-grid">
      <div class="card"><div class="card-label">Total</div><div class="card-value">${summary.total}</div></div>
      <div class="card"><div class="card-label">Passed</div><div class="card-value" style="color:#10B981">${summary.passed}</div></div>
      <div class="card"><div class="card-label">Failed</div><div class="card-value" style="color:#EF4444">${summary.failed}</div></div>
      <div class="card"><div class="card-label">Skipped</div><div class="card-value" style="color:#6B7280">${summary.skipped}</div></div>
      <div class="card"><div class="card-label">Errors</div><div class="card-value" style="color:#F59E0B">${summary.errored}</div></div>
      <div class="card"><div class="card-label">Mean Score</div><div class="card-value" style="color:${getScoreColor(summary.meanScore)}">${(summary.meanScore * 100).toFixed(0)}%</div></div>
      <div class="card"><div class="card-label">Duration</div><div class="card-value">${formatMs(totalDurationMs)}</div></div>
      <div class="card"><div class="card-label">Total Cost</div><div class="card-value">${formatCost(totalCost)}</div></div>
      ${geometryCards}
    </div>`;
}

// =============================================================================
// Results Table
// =============================================================================

function generateResultsTable(results: ModelBenchmarkResult[], comparison?: ModelBenchmarkRunResult): string {
  const activeResults = results.filter((r) => r.status !== 'skipped');
  if (activeResults.length === 0) {
    return '<p>No active results to display.</p>';
  }

  const allCheckNames = [...new Set(activeResults.flatMap((r) => r.checks.map((c) => c.name)))];

  const headerChecks = allCheckNames
    .map((n) => `<th title="${escapeHtml(n)}">${escapeHtml(truncateLabel(n, 15))}</th>`)
    .join('');
  const deltaHeader = comparison ? '<th>Δ Duration</th><th>Δ Cost</th>' : '';

  let rows = '';
  for (const r of activeResults) {
    const statusBadge = `<span class="status-badge" style="background:${getStatusColor(r.status)}">${r.status}</span>`;
    const providerBadge = `<span class="provider-badge" style="background:${getProviderColor(r.provider)}">${escapeHtml(r.provider)}</span>`;
    const scoreBar = `<div class="score-bar"><div class="score-fill" style="width:${r.score * 100}%;background:${getScoreColor(r.score)}"></div><span class="score-text">${(r.score * 100).toFixed(0)}%</span></div>`;

    let checkCells = '';
    for (const checkName of allCheckNames) {
      const check = r.checks.find((c) => c.name === checkName);
      checkCells += check
        ? `<td class="check-cell ${check.passed ? 'check-pass' : 'check-fail'}">${check.passed ? '✓' : '✗'}</td>`
        : '<td class="check-cell">—</td>';
    }

    let deltaCells = '';
    if (comparison) {
      const comp = comparison.results.find((cr) => cr.modelId === r.modelId && cr.caseName === r.caseName);
      if (comp && comp.status !== 'skipped') {
        const durationDelta = r.durationMs - comp.durationMs;
        const durationPct = comp.durationMs > 0 ? (durationDelta / comp.durationMs) * 100 : 0;
        const dColor = durationDelta > 0 ? '#EF4444' : '#10B981';
        const dLabel = durationDelta > 0 ? 'SLOWER' : 'FASTER';
        deltaCells += `<td style="color:${dColor}">${durationDelta > 0 ? '+' : ''}${durationPct.toFixed(0)}% ${dLabel}</td>`;

        const costA = r.cost?.totalCost ?? 0;
        const costB = comp.cost?.totalCost ?? 0;
        const costDelta = costA - costB;
        const cColor = costDelta > 0 ? '#EF4444' : '#10B981';
        deltaCells += `<td style="color:${cColor}">${costDelta > 0 ? '+' : ''}${formatCost(costDelta)}</td>`;
      } else {
        deltaCells += '<td>—</td><td>—</td>';
      }
    }

    const inputTokens = r.usage?.inputTokens ?? 0;
    const outputTokens = r.usage?.outputTokens ?? 0;

    rows += `<tr>
      <td>${providerBadge} ${escapeHtml(r.modelName)}</td>
      <td>${escapeHtml(r.caseName)}</td>
      <td>${statusBadge}</td>
      <td>${scoreBar}</td>
      <td>${formatMs(r.durationMs)}</td>
      <td>${r.timeToFirstToken ? formatMs(r.timeToFirstToken) : '—'}</td>
      <td>${inputTokens.toLocaleString()}</td>
      <td>${outputTokens.toLocaleString()}</td>
      <td>${r.cost ? formatCost(r.cost.totalCost) : '—'}</td>
      ${checkCells}
      ${deltaCells}
    </tr>`;
  }

  return `<div class="table-scroll"><table>
    <thead><tr>
      <th>Model</th><th>Case</th><th>Status</th><th>Score</th>
      <th>Duration</th><th>TTFT</th><th>In Tokens</th><th>Out Tokens</th><th>Cost</th>
      ${headerChecks}
      ${deltaHeader}
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

// =============================================================================
// Duration Chart
// =============================================================================

function generateDurationChart(results: ModelBenchmarkResult[]): string {
  const active = results.filter((r) => r.status !== 'skipped' && r.durationMs > 0);
  if (active.length === 0) {
    return '';
  }

  const maxDuration = Math.max(...active.map((r) => r.durationMs));
  const barHeight = 24;
  const labelWidth = 260;
  const chartWidth = 400;
  const totalWidth = labelWidth + chartWidth + 100;
  const totalHeight = active.length * (barHeight + 6) + 20;

  let bars = '';
  for (const [index, r] of active.entries()) {
    const y = index * (barHeight + 6) + 10;
    const width = maxDuration > 0 ? (r.durationMs / maxDuration) * chartWidth : 0;
    const color = getProviderColor(r.provider);
    const barLabel = truncateLabel(`${r.modelName} / ${r.caseName}`, 35);

    bars += `<text x="${labelWidth - 8}" y="${y + barHeight / 2 + 4}" text-anchor="end" font-size="11" fill="#374151">${escapeHtml(barLabel)}</text>`;
    bars += `<rect x="${labelWidth}" y="${y}" width="${width}" height="${barHeight}" fill="${color}" rx="3"/>`;
    bars += `<text x="${labelWidth + width + 6}" y="${y + barHeight / 2 + 4}" font-size="10" fill="#6B7280">${formatMs(r.durationMs)}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}">${bars}</svg>`;
}

// =============================================================================
// Cost Chart
// =============================================================================

function generateCostChart(results: ModelBenchmarkResult[]): string {
  const withCost = results.filter((r) => r.cost && r.cost.totalCost > 0);
  if (withCost.length === 0) {
    return '';
  }

  const sorted = [...withCost].sort((a, b) => (b.cost?.totalCost ?? 0) - (a.cost?.totalCost ?? 0));
  const maxCost = sorted[0]?.cost?.totalCost ?? 0;
  const barHeight = 24;
  const labelWidth = 260;
  const chartWidth = 400;
  const totalWidth = labelWidth + chartWidth + 100;
  const totalHeight = sorted.length * (barHeight + 6) + 20;

  let bars = '';
  for (const [index, r] of sorted.entries()) {
    const y = index * (barHeight + 6) + 10;
    const cost = r.cost?.totalCost ?? 0;
    const width = maxCost > 0 ? (cost / maxCost) * chartWidth : 0;
    const color = getProviderColor(r.provider);
    const barLabel = truncateLabel(`${r.modelName} / ${r.caseName}`, 35);

    bars += `<text x="${labelWidth - 8}" y="${y + barHeight / 2 + 4}" text-anchor="end" font-size="11" fill="#374151">${escapeHtml(barLabel)}</text>`;
    bars += `<rect x="${labelWidth}" y="${y}" width="${width}" height="${barHeight}" fill="${color}" rx="3"/>`;
    bars += `<text x="${labelWidth + width + 6}" y="${y + barHeight / 2 + 4}" font-size="10" fill="#6B7280">${formatCost(cost)}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}">${bars}</svg>`;
}

// =============================================================================
// Score Heatmap
// =============================================================================

function generateScoreHeatmap(results: ModelBenchmarkResult[]): string {
  const active = results.filter((r) => r.status !== 'skipped');
  if (active.length === 0) {
    return '';
  }

  const allCheckNames = [...new Set(active.flatMap((r) => r.checks.map((c) => c.name)))];
  const modelKeys = [...new Set(active.map((r) => `${r.modelId}|${r.caseName}`))];

  const headerCells = allCheckNames
    .map((n) => `<th class="heatmap-header">${escapeHtml(truncateLabel(n, 12))}</th>`)
    .join('');

  let rows = '';
  for (const key of modelKeys) {
    const [modelId, caseName] = key.split('|');
    const result = active.find((r) => r.modelId === modelId && r.caseName === caseName);
    if (!result) {
      continue;
    }

    let cells = '';
    for (const checkName of allCheckNames) {
      const check = result.checks.find((c) => c.name === checkName);
      if (check) {
        const bg = check.passed ? '#D1FAE5' : '#FEE2E2';
        const fg = check.passed ? '#065F46' : '#991B1B';
        cells += `<td class="heatmap-cell" style="background:${bg};color:${fg}" title="${escapeHtml(check.detail ?? '')}">${check.passed ? '✓' : '✗'}</td>`;
      } else {
        cells += '<td class="heatmap-cell" style="background:#F3F4F6">—</td>';
      }
    }

    rows += `<tr><td class="heatmap-label">${escapeHtml(result.modelName)} / ${escapeHtml(result.caseName)}</td>${cells}</tr>`;
  }

  return `<div class="table-scroll"><table class="heatmap-table">
    <thead><tr><th>Model / Case</th>${headerCells}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

// =============================================================================
// Transcript Viewer
// =============================================================================

function generateTranscriptSection(results: ModelBenchmarkResult[]): string {
  const withTranscripts = results.filter((r) => r.status !== 'skipped' && r.transcript.summary.stepCount > 0);
  if (withTranscripts.length === 0) {
    return '';
  }

  let sections = '';
  for (const r of withTranscripts) {
    const s = r.transcript.summary;
    let steps = '';

    if (s.reasoningContent) {
      steps += `<div class="step step-thinking"><span class="step-badge badge-thinking">thinking</span><pre>${escapeHtml(truncateLabel(s.reasoningContent, 1000))}</pre></div>`;
    }

    for (const tc of s.toolCalls) {
      const stateClass = tc.state === 'output-available' ? 'badge-success' : 'badge-error';
      steps += `<div class="step step-tool">
        <span class="step-badge badge-tool">tool</span>
        <code>${escapeHtml(tc.name)}</code>
        <span class="step-badge ${stateClass}">${escapeHtml(tc.state)}</span>
        <details><summary>args</summary><pre>${escapeHtml(JSON.stringify(tc.args, undefined, 2).slice(0, 2000))}</pre></details>
        ${tc.output ? `<details><summary>output</summary><pre>${escapeHtml(tc.output)}</pre></details>` : ''}
      </div>`;
    }

    if (s.textContent) {
      steps += `<div class="step step-text"><span class="step-badge badge-text">text</span><pre>${escapeHtml(truncateLabel(s.textContent, 1000))}</pre></div>`;
    }

    for (const errorMessage of s.errors) {
      steps += `<div class="step step-error"><span class="step-badge badge-error">error</span><pre>${escapeHtml(errorMessage)}</pre></div>`;
    }

    const chunkSeq =
      s.chunkTypeSequence.length > 0
        ? `<div class="chunk-seq">${s.chunkTypeSequence.map((t) => `<span class="chunk-type">${escapeHtml(t)}</span>`).join(' → ')}</div>`
        : '';

    const statusIcon = r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '⚠';

    sections += `<details>
      <summary>${statusIcon} <strong>${escapeHtml(r.provider)}/${escapeHtml(r.modelName)}</strong> / ${escapeHtml(r.caseName)} (${s.stepCount} steps)</summary>
      <div class="transcript">${steps}${chunkSeq}</div>
    </details>`;
  }

  return sections;
}

// =============================================================================
// Geometry Validation Section
// =============================================================================

function generateGeometrySection(results: ModelBenchmarkResult[]): string {
  const withGeometry = results.filter((r) => r.geometryValidation);
  if (withGeometry.length === 0) {
    return '';
  }

  let rows = '';
  for (const r of withGeometry) {
    const gv = r.geometryValidation!;
    const providerBadge = `<span class="provider-badge" style="background:${getProviderColor(r.provider)}">${escapeHtml(r.provider)}</span>`;
    const renderBadge = gv.renderSuccess
      ? '<span class="status-badge" style="background:#10B981">rendered</span>'
      : '<span class="status-badge" style="background:#EF4444">render failed</span>';

    const geometryChecks = gv.checks.filter((c) => c.name !== 'geometry_render');
    let checkCells = '';
    for (const check of geometryChecks) {
      const icon = check.passed ? '✓' : '✗';
      const cellClass = check.passed ? 'check-pass' : 'check-fail';
      const detail = check.detail ? ` title="${escapeHtml(check.detail)}"` : '';
      checkCells += `<td class="check-cell ${cellClass}"${detail}>${icon} ${escapeHtml(check.name.replace('geometry_', ''))}</td>`;
    }

    if (geometryChecks.length === 0 && !gv.renderSuccess) {
      checkCells = `<td class="check-cell check-fail" colspan="1">${escapeHtml(gv.renderError ?? 'Unknown error')}</td>`;
    }

    let viewerCell = '<td>—</td>';
    if (r.glbData) {
      const base64Glb = Buffer.from(r.glbData).toString('base64');
      viewerCell = `<td><model-viewer src="data:model/gltf-binary;base64,${base64Glb}" auto-rotate camera-controls style="width:300px;height:200px;background:#1a1a2e;border-radius:6px"></model-viewer></td>`;
    }

    rows += `<tr>
      <td>${providerBadge} ${escapeHtml(r.modelName)}</td>
      <td>${escapeHtml(r.caseName)}</td>
      <td>${renderBadge}</td>
      <td>${checkCells}</td>
      ${viewerCell}
    </tr>`;
  }

  return `<div class="table-scroll"><table>
    <thead><tr><th>Model</th><th>Case</th><th>Render</th><th>Geometry Checks</th><th>Preview</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

// =============================================================================
// Failed Models Section
// =============================================================================

function generateFailedSection(results: ModelBenchmarkResult[]): string {
  const failures = results.filter((r) => r.status === 'failed' || r.status === 'error');
  if (failures.length === 0) {
    return '';
  }

  let sections = '';
  for (const r of failures) {
    const statusBadge = `<span class="status-badge" style="background:${getStatusColor(r.status)}">${r.status}</span>`;

    let checkDetails = '';
    const failedChecks = r.checks.filter((c) => !c.passed);
    if (failedChecks.length > 0) {
      checkDetails =
        '<ul>' +
        failedChecks
          .map((c) => `<li><strong>${escapeHtml(c.name)}</strong>: ${escapeHtml(c.detail ?? 'Failed')}</li>`)
          .join('') +
        '</ul>';
    }

    sections += `<details>
      <summary>${statusBadge} <strong>${escapeHtml(r.modelName)}</strong> (${escapeHtml(r.provider)}) / ${escapeHtml(r.caseName)} — score ${(r.score * 100).toFixed(0)}%</summary>
      <div class="failure-detail">
        ${r.error ? `<p class="error-msg">${escapeHtml(r.error)}</p>` : ''}
        ${checkDetails}
      </div>
    </details>`;
  }

  return sections;
}

// =============================================================================
// HTML Report
// =============================================================================

export function generateHtmlReport(run: ModelBenchmarkRunResult, comparison?: ModelBenchmarkRunResult): string {
  const title = comparison ? 'Model Benchmark Comparison' : 'Model Benchmark Report';
  const comparisonNote = comparison
    ? `<p class="meta">Comparing against baseline from <strong>${escapeHtml(comparison.timestamp)}</strong></p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/4.0/model-viewer.min.js">${'<'}/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1F2937; background: #F9FAFB; padding: 2rem; max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.25rem; margin: 2rem 0 1rem; border-bottom: 1px solid #E5E7EB; padding-bottom: 0.5rem; }
  .meta { color: #6B7280; font-size: 0.875rem; margin-bottom: 1.5rem; }

  .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
  .card { background: white; border: 1px solid #E5E7EB; border-radius: 8px; padding: 0.75rem 1rem; }
  .card-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: #6B7280; margin-bottom: 0.25rem; font-weight: 600; }
  .card-value { font-size: 1.25rem; font-weight: 700; }

  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; font-size: 0.8rem; }
  th, td { padding: 0.4rem 0.6rem; text-align: left; border-bottom: 1px solid #E5E7EB; white-space: nowrap; }
  th { background: #F3F4F6; font-weight: 600; color: #374151; position: sticky; top: 0; }
  tr:hover { background: #F9FAFB; }

  .status-badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; color: white; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; }
  .provider-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; color: white; font-size: 0.65rem; font-weight: 600; margin-right: 4px; }

  .score-bar { display: inline-flex; align-items: center; gap: 4px; }
  .score-fill { height: 14px; border-radius: 3px; min-width: 2px; }
  .score-text { font-size: 0.75rem; font-weight: 600; }

  .check-cell { text-align: center; font-size: 0.85rem; }
  .check-pass { color: #10B981; }
  .check-fail { color: #EF4444; }

  .chart-container { margin: 1.5rem 0; overflow-x: auto; }

  .heatmap-table th, .heatmap-table td { text-align: center; padding: 0.3rem 0.5rem; }
  .heatmap-header { font-size: 0.7rem; writing-mode: vertical-lr; transform: rotate(180deg); height: 80px; }
  .heatmap-label { text-align: left !important; font-size: 0.75rem; }
  .heatmap-cell { font-size: 0.8rem; min-width: 28px; }

  details { margin: 0.5rem 0; }
  summary { cursor: pointer; padding: 0.5rem; background: #F3F4F6; border-radius: 6px; font-size: 0.85rem; }
  summary:hover { background: #E5E7EB; }

  .transcript { padding: 0.75rem; }
  .step { margin: 0.4rem 0; padding: 0.4rem; border-left: 3px solid #E5E7EB; padding-left: 0.75rem; }
  .step-thinking { border-color: #8B5CF6; }
  .step-tool { border-color: #3B82F6; }
  .step-text { border-color: #6B7280; }
  .step-error { border-color: #EF4444; }
  .step pre { white-space: pre-wrap; word-break: break-word; font-size: 0.75rem; max-height: 200px; overflow-y: auto; margin-top: 0.25rem; }
  .step-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.65rem; font-weight: 600; text-transform: uppercase; margin-right: 4px; }
  .badge-thinking { background: #EDE9FE; color: #6D28D9; }
  .badge-tool { background: #DBEAFE; color: #1D4ED8; }
  .badge-text { background: #F3F4F6; color: #374151; }
  .badge-success { background: #D1FAE5; color: #065F46; }
  .badge-error { background: #FEE2E2; color: #991B1B; }

  .chunk-seq { margin-top: 0.5rem; padding: 0.5rem; background: #F9FAFB; border-radius: 4px; font-size: 0.65rem; color: #6B7280; overflow-x: auto; white-space: nowrap; }
  .chunk-type { display: inline-block; padding: 1px 4px; background: #E5E7EB; border-radius: 3px; margin: 1px; }

  .failure-detail { padding: 0.75rem; }
  .error-msg { color: #991B1B; background: #FEF2F2; padding: 0.5rem; border-radius: 4px; font-size: 0.8rem; margin-bottom: 0.5rem; word-break: break-word; }
  .failure-detail ul { padding-left: 1.5rem; font-size: 0.8rem; }

  code { background: #F3F4F6; padding: 1px 4px; border-radius: 3px; font-size: 0.75rem; }
  .footer { margin-top: 3rem; color: #9CA3AF; font-size: 0.75rem; border-top: 1px solid #E5E7EB; padding-top: 1rem; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">Generated ${escapeHtml(run.timestamp)} &bull; Total duration: ${formatMs(run.totalDurationMs)} &bull; Total cost: ${formatCost(run.totalCost)}</p>
  ${comparisonNote}

  <h2>Summary</h2>
  ${generateSummaryCards(run)}

  <h2>Results</h2>
  ${generateResultsTable(run.results, comparison)}

  <h2>Duration by Model</h2>
  <div class="chart-container">
    ${generateDurationChart(run.results)}
  </div>

  <h2>Cost by Model</h2>
  <div class="chart-container">
    ${generateCostChart(run.results)}
  </div>

  <h2>Score Heatmap</h2>
  ${generateScoreHeatmap(run.results)}

  ${run.results.some((r) => r.geometryValidation) ? `<h2>Geometry Validation</h2>${generateGeometrySection(run.results)}` : ''}

  <h2>Transcripts</h2>
  ${generateTranscriptSection(run.results)}

  ${run.results.some((r) => r.status === 'failed' || r.status === 'error') ? `<h2>Failures & Errors</h2>${generateFailedSection(run.results)}` : ''}

  <div class="footer">
    Generated by Tau Model Benchmarking CLI &bull; ${run.results.length} results &bull; ${escapeHtml(run.timestamp)}
  </div>
</body>
</html>`;
}

// =============================================================================
// JSON Serialization
// =============================================================================

export function serializeRunResult(run: ModelBenchmarkRunResult): string {
  const stripped = {
    timestamp: run.timestamp,
    totalDurationMs: run.totalDurationMs,
    totalCost: run.totalCost,
    summary: run.summary,
    geometrySummary: run.geometrySummary,
    results: run.results.map((r) => ({
      modelId: r.modelId,
      modelName: r.modelName,
      provider: r.provider,
      caseName: r.caseName,
      category: r.category,
      status: r.status,
      score: r.score,
      checks: r.checks,
      error: r.error,
      durationMs: r.durationMs,
      timeToFirstToken: r.timeToFirstToken,
      usage: r.usage,
      cost: r.cost,
      toolCalls: r.toolCalls,
      fileCreated: r.fileCreated,
      geometryValidation: r.geometryValidation,
      transcript: {
        summary: r.transcript.summary,
      },
    })),
  };
  return JSON.stringify(stripped, undefined, 2);
}
