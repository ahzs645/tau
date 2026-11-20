/* oxlint-disable no-await-in-loop -- Variants, parameter edits and exports serialize native work within the available memory and preserve session ordering. */
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { normalizeStaticGlb } from '#runtime/static-glb.js';
import type { GalleryRenderResult, GallerySession } from '#runtime/types.js';
import type { GalleryProject, GalleryVariant } from '#catalog/types.js';
import { loadNodeProjectFiles, readNodeCatalog } from '#scripts/catalog-node.js';
import type { NodeCatalogEntry } from '#scripts/catalog-node.js';
import { assertBoundsParity, measureGlb } from '#scripts/measure-glb.js';
import type { GeometrySummary } from '#scripts/measure-glb.js';
import { runVerificationProcess } from '#scripts/verification-process.js';
import { verificationFingerprint } from '#scripts/verification-fingerprint.js';
import { printabilityEvidenceSchema, verifyPrintability } from '#scripts/verify-printability.js';
import type { PrintabilityEvidence } from '#scripts/verify-printability.js';
import { exportEvidenceSchema, verifyGalleryExports } from '#scripts/verification-exports.js';
import type { ExportEvidence } from '#scripts/verification-exports.js';
import { canReuseVariant } from '#scripts/verification-progress.js';
import { verificationScenarios } from '#scripts/verification-scenarios.js';
import type { VerificationScenario } from '#scripts/verification-scenarios.js';

type CaseResult = {
  readonly project: string;
  readonly variant: string;
  readonly scenario: string;
  readonly milliseconds: number;
  readonly geometry?: GeometrySummary;
  readonly artifactHash?: string;
  readonly parameters?: Record<string, unknown>;
  readonly exports?: readonly ExportEvidence[];
  readonly previewArtifact?: string;
  readonly issues?: ReadonlyArray<{ code: string; severity: string; message: string }>;
  readonly printability?: PrintabilityEvidence;
  readonly error?: string;
};

type ParityResult = {
  project: string;
  reference: string;
  variant: string;
  status: 'passed' | 'intentional-difference' | 'failed';
  reason?: string;
};
type VerificationReport = {
  cases: CaseResult[];
  parity: ParityResult[];
  passed: boolean;
  startedAt: string;
  completedAt?: string;
  fingerprint?: string;
  complete: boolean;
  finishedVariants: string[];
};

const pointSchema = z.tuple([z.number(), z.number(), z.number()]);
const workerReportSchema = z.object({
  passed: z.boolean(),
  cases: z.array(
    z.object({
      project: z.string(),
      variant: z.string(),
      scenario: z.string(),
      milliseconds: z.number().nonnegative(),
      artifactHash: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
      geometry: z
        .object({
          triangles: z.number().int().positive(),
          meshInstances: z.number().int().positive(),
          boundsMm: z.object({ min: pointSchema, max: pointSchema, size: pointSchema }),
          signedVolumeMm3: z.number(),
          surfaceAreaMm2: z.number().positive(),
        })
        .optional(),
      exports: z.array(exportEvidenceSchema).optional(),
      previewArtifact: z.string().optional(),
      issues: z.array(z.object({ code: z.string(), severity: z.string(), message: z.string() })).optional(),
      printability: printabilityEvidenceSchema.optional(),
      error: z.string().optional(),
    }),
  ),
});
const resumeReportSchema = workerReportSchema.extend({
  startedAt: z.string(),
  fingerprint: z.string(),
  complete: z.boolean(),
  finishedVariants: z.array(z.string()),
});

const root = fileURLToPath(new URL('../../../', import.meta.url));
const argument = (name: string): string | undefined => {
  const assigned = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (assigned !== undefined) {
    const value = assigned.slice(name.length + 3);
    if (!value) {
      throw new Error(`--${name} needs a value`);
    }
    return value;
  }
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`--${name} needs a value`);
  }
  return value;
};
const flag = (name: string): boolean => {
  const prefix = `--${name}=`;
  const assigned = process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
  if (assigned === undefined) {
    return process.argv.includes(`--${name}`);
  }
  if (assigned !== 'true' && assigned !== 'false') {
    throw new Error(`--${name} accepts true or false`);
  }
  return assigned === 'true';
};
const filterProject = argument('project');
const filterVariant = argument('variant');
const allExports = flag('all-exports');
const withRegressions = flag('regressions');
const writeArtifacts = flag('write-artifacts');
const writeGeometry = flag('write-glb') || writeArtifacts;
const workerMode = flag('worker');
const resume = flag('resume');
const retryFailures = flag('retry-failures');
const maxVariantsArgument = argument('max-variants');
const maxVariants = maxVariantsArgument === undefined ? Infinity : Number(maxVariantsArgument);
if (maxVariantsArgument !== undefined && (!Number.isSafeInteger(maxVariants) || maxVariants < 1)) {
  throw new Error('--max-variants needs a positive whole number');
}
const variantTimeoutArgument = argument('variant-timeout');
const variantTimeout = variantTimeoutArgument === undefined ? undefined : Number(variantTimeoutArgument);
if (variantTimeout !== undefined && (!Number.isSafeInteger(variantTimeout) || variantTimeout < 1)) {
  throw new Error('--variant-timeout needs a positive whole number of milliseconds');
}
if (workerMode && (!filterProject || !filterVariant || !process.send)) {
  throw new Error('Verification workers require one variant and a parent process deadline');
}
const reportFile = path.resolve(root, argument('report') ?? 'out/reports/gallery/verification.json');
const baselinePath = argument('baseline');
const fingerprint = workerMode
  ? undefined
  : await verificationFingerprint({
      root,
      directories: [
        'apps/gallery/models',
        'apps/gallery/src/runtime',
        'apps/gallery/src/catalog',
        'apps/gallery/scripts',
        'packages/runtime/src',
        'packages/parameters/src',
        'packages/core/geometry/src',
        'packages/core/archive/src',
        'packages/core/cache/src',
        'packages/filesystem/src',
        'packages/kinematics/src',
        'packages/core/project/src',
        'packages/revisions/src',
        'packages/rpc/src',
        'packages/units/src',
        'libs/json-schema/src',
        'libs/types/src',
        'libs/utils/src',
        'packages/plugins/openrscad/src',
        'packages/plugins/opencascade/src',
        'packages/plugins/replicad/src',
        'packages/plugins/assimp/src',
        'packages/plugins/esbuild/src',
        'packages/plugins/middleware/src',
      ],
      files: ['pnpm-lock.yaml', 'apps/gallery/package.json'],
      options: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        allExports,
        withRegressions,
        writeGeometry,
        writeArtifacts,
        filterProject,
        filterVariant,
        variantTimeout,
      },
    });
const resumed = resume ? resumeReportSchema.parse(JSON.parse(await readFile(reportFile, 'utf8'))) : undefined;
if (resumed && resumed.fingerprint !== fingerprint) {
  throw new Error(
    'Cannot resume: verification sources, dependencies or selected checks changed. Start a fresh report.',
  );
}
const report: VerificationReport = {
  cases: resumed?.cases ?? [],
  parity: [],
  passed: true,
  complete: false,
  finishedVariants: resumed?.finishedVariants ?? [],
  startedAt: resumed?.startedAt ?? new Date().toISOString(),
  ...(fingerprint ? { fingerprint } : {}),
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasEnumeration = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => hasEnumeration(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  const enumeration = value['enum'];
  return (
    (Array.isArray(enumeration) && enumeration.length > 1) || Object.values(value).some((item) => hasEnumeration(item))
  );
};

const checkSize = (summary: GeometrySummary, scenario: VerificationScenario): void => {
  if (scenario.bedSizeMm) {
    assert.ok(
      summary.boundsMm.size[0] <= scenario.bedSizeMm[0] && summary.boundsMm.size[2] <= scenario.bedSizeMm[1],
      `Printed part exceeds the requested ${scenario.bedSizeMm.join(' × ')} mm bed`,
    );
  }
  if (scenario.expectedWidthMm !== undefined) {
    assert.ok(
      Math.abs(summary.boundsMm.size[0] - scenario.expectedWidthMm) < 0.02,
      `Expected width ${scenario.expectedWidthMm} mm; received ${summary.boundsMm.size[0]} mm`,
    );
  }
  if (scenario.expectedSizeMm) {
    for (const axis of [0, 1, 2] as const) {
      assert.ok(
        Math.abs(summary.boundsMm.size[axis] - scenario.expectedSizeMm[axis]) < 0.02,
        `Axis ${axis}: expected ${scenario.expectedSizeMm[axis]} mm; received ${summary.boundsMm.size[axis]} mm`,
      );
    }
  }
};

const writeCheckpoint = async (): Promise<void> => {
  report.passed =
    report.complete &&
    report.cases.every((row) => row.error === undefined) &&
    report.parity.every((row) => row.status !== 'failed');
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(`${reportFile}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  await rename(`${reportFile}.tmp`, reportFile);
};

const reportOperation = (operation: string, scenario = 'startup'): void => {
  process.send?.({ type: 'operation-start', operation, scenario });
};

const saveArtifact = async (name: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const directory = path.join(root, 'out/artifacts/gallery/models');
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, name);
  await writeFile(filename, bytes);
  return path.relative(root, filename);
};

const verifyScenario = async (input: {
  readonly session: GallerySession;
  readonly project: GalleryProject;
  readonly variant: GalleryVariant;
  readonly scenario: VerificationScenario;
}): Promise<CaseResult> => {
  const { session, project, variant, scenario } = input;
  const started = performance.now();
  const resultBase = { project: project.id, variant: variant.id, scenario: scenario.name };
  let geometry: GeometrySummary | undefined;
  let printability: PrintabilityEvidence | undefined;
  let exports: ExportEvidence[] | undefined;
  let previewArtifact: string | undefined;
  let renderEvidence: Pick<CaseResult, 'artifactHash' | 'parameters' | 'issues'> = {};
  try {
    let result: GalleryRenderResult;
    try {
      reportOperation('render', scenario.name);
      result = await session.render(scenario.parameters);
    } catch (error) {
      if (scenario.expectedError && errorMessage(error).includes(scenario.expectedError)) {
        return { ...resultBase, milliseconds: performance.now() - started };
      }
      throw error;
    }
    if (scenario.expectedError) {
      throw new Error(`Expected model rejection containing "${scenario.expectedError}", but render succeeded`);
    }
    renderEvidence = {
      artifactHash: result.artifactHash,
      parameters: result.parameters,
      issues: result.issues.map(({ code, severity, message }) => ({ code, severity, message })),
    };
    assert.equal(
      result.artifact.mimeType,
      'model/gltf-binary',
      'The viewer must receive a portable binary glTF artifact',
    );
    assert.ok(result.artifact.content instanceof Uint8Array, 'GLB artifact must carry bytes');
    const bytes = new Uint8Array(result.artifact.content);
    const artifactPrefix = `${project.id}--${variant.id}--${scenario.name}`;
    if (writeGeometry) {
      previewArtifact = await saveArtifact(`${artifactPrefix}.glb`, bytes);
    }
    geometry = await measureGlb(bytes);
    exports = await verifyGalleryExports({
      session,
      geometry,
      formats: allExports ? variant.exportFormats : ['glb'],
      onStart(format) {
        reportOperation(`export:${format}`, scenario.name);
      },
      async saveFile({ format, file, index }) {
        if (format === 'glb' ? writeGeometry : writeArtifacts) {
          return saveArtifact(
            `${artifactPrefix}--export-${format}-${index + 1}-${path.basename(file.name)}`,
            file.bytes,
          );
        }
        return undefined;
      },
    });
    checkSize(geometry, scenario);
    if (scenario.expectedComponents !== undefined) {
      reportOperation('printability', scenario.name);
      printability = await verifyPrintability(bytes, scenario.expectedComponents);
      const failedClaims = printability.claims.filter((claim) => claim.status !== 'passed');
      assert.equal(
        failedClaims.length,
        0,
        failedClaims.map((claim) => `${claim.matcher}: ${claim.canonicalResult}`).join('\n'),
      );
    }
    if (['pet-bottle-opener', 'replicad-tray', 'opencascade-box'].includes(project.id)) {
      assert.ok(hasEnumeration(result.jsonSchema), `${project.id} lost its authored dropdown schema`);
    }
    const failedExports = exports.filter((entry) => entry.error !== undefined);
    assert.equal(failedExports.length, 0, failedExports.map((entry) => `${entry.format}: ${entry.error}`).join('\n'));
    assert.ok(!result.issues.some((issue) => issue.severity === 'error'), 'Render returned error diagnostics');
    console.log(
      `PASS ${project.id}/${variant.id}/${scenario.name}: ${geometry.triangles} triangles; ${geometry.boundsMm.size.map((value) => value.toFixed(3)).join(' × ')} mm`,
    );
    return {
      ...resultBase,
      milliseconds: performance.now() - started,
      geometry,
      exports,
      ...renderEvidence,
      ...(previewArtifact ? { previewArtifact } : {}),
      ...(printability ? { printability } : {}),
    };
  } catch (error) {
    console.error(`FAIL ${project.id}/${variant.id}/${scenario.name}: ${errorMessage(error)}`);
    return {
      ...resultBase,
      milliseconds: performance.now() - started,
      error: errorMessage(error),
      ...renderEvidence,
      ...(exports ? { exports } : {}),
      ...(previewArtifact ? { previewArtifact } : {}),
      ...(geometry ? { geometry } : {}),
      ...(printability ? { printability } : {}),
    };
  }
};

const verifyVariant = async (entry: NodeCatalogEntry, variant: GalleryVariant): Promise<void> => {
  // The controller must not retain the runtime graph beside each isolated native child.
  const { createNodeGallerySession } = await import('#runtime/node.js');
  const { project } = entry;
  reportOperation('load');
  const files = await loadNodeProjectFiles(entry);
  reportOperation('describe');
  const session = await createNodeGallerySession({
    kernel: variant.kernel,
    entryPath: variant.entry,
    files,
    parameters: variant.id === project.defaultVariantId ? project.initialParameters : {},
    renderOptions: variant.renderOptions,
    operationTimeout: variant.renderTimeout ?? 180_000,
  });
  try {
    for (const scenario of verificationScenarios(project, variant, withRegressions)) {
      const result = await verifyScenario({ session, project, variant, scenario });
      report.cases.push(result);
      report.passed &&= result.error === undefined;
      await writeCheckpoint();
    }
  } finally {
    reportOperation('dispose');
    await session.dispose();
  }
};

const verifyVariantInChild = async (entry: NodeCatalogEntry, variant: GalleryVariant): Promise<void> => {
  report.cases = report.cases.filter((row) => row.project !== entry.project.id || row.variant !== variant.id);
  const childReport = path.join(path.dirname(reportFile), 'variants', `${entry.project.id}--${variant.id}.json`);
  await mkdir(path.dirname(childReport), { recursive: true });
  // An empty initial checkpoint prevents a killed worker from reusing a previous run's evidence.
  await writeFile(
    childReport,
    JSON.stringify({ cases: [], parity: [], passed: false, startedAt: new Date().toISOString() }),
  );
  const started = performance.now();
  const outcome = await runVerificationProcess({
    args: [
      '--import',
      'tsx',
      fileURLToPath(import.meta.url),
      '--worker',
      '--project',
      entry.project.id,
      '--variant',
      variant.id,
      '--report',
      childReport,
      `--all-exports=${allExports}`,
      `--regressions=${withRegressions}`,
      `--write-glb=${writeGeometry}`,
      `--write-artifacts=${writeArtifacts}`,
    ],
    cwd: root,
    operationTimeout: variant.renderTimeout ?? 180_000,
    ...(variantTimeout === undefined ? {} : { totalTimeout: variantTimeout }),
    onOutput: (stream, text) => {
      process[stream].write(text);
    },
  });
  const saved = workerReportSchema.parse(JSON.parse(await readFile(childReport, 'utf8')));
  for (const value of saved.cases) {
    if (value.project !== entry.project.id || value.variant !== variant.id) {
      throw new Error('Worker report did not match its requested project and variant');
    }
  }
  report.cases.push(...saved.cases);
  const missingScenarios = verificationScenarios(entry.project, variant, withRegressions).filter(
    (scenario) => !saved.cases.some((row) => row.scenario === scenario.name),
  );
  if (outcome.exitCode === 0 && missingScenarios.length > 0) {
    report.cases.push({
      project: entry.project.id,
      variant: variant.id,
      scenario: 'coverage',
      milliseconds: performance.now() - started,
      error: `Worker omitted required scenarios: ${missingScenarios.map((scenario) => scenario.name).join(', ')}`,
    });
  }
  const failedCase = saved.cases.some((value) => value.error !== undefined);
  if (outcome.timedOut || (outcome.exitCode !== 0 && !failedCase)) {
    report.passed = false;
    report.cases.push({
      project: entry.project.id,
      variant: variant.id,
      scenario: outcome.scenario,
      milliseconds: performance.now() - started,
      error: outcome.timedOut
        ? `Parent process deadline exceeded during ${outcome.operation}`
        : `Worker exited with code ${outcome.exitCode}, signal ${outcome.signal}`,
    });
  }
  report.passed &&= saved.passed && outcome.exitCode === 0 && !outcome.timedOut;
  await writeCheckpoint();
};

const verifySelectedVariant = workerMode ? verifyVariant : verifyVariantInChild;

const baseline: unknown = baselinePath
  ? JSON.parse(await readFile(path.resolve(root, baselinePath), 'utf8'))
  : undefined;
if (baseline !== undefined && (!isRecord(baseline) || !Array.isArray(baseline['cases']))) {
  throw new Error('Baseline must be a gallery verification JSON report');
}
const inventory = await readNodeCatalog();
const catalogue = inventory.filter(
  ({ project }) => !project.hidden && (!filterProject || project.id === filterProject),
);
if (catalogue.length === 0) {
  throw new Error(`No gallery projects matched ${filterProject ?? 'the public inventory'}`);
}

let executedVariants = 0;
const signalState = { stopRequested: false };
let selectionComplete = true;
if (!workerMode) {
  // A caller can yield the native-work slot without interrupting the current bounded child.
  process.on('SIGUSR1', () => {
    signalState.stopRequested = true;
  });
}

for (const entry of catalogue) {
  if (entry.project.mode === 'static') {
    if (filterVariant) {
      continue;
    }
    if (
      resume &&
      report.cases.some((row) => row.project === entry.project.id && row.variant === 'static' && !row.error)
    ) {
      continue;
    }
    report.cases = report.cases.filter((row) => row.project !== entry.project.id || row.variant !== 'static');
    try {
      assert.ok(entry.project.staticPreviewFile, 'Static project has no model resource');
      const bytes = new Uint8Array(await readFile(path.join(entry.directory, entry.project.staticPreviewFile)));
      const normalized = normalizeStaticGlb(bytes, entry.project.staticPreviewCoordinateSystem ?? 'y-up');
      report.cases.push({
        project: entry.project.id,
        variant: 'static',
        scenario: 'defaults',
        milliseconds: 0,
        geometry: await measureGlb(normalized),
      });
    } catch (error) {
      report.passed = false;
      report.cases.push({
        project: entry.project.id,
        variant: 'static',
        scenario: 'defaults',
        milliseconds: 0,
        error: errorMessage(error),
      });
    }
    await writeCheckpoint();
    continue;
  }
  for (const variant of entry.project.variants.filter(
    (candidate) => !filterVariant || candidate.id === filterVariant,
  )) {
    if (
      resume &&
      canReuseVariant({
        project: entry.project.id,
        variant: variant.id,
        finishedVariants: report.finishedVariants,
        cases: report.cases,
        retryFailures,
      })
    ) {
      console.log(
        `REUSED ${entry.project.id}/${variant.id}: unchanged inputs and completed attempt (all failure evidence retained)`,
      );
      continue;
    }
    if (signalState.stopRequested || executedVariants >= maxVariants) {
      selectionComplete = false;
      break;
    }
    executedVariants += 1;
    try {
      await verifySelectedVariant(entry, variant);
    } catch (error) {
      report.passed = false;
      report.cases.push({
        project: entry.project.id,
        variant: variant.id,
        scenario: 'startup',
        milliseconds: 0,
        error: errorMessage(error),
      });
      console.error(`FAIL ${entry.project.id}/${variant.id}/startup: ${errorMessage(error)}`);
      await writeCheckpoint();
    }
    const finishedId = `${entry.project.id}/${variant.id}`;
    if (!report.finishedVariants.includes(finishedId)) {
      report.finishedVariants.push(finishedId);
    }
    await writeCheckpoint();
  }
  if (!selectionComplete) {
    break;
  }
  const reference = report.cases.find(
    (result) =>
      result.project === entry.project.id &&
      result.variant === entry.project.defaultVariantId &&
      result.scenario === 'defaults',
  );
  if (!reference?.geometry) {
    continue;
  }
  for (const result of report.cases.filter(
    (candidate) =>
      candidate.project === entry.project.id &&
      candidate.scenario === 'defaults' &&
      candidate.variant !== reference.variant &&
      candidate.geometry,
  )) {
    const variant = entry.project.variants.find((candidate) => candidate.id === result.variant);
    const exclusion = variant ? entry.project.parityExclusions[variant.id] : undefined;
    if (exclusion) {
      report.parity.push({
        project: entry.project.id,
        reference: reference.variant,
        variant: result.variant,
        status: 'intentional-difference',
        reason: exclusion,
      });
      continue;
    }
    try {
      assert.ok(result.geometry);
      assertBoundsParity(reference.geometry, result.geometry);
      report.parity.push({
        project: entry.project.id,
        reference: reference.variant,
        variant: result.variant,
        status: 'passed',
      });
    } catch (error) {
      report.passed = false;
      report.parity.push({
        project: entry.project.id,
        reference: reference.variant,
        variant: result.variant,
        status: 'failed',
        reason: errorMessage(error),
      });
    }
  }
}

if (report.cases.length === 0) {
  throw new Error('The selected filters did not execute any gallery case');
}
if (isRecord(baseline) && Array.isArray(baseline['cases'])) {
  // Validate baseline records with the same finite geometry requirements before comparing.
  for (const actual of report.cases.filter((result) => result.geometry)) {
    const saved: unknown = baseline['cases'].find(
      (value: unknown) =>
        isRecord(value) &&
        value['project'] === actual.project &&
        value['variant'] === actual.variant &&
        value['scenario'] === actual.scenario,
    );
    if (!isRecord(saved) || !isRecord(saved['geometry']) || !isRecord(saved['geometry']['boundsMm'])) {
      report.passed = false;
      report.parity.push({
        project: actual.project,
        reference: 'baseline',
        variant: actual.variant,
        status: 'failed',
        reason: `Missing baseline geometry for scenario ${actual.scenario}`,
      });
      continue;
    }
    const expectedBounds = saved['geometry']['boundsMm'];
    const keys = ['min', 'max'] as const;
    let difference = 0;
    for (const key of keys) {
      const values = expectedBounds[key];
      if (
        !Array.isArray(values) ||
        values.length !== 3 ||
        !values.every((value) => typeof value === 'number' && Number.isFinite(value))
      ) {
        difference = Infinity;
        break;
      }
      for (const axis of [0, 1, 2] as const) {
        difference = Math.max(difference, Math.abs(values[axis] - actual.geometry!.boundsMm[key][axis]));
      }
    }
    const passed = difference <= 0.5;
    report.passed &&= passed;
    report.parity.push({
      project: actual.project,
      reference: 'baseline',
      variant: actual.variant,
      status: passed ? 'passed' : 'failed',
      reason: `${actual.scenario}: maximum envelope difference ${difference} mm`,
    });
  }
}
report.completedAt = new Date().toISOString();
report.complete = selectionComplete;
const checksPassed =
  report.cases.every((row) => row.error === undefined) && report.parity.every((row) => row.status !== 'failed');
report.passed = report.complete && checksPassed;
await writeCheckpoint();
console.log(
  `${checksPassed ? (report.complete ? 'PASS' : 'PAUSED') : 'FAIL'}: ${report.cases.length} cases, ${report.parity.length} parity checks. Report: ${reportFile}`,
);
process.exitCode = checksPassed ? 0 : 1;
/* oxlint-enable no-await-in-loop */
