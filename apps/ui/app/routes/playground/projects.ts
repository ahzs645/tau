import type { FileExtension } from '@taucad/types';
import { replicadExampleCode } from '@taucad/tau-examples';
import { z } from 'zod';
import type { PlaygroundExample } from '#routes/playground/playground-examples.js';

const meshExportFormats = ['glb', 'stl', '3mf', 'obj'] as const;
const solidExportFormats = ['glb', 'stl', '3mf', 'step'] as const;
const exportFormats = ['glb', 'stl', '3mf', 'obj', 'step'] as const satisfies readonly FileExtension[];

export const projectMetadataSchema = z.looseObject({
  title: z.string().min(1),
  entry: z.string().min(1),
  description: z.string(),
  type: z.enum(['scad', 'static']).optional(),
  mainFile: z.string().min(1).optional(),
  // Pulls the project's code from @taucad/tau-examples (the canonical source)
  // instead of a local file, keyed by the example folder name. Avoids keeping a
  // duplicate copy of the source in this app.
  libSource: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  kernel: z.enum(['OpenSCAD', 'Replicad', 'OpenCascade', 'Static']).optional(),
  engine: z.enum(['openscad', 'replicad', 'opencascade', 'occt']).optional(),
  hidden: z.boolean().optional(),
  exportFormats: z.array(z.enum(exportFormats)).optional(),
  initialParameters: z.record(z.string(), z.unknown()).optional(),
  previewGlb: z.string().min(1).optional(),
  staticPreview: z
    .object({
      glb: z.string().min(1),
    })
    .optional(),
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

const projectSourceByPath = import.meta.glob<string>('./projects/**/*.{js,ts,json,scad,svg,txt}', {
  eager: true,
  import: 'default',
  query: '?raw',
});

const projectStaticPreviewGlbByPath = import.meta.glob<string>('./projects/**/*.glb', {
  eager: true,
  import: 'default',
  query: '?url',
});

export const projectExamples: readonly PlaygroundExample[] = Object.entries(projectMetadataByPath)
  .flatMap<PlaygroundExample>(([metadataPath, rawMetadata]) => {
    const metadata = parseProjectMetadata(metadataPath, rawMetadata);
    if (metadata.hidden === true) {
      return [];
    }

    const projectId = projectIdFromMetadataPath(metadataPath);
    const presets = presetsForProject(projectId);
    const sourceFiles = sourceFilesForProject(projectId, metadata);
    const mainFile = metadata.mainFile ?? metadata.entry;
    const entryFile = metadata.entry;

    // Projects with `libSource` pull their canonical code from @taucad/tau-examples
    // rather than carrying a duplicate copy in this app's project folder.
    if (metadata.libSource) {
      const libCode = replicadExampleCode[metadata.libSource];
      if (!libCode) {
        throw new Error(`Project "${projectId}" references unknown libSource "${metadata.libSource}"`);
      }
      sourceFiles[mainFile] = libCode;
      sourceFiles[entryFile] = libCode;
    }

    const code = sourceFiles[mainFile] ?? sourceFiles[entryFile];
    const staticPreview = staticPreviewForProject(projectId, metadata);
    const mode = modeFromMetadata(metadata);

    if (mode === 'static') {
      if (!staticPreview) {
        throw new Error(`Static project "${projectId}" is missing static preview "${entryFile}"`);
      }

      return [
        {
          id: projectId,
          name: metadata.name ?? metadata.title,
          kernel: 'Static',
          mode,
          mainFile,
          language: languageFromMetadata(metadata, mainFile),
          description: metadata.description,
          exportFormats: [],
          staticPreview,
          code: '',
          sourceFiles: {},
        },
      ];
    }

    if (!code) {
      throw new Error(`Project "${projectId}" is missing source for entry "${entryFile}"`);
    }

    return [
      {
        id: projectId,
        name: metadata.name ?? metadata.title,
        kernel: kernelFromMetadata(metadata),
        mode,
        mainFile,
        language: languageFromMetadata(metadata, mainFile),
        description: metadata.description,
        exportFormats: metadata.exportFormats ?? exportFormatsFromMetadata(metadata),
        ...(metadata.initialParameters ? { initialParameters: metadata.initialParameters } : {}),
        ...(presets ? { presets } : {}),
        ...(staticPreview ? { staticPreview } : {}),
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

function staticPreviewForProject(
  projectId: string,
  metadata: ProjectMetadata,
): PlaygroundExample['staticPreview'] | undefined {
  const glbPath =
    metadata.staticPreview?.glb ?? metadata.previewGlb ?? (metadata.type === 'static' ? metadata.entry : undefined);
  if (!glbPath) {
    return undefined;
  }

  const previewPath = glbPath.startsWith('./') ? glbPath : `./projects/${projectId}/${glbPath}`;
  const glb = projectStaticPreviewGlbByPath[previewPath];
  if (!glb) {
    throw new Error(`Project "${projectId}" references missing static preview GLB "${glbPath}"`);
  }

  return { glb };
}

function modeFromMetadata(metadata: ProjectMetadata): NonNullable<PlaygroundExample['mode']> {
  return metadata.type === 'static' ? 'static' : 'editable';
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

  if (mainFile.endsWith('.glb') || mainFile.endsWith('.gltf')) {
    return 'gltf';
  }

  if (mainFile.endsWith('.ts') || mainFile.endsWith('.js')) {
    return 'typescript';
  }

  return 'scad';
}

function exportFormatsFromMetadata(metadata: ProjectMetadata): readonly FileExtension[] {
  return kernelFromMetadata(metadata) === 'OpenSCAD' ? meshExportFormats : solidExportFormats;
}
