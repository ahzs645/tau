import type { FileExtension } from '@taucad/types';
import { replicadExampleCode } from '@taucad/tau-examples';
import { z } from 'zod';
import type { PlaygroundExample, PlaygroundVariant } from '#routes/playground/playground-examples.js';

const meshExportFormats = ['glb', 'stl', '3mf', 'obj'] as const;
const solidExportFormats = ['glb', 'stl', '3mf', 'step'] as const;
const exportFormats = ['glb', 'stl', '3mf', 'obj', 'step'] as const satisfies readonly FileExtension[];

const variantKernels = {
  openscad: 'OpenSCAD',
  replicad: 'Replicad',
  opencascade: 'OpenCascade',
} as const satisfies Record<string, PlaygroundExample['kernel']>;

const variantLabels = {
  openscad: 'OpenSCAD',
  replicad: 'Replicad',
  opencascade: 'OpenCASCADE',
} as const;

const projectVariantSchema = z.object({
  id: z.enum(['openscad', 'replicad', 'opencascade']),
  label: z.string().min(1).optional(),
  entry: z.string().min(1),
  language: z.string().min(1).optional(),
  exportFormats: z.array(z.enum(exportFormats)).optional(),
  renderTimeout: z.number().int().positive().optional(),
  showPreviewLines: z.boolean().optional(),
});

export const projectMetadataSchema = z.looseObject({
  title: z.string().min(1),
  entry: z.string().min(1),
  // Alternate implementations of the same model (e.g. an OpenSCAD original and
  // a hand-ported OpenCASCADE version). The variant whose entry matches the
  // project `entry` is the default shown when the project loads.
  variants: z.array(projectVariantSchema).min(1).optional(),
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
  category: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  author: z.string().min(1).optional(),
  // Optional gallery card thumbnail, relative to the project folder (e.g. "poster.webp").
  image: z.string().min(1).optional(),
  hidden: z.boolean().optional(),
  exportFormats: z.array(z.enum(exportFormats)).optional(),
  renderTimeout: z.number().int().positive().optional(),
  showPreviewLines: z.boolean().optional(),
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

const projectImageByPath = import.meta.glob<string>('./projects/**/*.{avif,jpeg,jpg,png,webp}', {
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
    const variants = variantsForProject(projectId, metadata, sourceFiles);
    const staticPreview = staticPreviewForProject(projectId, metadata);
    const image = imageForProject(projectId, metadata);
    const mode = modeFromMetadata(metadata);
    const galleryMetadata = galleryMetadataFor(metadata, image);

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
          ...galleryMetadata,
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
        ...(metadata.renderTimeout ? { renderTimeout: metadata.renderTimeout } : {}),
        ...(typeof metadata.showPreviewLines === 'boolean' ? { showPreviewLines: metadata.showPreviewLines } : {}),
        ...(variants ? { variants } : {}),
        ...(metadata.initialParameters ? { initialParameters: metadata.initialParameters } : {}),
        ...(presets ? { presets } : {}),
        ...(staticPreview ? { staticPreview } : {}),
        ...galleryMetadata,
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

function imageForProject(projectId: string, metadata: ProjectMetadata): string | undefined {
  if (!metadata.image) {
    return undefined;
  }

  const imagePath = metadata.image.startsWith('./') ? metadata.image : `./projects/${projectId}/${metadata.image}`;
  const image = projectImageByPath[imagePath];
  if (!image) {
    throw new Error(`Project "${projectId}" references missing gallery image "${metadata.image}"`);
  }

  return image;
}

function modeFromMetadata(metadata: ProjectMetadata): NonNullable<PlaygroundExample['mode']> {
  return metadata.type === 'static' ? 'static' : 'editable';
}

function galleryMetadataFor(
  metadata: ProjectMetadata,
  image: string | undefined,
): Partial<Pick<PlaygroundExample, 'category' | 'tags' | 'author' | 'image'>> {
  return {
    ...(metadata.category ? { category: metadata.category } : {}),
    ...(metadata.tags && metadata.tags.length > 0 ? { tags: metadata.tags } : {}),
    ...(metadata.author ? { author: metadata.author } : {}),
    ...(image ? { image } : {}),
  };
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

  return languageForEntry(mainFile);
}

function languageForEntry(entry: string): string {
  if (entry.endsWith('.glb') || entry.endsWith('.gltf')) {
    return 'gltf';
  }

  if (entry.endsWith('.ts') || entry.endsWith('.js')) {
    return 'typescript';
  }

  return 'scad';
}

function exportFormatsFromMetadata(metadata: ProjectMetadata): readonly FileExtension[] {
  return kernelFromMetadata(metadata) === 'OpenSCAD' ? meshExportFormats : solidExportFormats;
}

function variantsForProject(
  projectId: string,
  metadata: ProjectMetadata,
  sourceFiles: Record<string, string>,
): readonly PlaygroundVariant[] | undefined {
  if (!metadata.variants || metadata.variants.length === 0) {
    return undefined;
  }

  const variants = metadata.variants.map((variant): PlaygroundVariant => {
    if (!sourceFiles[variant.entry]) {
      throw new Error(`Project "${projectId}" variant "${variant.id}" is missing source for entry "${variant.entry}"`);
    }

    const kernel = variantKernels[variant.id];
    return {
      id: variant.id,
      label: variant.label ?? variantLabels[variant.id],
      kernel,
      mainFile: variant.entry,
      language: variant.language ?? languageForEntry(variant.entry),
      exportFormats: variant.exportFormats ?? (kernel === 'OpenSCAD' ? meshExportFormats : solidExportFormats),
      ...(variant.renderTimeout ? { renderTimeout: variant.renderTimeout } : {}),
      ...(typeof variant.showPreviewLines === 'boolean' ? { showPreviewLines: variant.showPreviewLines } : {}),
      isDefault: variant.entry === metadata.entry,
    };
  });

  if (!variants.some((variant) => variant.isDefault)) {
    throw new Error(`Project "${projectId}" variants must include one whose entry matches "${metadata.entry}"`);
  }

  return variants;
}
