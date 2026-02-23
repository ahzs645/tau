/* eslint-disable no-await-in-loop -- sequential benchmark iterations are intentional */
/**
 * Benchmark Runner
 *
 * Runs a set of benchmark cases against a kernel, capturing telemetry
 * and computing performance statistics (mean, median, p95, p99, stddev).
 *
 * Uses the public createKernelClient API with createInProcessTransport
 * to dogfood the same API path as production consumers.
 */

import type { PerformanceEntryData } from '#types/kernel-protocol.types.js';
import { createKernelClient, fromMemoryFS } from '#index.js';
import { createInProcessTransport } from '#transport/in-process-transport.js';
import { replicad } from '#plugins/kernel-factories.js';
import { esbuild } from '#plugins/bundler-factories.js';
import type { BenchmarkCase } from '#benchmarks/benchmark-suite.js';

// =============================================================================
// Types
// =============================================================================

/** Result of a single benchmark case. */
export type BenchmarkResult = {
  name: string;
  category: string;
  iterations: number;
  timings: number[];
  mean: number;
  median: number;
  p95: number;
  p99: number;
  stddev: number;
  telemetry: PerformanceEntryData[][];
  ocSummary?: Record<string, { calls: number; totalMs: number }>;
};

/** Result of a complete benchmark run across all cases. */
export type BenchmarkRunResult = {
  timestamp: string;
  results: BenchmarkResult[];
  totalDurationMs: number;
};

/** Options for configuring a benchmark run. */
export type BenchmarkRunnerOptions = {
  iterations: number;
  onProgress?: (completed: number, total: number, caseName: string) => void;
};

// =============================================================================
// Statistics
// =============================================================================

function computePercentile(sorted: number[], percentile: number): number {
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower]!;
  }

  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function computeStats(timings: number[]): { mean: number; median: number; p95: number; p99: number; stddev: number } {
  const sorted = [...timings].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const median = computePercentile(sorted, 50);
  const p95 = computePercentile(sorted, 95);
  const p99 = computePercentile(sorted, 99);
  const variance = sorted.reduce((acc, value) => acc + (value - mean) ** 2, 0) / sorted.length;
  const stddev = Math.sqrt(variance);

  return { mean, median, p95, p99, stddev };
}

// =============================================================================
// OC Summary Extraction
// =============================================================================

function extractOcSummary(
  telemetryBatches: PerformanceEntryData[][],
): Record<string, { calls: number; totalMs: number }> | undefined {
  const allEntries = telemetryBatches.flat();
  const summarySpan = allEntries.find((entry) => entry.name === 'oc.summary');
  if (!summarySpan?.detail) {
    return undefined;
  }

  const result: Record<string, { calls: number; totalMs: number }> = {};
  const { detail } = summarySpan;

  const classKeys = Object.keys(detail).filter((key) => key.endsWith('.calls'));
  for (const callsKey of classKeys) {
    const className = callsKey.replace('.calls', '');
    if (className === 'total') {
      continue;
    }

    const msValue = detail[`${className}.ms`];
    result[className] = {
      calls: detail[callsKey] as number,
      totalMs: typeof msValue === 'number' ? msValue : 0,
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

// =============================================================================
// Runner
// =============================================================================

const basePath = '/builds/test';
const benchFileName = 'bench.ts';
const absolutePath = `${basePath}/${benchFileName}`;

/**
 * Run a set of benchmark cases, capturing telemetry and computing statistics.
 * Creates a fresh KernelClient per benchmark case (reused across iterations).
 */
export async function runBenchmarks(
  cases: BenchmarkCase[],
  options: BenchmarkRunnerOptions,
): Promise<BenchmarkRunResult> {
  const { iterations, onProgress } = options;
  const totalWork = cases.length;
  const results: BenchmarkResult[] = [];
  const runStart = performance.now();

  for (const [caseIndex, benchCase] of cases.entries()) {
    onProgress?.(caseIndex, totalWork, benchCase.name);

    const timings: number[] = [];
    const allTelemetry: PerformanceEntryData[][] = [];
    const telemetryBatches: PerformanceEntryData[][] = [];

    const fileSystem = fromMemoryFS({ [absolutePath]: benchCase.code });
    const client = createKernelClient({
      kernels: [replicad({ ocTracing: 'summary' })],
      bundlers: [esbuild()],
      fileSystem,
      transport: createInProcessTransport(),
    });

    client.on('telemetry', (entries: PerformanceEntryData[]) => {
      telemetryBatches.push(entries);
    });

    for (let iter = 0; iter < iterations; iter++) {
      performance.clearMeasures();
      performance.clearMarks();
      telemetryBatches.length = 0;

      if (iter > 0) {
        await fileSystem.writeFile(absolutePath, benchCase.code);
        client.notifyFileChanged([absolutePath]);
      }

      const start = performance.now();
      await client.render({
        file: { filename: benchFileName, path: basePath },
        parameters: {},
      });
      const elapsed = performance.now() - start;

      timings.push(elapsed);
      allTelemetry.push(telemetryBatches.flat());
    }

    client.terminate();

    const stats = computeStats(timings);
    const ocSummary = extractOcSummary(allTelemetry);

    results.push({
      name: benchCase.name,
      category: benchCase.category,
      iterations,
      timings,
      ...stats,
      telemetry: allTelemetry,
      ocSummary,
    });
  }

  onProgress?.(totalWork, totalWork, 'done');

  return {
    timestamp: new Date().toISOString(),
    results,
    totalDurationMs: performance.now() - runStart,
  };
}
