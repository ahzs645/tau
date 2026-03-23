import process from 'node:process';
import type { Model } from '#api/models/model.schema.js';
import type { ProviderId } from '#api/providers/provider.schema.js';
import type { CloudProviderId } from '#api/models/model.service.js';
import { modelList } from '#api/models/model.constants.js';
import type { BenchmarkGeometryExpectation } from '#benchmarks/model-benchmark-geometry.js';

// =============================================================================
// Types
// =============================================================================

export type GraderCheck = {
  name: string;
  passed: boolean;
  detail?: string;
};

export type GraderResult = {
  score: number;
  passed: boolean;
  checks: GraderCheck[];
};

export type ModelRunOutcome = {
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  filesCreated: Record<string, string>;
  error?: string;
};

export type ModelBenchmarkCase = {
  name: string;
  category: string;
  prompt: string;
  grader: (outcome: ModelRunOutcome) => GraderResult;
  geometryExpectations?: BenchmarkGeometryExpectation;
};

export type FlatModel = Model & { providerId: ProviderId };

// =============================================================================
// Provider API Key Mapping
// =============================================================================

const providerKeyMap: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  vertexai: 'GOOGLE_VERTEX_AI_CREDENTIALS',
  together: 'TOGETHER_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
};

function hasApiKey(providerId: string): boolean {
  const envVariable = providerKeyMap[providerId];
  if (!envVariable) {
    return false;
  }
  const value = process.env[envVariable];
  return Boolean(value && value.length > 0);
}

// =============================================================================
// Model Flattening & Filtering
// =============================================================================

export type FilterOptions = {
  providers?: string[];
  models?: string[];
  categories?: string[];
};

export function flattenModels(): FlatModel[] {
  const result: FlatModel[] = [];
  for (const [providerId, models] of Object.entries(modelList) as Array<[CloudProviderId, Record<string, Model>]>) {
    for (const model of Object.values(models)) {
      result.push({ ...model, providerId });
    }
  }
  return result;
}

export function filterModels(options?: FilterOptions): { active: FlatModel[]; skipped: FlatModel[] } {
  let all = flattenModels();

  if (options?.providers?.length) {
    all = all.filter((m) => options.providers!.includes(m.providerId));
  }

  if (options?.models?.length) {
    all = all.filter((m) => options.models!.includes(m.id));
  }

  const active: FlatModel[] = [];
  const skipped: FlatModel[] = [];

  for (const model of all) {
    if (hasApiKey(model.providerId)) {
      active.push(model);
    } else {
      skipped.push(model);
    }
  }

  return { active, skipped };
}

// =============================================================================
// Grader Helpers
// =============================================================================

const scadMainFile = 'main.scad';
const cubePattern = /cube\s*\(/;
const cylinderPattern = /cylinder\s*\(/;
const spherePattern = /sphere\s*\(/;

function checkToolCalled(outcome: ModelRunOutcome, toolName: string): GraderCheck {
  const called = outcome.toolCalls.some((tc) => tc.name === toolName);
  return { name: `tool_called:${toolName}`, passed: called, detail: called ? undefined : `${toolName} was not called` };
}

function checkFileCreated(outcome: ModelRunOutcome, filename: string): GraderCheck {
  const normalizedFiles = Object.keys(outcome.filesCreated).map((f) => f.replace(/^\//, ''));
  const found = normalizedFiles.includes(filename.replace(/^\//, ''));
  return { name: 'file_created', passed: found, detail: found ? undefined : `${filename} not found in memFs` };
}

type FileContainsOptions = {
  outcome: ModelRunOutcome;
  filename: string;
  pattern: RegExp;
};

function checkFileContains({ outcome, filename, pattern }: FileContainsOptions, label: string): GraderCheck {
  const content = findFileContent(outcome.filesCreated, filename);
  if (!content) {
    return { name: label, passed: false, detail: `${filename} not found` };
  }
  const matched = pattern.test(content);
  return {
    name: label,
    passed: matched,
    detail: matched ? undefined : `Pattern ${String(pattern)} not matched in ${filename}`,
  };
}

function findFileContent(files: Record<string, string>, filename: string): string | undefined {
  const normalized = filename.replace(/^\//, '');
  for (const [filePath, content] of Object.entries(files)) {
    if (filePath.replace(/^\//, '') === normalized) {
      return content;
    }
  }
  return undefined;
}

function computeGraderResult(checks: GraderCheck[], threshold = 0.8): GraderResult {
  const total = checks.length;
  if (total === 0) {
    return { score: 0, passed: false, checks };
  }
  const passedCount = checks.filter((c) => c.passed).length;
  const score = passedCount / total;
  return { score, passed: score >= threshold, checks };
}

// =============================================================================
// Benchmark Cases
// =============================================================================

function smokeGrader(outcome: ModelRunOutcome): GraderResult {
  const checks = [
    checkToolCalled(outcome, 'create_file'),
    checkFileCreated(outcome, scadMainFile),
    checkFileContains({ outcome, filename: scadMainFile, pattern: cubePattern }, 'has_cube_call'),
  ];
  return computeGraderResult(checks);
}

const smoke: ModelBenchmarkCase[] = [
  {
    name: 'cube-20mm',
    category: 'smoke',
    prompt: 'Create a 20mm cube in main.scad using OpenSCAD. Use the create_file tool. Write valid OpenSCAD code.',
    grader: smokeGrader,
    geometryExpectations: { boundingBox: { size: { x: 20, y: 20, z: 20 } }, meshCount: 1 },
  },
  {
    name: 'cylinder-basic',
    category: 'smoke',
    prompt:
      'Create a cylinder with radius 15mm and height 40mm in main.scad using OpenSCAD. Use the create_file tool. Use $fn=64 for smoothness.',
    grader(outcome) {
      const checks = [
        checkToolCalled(outcome, 'create_file'),
        checkFileCreated(outcome, scadMainFile),
        checkFileContains({ outcome, filename: scadMainFile, pattern: cylinderPattern }, 'has_cylinder_call'),
      ];
      return computeGraderResult(checks);
    },
    geometryExpectations: { boundingBox: { size: { x: 30, y: 30, z: 40 } }, meshCount: 1, tolerance: 2 },
  },
  {
    name: 'sphere-simple',
    category: 'smoke',
    prompt:
      'Create a sphere with radius 25mm in main.scad using OpenSCAD. Use the create_file tool. Use $fn=64 for smoothness.',
    grader(outcome) {
      const checks = [
        checkToolCalled(outcome, 'create_file'),
        checkFileCreated(outcome, scadMainFile),
        checkFileContains({ outcome, filename: scadMainFile, pattern: spherePattern }, 'has_sphere_call'),
      ];
      return computeGraderResult(checks);
    },
    geometryExpectations: { boundingBox: { size: { x: 50, y: 50, z: 50 } }, meshCount: 1, tolerance: 2 },
  },
];

const toolUse: ModelBenchmarkCase[] = [
  {
    name: 'create-with-params',
    category: 'tool-use',
    prompt: [
      'Create a parametric box in main.scad using OpenSCAD with parameters width=30, height=20, depth=10.',
      'Use the create_file tool. Define the parameters at the top of the file as OpenSCAD variables.',
    ].join('\n'),
    grader(outcome) {
      const checks = [
        checkToolCalled(outcome, 'create_file'),
        checkFileCreated(outcome, scadMainFile),
        checkFileContains({ outcome, filename: scadMainFile, pattern: cubePattern }, 'has_cube_call'),
        checkFileContains({ outcome, filename: scadMainFile, pattern: /width\s*=/ }, 'has_width_param'),
      ];
      return computeGraderResult(checks);
    },
    geometryExpectations: { boundingBox: { size: { x: 30, y: 10, z: 20 } }, meshCount: 1, tolerance: 2 },
  },
  {
    name: 'explicit-code',
    category: 'tool-use',
    prompt: [
      'Create a file called main.scad with EXACTLY the following content using the create_file tool:',
      '',
      'size = 20;',
      'cube([size, size, size]);',
    ].join('\n'),
    grader(outcome) {
      const checks = [
        checkToolCalled(outcome, 'create_file'),
        checkFileCreated(outcome, scadMainFile),
        checkFileContains({ outcome, filename: scadMainFile, pattern: cubePattern }, 'has_cube_call'),
        checkFileContains({ outcome, filename: scadMainFile, pattern: /size\s*=\s*20/ }, 'has_size_param'),
      ];
      return computeGraderResult(checks);
    },
    geometryExpectations: { boundingBox: { size: { x: 20, y: 20, z: 20 } }, meshCount: 1 },
  },
];

const primitives: ModelBenchmarkCase[] = [
  {
    name: 'box-translated',
    category: 'primitives',
    prompt:
      'Create a 30x20x10 box translated 15mm on the X axis in main.scad using OpenSCAD. Use the create_file tool.',
    grader(outcome) {
      const checks = [
        checkToolCalled(outcome, 'create_file'),
        checkFileCreated(outcome, scadMainFile),
        checkFileContains({ outcome, filename: scadMainFile, pattern: cubePattern }, 'has_cube_call'),
        checkFileContains({ outcome, filename: scadMainFile, pattern: /translate/ }, 'has_translate'),
      ];
      return computeGraderResult(checks);
    },
    geometryExpectations: { boundingBox: { size: { x: 30, y: 10, z: 20 } }, meshCount: 1, tolerance: 2 },
  },
  {
    name: 'linear-extrude',
    category: 'primitives',
    prompt:
      'Create a 40x30 rectangle using square() and linear_extrude it 10mm in main.scad using OpenSCAD. Use the create_file tool.',
    grader(outcome) {
      const checks = [
        checkToolCalled(outcome, 'create_file'),
        checkFileCreated(outcome, scadMainFile),
        checkFileContains({ outcome, filename: scadMainFile, pattern: /linear_extrude/ }, 'has_linear_extrude'),
        checkFileContains({ outcome, filename: scadMainFile, pattern: /square/ }, 'has_square'),
      ];
      return computeGraderResult(checks);
    },
    geometryExpectations: { meshCount: 1 },
  },
  {
    name: 'rotate-extrude',
    category: 'primitives',
    prompt:
      'Create a torus by rotate_extrude of a translated circle (r=5, translated 15mm on X) in main.scad using OpenSCAD. Use the create_file tool. Use $fn=64.',
    grader(outcome) {
      const checks = [
        checkToolCalled(outcome, 'create_file'),
        checkFileCreated(outcome, scadMainFile),
        checkFileContains({ outcome, filename: scadMainFile, pattern: /rotate_extrude/ }, 'has_rotate_extrude'),
        checkFileContains({ outcome, filename: scadMainFile, pattern: /circle/ }, 'has_circle'),
      ];
      return computeGraderResult(checks);
    },
    geometryExpectations: { meshCount: 1 },
  },
];

const booleans: ModelBenchmarkCase[] = [
  {
    name: 'union-two-boxes',
    category: 'booleans',
    prompt:
      'Create two overlapping cubes and union them together in main.scad using OpenSCAD. Use the create_file tool.',
    grader(outcome) {
      const checks = [
        checkToolCalled(outcome, 'create_file'),
        checkFileCreated(outcome, scadMainFile),
        checkFileContains({ outcome, filename: scadMainFile, pattern: /union\s*\(/ }, 'has_union'),
        checkFileContains({ outcome, filename: scadMainFile, pattern: cubePattern }, 'has_cube_call'),
      ];
      return computeGraderResult(checks);
    },
    geometryExpectations: { meshCount: 1, connectedComponents: 1 },
  },
  {
    name: 'difference-hole',
    category: 'booleans',
    prompt:
      'Create a cube and cut a cylindrical hole through its center using difference() in main.scad using OpenSCAD. Use the create_file tool. Use $fn=64 for the cylinder.',
    grader(outcome) {
      const checks = [
        checkToolCalled(outcome, 'create_file'),
        checkFileCreated(outcome, scadMainFile),
        checkFileContains({ outcome, filename: scadMainFile, pattern: /difference\s*\(/ }, 'has_difference'),
        checkFileContains({ outcome, filename: scadMainFile, pattern: cylinderPattern }, 'has_cylinder_call'),
      ];
      return computeGraderResult(checks);
    },
    geometryExpectations: { meshCount: 1, connectedComponents: 1 },
  },
];

// =============================================================================
// Suite Export
// =============================================================================

export const benchmarkSuite: ModelBenchmarkCase[] = [...smoke, ...toolUse, ...primitives, ...booleans];

export const benchmarkCategories: string[] = [...new Set(benchmarkSuite.map((c) => c.category))];

export function filterBenchmarks(filter?: string[]): ModelBenchmarkCase[] {
  if (!filter || filter.length === 0) {
    return benchmarkSuite;
  }
  return benchmarkSuite.filter((c) => filter.includes(c.category) || filter.includes(c.name));
}
