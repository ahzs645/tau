import type { FileExtension } from '@taucad/types';
import { z } from 'zod';
import type { PlaygroundExample } from '#routes/playground/playground-examples.js';

const meshExportFormats = ['glb', 'stl', '3mf', 'obj'] as const;
const solidExportFormats = ['glb', 'stl', '3mf', 'step'] as const;
const exportFormats = ['glb', 'stl', '3mf', 'obj', 'step'] as const satisfies readonly FileExtension[];

export const projectMetadataSchema = z.looseObject({
  title: z.string().min(1),
  entry: z.string().min(1),
  description: z.string(),
  mainFile: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  kernel: z.enum(['OpenSCAD', 'Replicad', 'OpenCascade']).optional(),
  engine: z.enum(['openscad', 'replicad', 'opencascade', 'occt']).optional(),
  hidden: z.boolean().optional(),
  exportFormats: z.array(z.enum(exportFormats)).optional(),
  initialParameters: z.record(z.string(), z.unknown()).optional(),
});

export const projectPresetsSchema = z.array(
  z.object({
    name: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()),
  }),
);

type ProjectMetadata = z.infer<typeof projectMetadataSchema>;
type ProjectPresets = z.infer<typeof projectPresetsSchema>;

const projectMetadataByPath = import.meta.glob<unknown>('./projects/*/project.json', {
  eager: true,
  import: 'default',
});

const projectPresetsByPath = import.meta.glob<unknown>('./projects/*/presets.json', {
  eager: true,
  import: 'default',
});

const projectSourceByPath = import.meta.glob<string>('./projects/**/*.{js,json,scad,svg,txt}', {
  eager: true,
  import: 'default',
  query: '?raw',
});

export const projectExamples: readonly PlaygroundExample[] = Object.entries(projectMetadataByPath)
  .flatMap(([metadataPath, rawMetadata]) => {
    const metadata = parseProjectMetadata(metadataPath, rawMetadata);
    if (metadata.hidden === true) {
      return [];
    }

    const projectId = projectIdFromMetadataPath(metadataPath);
    const presets = presetsForProject(projectId);
    const sourceFiles = sourceFilesForProject(projectId, metadata);
    const mainFile = metadata.mainFile ?? metadata.entry;
    const entryFile = metadata.entry;
    const code = sourceFiles[mainFile] ?? sourceFiles[entryFile];

    if (!code) {
      throw new Error(`Project "${projectId}" is missing source for entry "${entryFile}"`);
    }

    return [
      {
        id: projectId,
        name: metadata.name ?? metadata.title,
        kernel: kernelFromMetadata(metadata),
        mainFile,
        language: languageFromMetadata(metadata, mainFile),
        description: metadata.description,
        exportFormats: metadata.exportFormats ?? exportFormatsFromMetadata(metadata),
        ...(metadata.initialParameters ? { initialParameters: metadata.initialParameters } : {}),
        ...(presets ? { presets } : {}),
        code,
        sourceFiles,
      },
    ];
  })
  .sort((left, right) => left.name.localeCompare(right.name));

function parseProjectMetadata(metadataPath: string, rawMetadata: unknown): ProjectMetadata {
  const result = projectMetadataSchema.safeParse(rawMetadata);
  if (result.success) {
    return result.data;
  }

  throw new Error(`Invalid root playground project metadata at "${metadataPath}": ${z.prettifyError(result.error)}`);
}

function projectIdFromMetadataPath(metadataPath: string): string {
  const match = /^\.\/projects\/([^/]+)\/project\.json$/u.exec(metadataPath);
  if (!match?.[1]) {
    throw new Error(`Unexpected project metadata path "${metadataPath}"`);
  }
  return match[1];
}

function presetsForProject(projectId: string): ProjectPresets | undefined {
  const presetsPath = `./projects/${projectId}/presets.json`;
  const rawPresets = projectPresetsByPath[presetsPath];
  if (!rawPresets) {
    return undefined;
  }

  const result = projectPresetsSchema.safeParse(rawPresets);
  if (result.success) {
    return result.data;
  }

  throw new Error(`Invalid root playground project presets at "${presetsPath}": ${z.prettifyError(result.error)}`);
}

function sourceFilesForProject(projectId: string, metadata: ProjectMetadata): Record<string, string> {
  const prefix = `./projects/${projectId}/`;
  const sourceFiles: Record<string, string> = {};

  for (const [sourcePath, source] of Object.entries(projectSourceByPath)) {
    if (
      !sourcePath.startsWith(prefix) ||
      sourcePath === `${prefix}project.json` ||
      sourcePath === `${prefix}presets.json`
    ) {
      continue;
    }

    const relativePath = sourcePath.slice(prefix.length);
    sourceFiles[relativePath] = source;
  }

  if (metadata.entry && metadata.mainFile && metadata.entry !== metadata.mainFile) {
    const entrySource = sourceFiles[metadata.entry];
    if (entrySource) {
      sourceFiles[metadata.mainFile] = entrySource;
    }
  }

  return sourceFiles;
}

function kernelFromMetadata(metadata: ProjectMetadata): PlaygroundExample['kernel'] {
  if (metadata.kernel) {
    return metadata.kernel;
  }

  switch (metadata.engine) {
    case 'replicad': {
      return 'Replicad';
    }
    case 'opencascade':
    case 'occt': {
      return 'OpenCascade';
    }
    default: {
      return 'OpenSCAD';
    }
  }
}

function languageFromMetadata(metadata: ProjectMetadata, mainFile: string): string {
  if (metadata.language) {
    return metadata.language;
  }

  if (mainFile.endsWith('.ts') || mainFile.endsWith('.js')) {
    return 'typescript';
  }

  return 'scad';
}

function exportFormatsFromMetadata(metadata: ProjectMetadata): readonly FileExtension[] {
  return kernelFromMetadata(metadata) === 'OpenSCAD' ? meshExportFormats : solidExportFormats;
}
