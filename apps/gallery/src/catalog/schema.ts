import { z } from 'zod';
import type {
  GalleryExportFormat,
  GalleryKernel,
  GalleryProject,
  GalleryRenderOptions,
  GalleryVariant,
  GalleryVariantId,
} from '#catalog/types.js';

const variantIdSchema = z.enum(['openscad', 'opencascade', 'replicad']);
const exportFormatSchema = z.enum(['glb', 'stl', '3mf', 'obj', 'step']);
const parameterRecordSchema = z.record(z.string(), z.unknown());
const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.split('/').some((part) => part === '..' || part === '.' || part === ''),
    'Expected a relative project path without parent traversal',
  );
const previewSchema = {
  renderTimeout: z.number().int().positive().optional(),
  showPreviewLines: z.boolean().optional(),
  previewNativeEdges: z.boolean().optional(),
  previewTessellation: z
    .object({
      linearTolerance: z.number().positive(),
      angularTolerance: z.number().positive(),
    })
    .optional(),
};
const variantSchema = z.object({
  id: variantIdSchema,
  entry: relativePathSchema,
  label: z.string().min(1).optional(),
  shortLabel: z.string().min(1).optional(),
  language: z.string().optional(),
  exportFormats: z.array(exportFormatSchema).optional(),
  notes: z.string().optional(),
  ...previewSchema,
});
const metadataSchema = z.looseObject({
  title: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string(),
  entry: relativePathSchema,
  mainFile: relativePathSchema.optional(),
  type: z.enum(['scad', 'static']).optional(),
  kernel: z.enum(['OpenSCAD', 'OpenCascade', 'Replicad', 'Static']).optional(),
  engine: z.enum(['openscad', 'openrscad', 'replicad', 'opencascade', 'occt']).optional(),
  variants: z.array(variantSchema).min(1).optional(),
  exportFormats: z.array(exportFormatSchema).optional(),
  initialParameters: parameterRecordSchema.optional(),
  image: relativePathSchema.optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  author: z.string().optional(),
  sourceUrl: z.url().optional(),
  license: z.string().optional(),
  hidden: z.boolean().optional(),
  libraries: z.array(z.literal('BOSL2')).optional(),
  previewGlb: relativePathSchema.optional(),
  staticPreview: z.object({ glb: relativePathSchema }).optional(),
  staticPreviewCoordinateSystem: z.enum(['y-up', 'z-up']).optional(),
  uploads: z
    .array(
      z.object({
        fileName: relativePathSchema,
        label: z.string().min(1),
        accept: z.string().min(1),
        parameter: z.string().optional(),
        description: z.string().optional(),
        maxBytes: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  components: z
    .object({
      parameter: z.string().min(1),
      label: z.string().min(1),
      options: z.array(z.object({ value: z.string(), label: z.string() })).min(2),
      variantIds: z.array(variantIdSchema).optional(),
    })
    .optional(),
  parityExclusions: z.partialRecord(variantIdSchema, z.string().min(1)).optional(),
  ...previewSchema,
});
const presetsSchema = z.array(
  z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: parameterRecordSchema,
  }),
);

type Metadata = z.infer<typeof metadataSchema>;
type Preview = Pick<Metadata, 'renderTimeout' | 'showPreviewLines' | 'previewNativeEdges' | 'previewTessellation'>;
type ProjectDefinitionInput = {
  readonly id: string;
  readonly collection: 'projects' | 'curated';
  readonly metadata: unknown;
  readonly presets?: unknown;
  readonly filePaths: readonly string[];
  readonly resourceUrl: (path: string) => string;
};

const labels = { openscad: 'OpenSCAD', opencascade: 'OpenCASCADE', replicad: 'Replicad' } as const;
const shortLabels = { openscad: 'SCAD', opencascade: 'OCCT', replicad: 'Replicad' } as const;
const kernels = { openscad: 'openrscad', opencascade: 'opencascade', replicad: 'replicad' } as const satisfies Record<
  GalleryVariantId,
  GalleryKernel
>;
const meshFormats = ['glb', 'stl', '3mf', 'obj'] as const satisfies readonly GalleryExportFormat[];
const solidFormats = ['glb', 'stl', '3mf', 'step'] as const satisfies readonly GalleryExportFormat[];
const originalCommit = '996774cc25a147c085fbdcc47a4a89cc0dfe701f';

const inferredVariantId = (metadata: Metadata): GalleryVariantId => {
  if (
    metadata.kernel === 'OpenCascade' ||
    metadata.engine === 'opencascade' ||
    metadata.engine === 'occt' ||
    metadata.entry.endsWith('.occt.ts')
  ) {
    return 'opencascade';
  }
  if (
    metadata.kernel === 'Replicad' ||
    metadata.engine === 'replicad' ||
    metadata.entry.endsWith('.ts') ||
    metadata.entry.endsWith('.js')
  ) {
    return 'replicad';
  }
  return 'openscad';
};

const renderOptions = (preview: Preview): GalleryRenderOptions | undefined => {
  if (!preview.previewTessellation && preview.previewNativeEdges === undefined) {
    return undefined;
  }
  return {
    ...(preview.previewTessellation ? { tessellation: preview.previewTessellation } : {}),
    ...(preview.previewNativeEdges === undefined ? {} : { includeEdges: preview.previewNativeEdges }),
  };
};

const presentationFor = (
  metadata: Metadata,
  context: {
    readonly input: ProjectDefinitionInput;
    readonly mode: GalleryProject['mode'];
    readonly requireFile: (path: string) => string;
  },
): Pick<
  GalleryProject,
  | 'title'
  | 'sourceUrl'
  | 'tags'
  | 'category'
  | 'author'
  | 'license'
  | 'imageUrl'
  | 'staticPreviewUrl'
  | 'staticPreviewFile'
  | 'staticPreviewCoordinateSystem'
> => {
  const { input, mode, requireFile } = context;
  const previewFile =
    metadata.staticPreview?.glb ?? metadata.previewGlb ?? (mode === 'static' ? metadata.entry : undefined);
  const sourceUrl =
    metadata.sourceUrl ??
    (input.collection === 'curated'
      ? `https://github.com/ahzs645/tau/blob/${originalCommit}/apps/ui/app/routes/playground/playground-examples.ts`
      : `https://github.com/ahzs645/tau/tree/${originalCommit}/apps/ui/app/routes/playground/projects/${input.id}`);
  return {
    title: metadata.name ?? metadata.title,
    sourceUrl,
    tags: metadata.tags ?? [],
    ...(metadata.category ? { category: metadata.category } : {}),
    ...(metadata.author ? { author: metadata.author } : {}),
    ...(metadata.license ? { license: metadata.license } : {}),
    ...(metadata.image ? { imageUrl: requireFile(metadata.image) } : {}),
    ...(previewFile
      ? {
          staticPreviewUrl: requireFile(previewFile),
          staticPreviewFile: previewFile,
          staticPreviewCoordinateSystem: metadata.staticPreviewCoordinateSystem ?? 'y-up',
        }
      : {}),
  };
};

const presetsFor = (input: unknown, id: string, variantIds: GalleryVariantId[]): GalleryProject['presets'] => {
  const parsed = presetsSchema.safeParse(input ?? []);
  if (!parsed.success) {
    throw new Error(`Invalid gallery presets ${id}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data.map((preset, index) => ({ id: `preset-${index + 1}`, ...preset, variantIds }));
};

/** Validate author-owned metadata and derive a host-independent catalogue entry. */
export const parseProjectDefinition = (input: ProjectDefinitionInput): GalleryProject => {
  const parsed = metadataSchema.safeParse(input.metadata);
  if (!parsed.success) {
    throw new Error(`Invalid gallery project ${input.id}: ${z.prettifyError(parsed.error)}`);
  }
  const metadata = parsed.data;
  const knownPaths = new Set(input.filePaths);
  const requireFile = (path: string): string => {
    if (!knownPaths.has(path)) {
      throw new Error(`Gallery project ${input.id} is missing ${path}`);
    }
    return input.resourceUrl(path);
  };
  requireFile(metadata.entry);
  const mode = metadata.type === 'static' || metadata.kernel === 'Static' ? 'static' : 'parametric';
  const defaultVariantId =
    mode === 'static'
      ? 'static'
      : (metadata.variants?.find((variant) => variant.entry === metadata.entry)?.id ?? inferredVariantId(metadata));
  if (metadata.variants && !metadata.variants.some((variant) => variant.entry === metadata.entry)) {
    throw new Error(`Gallery project ${input.id} must declare its default entry in variants`);
  }
  const variantIds = new Set<string>();
  const variantDefinitions: Array<z.infer<typeof variantSchema>> = metadata.variants ?? [
    { id: inferredVariantId(metadata), entry: metadata.entry },
  ];
  const variants: GalleryVariant[] =
    mode === 'static'
      ? []
      : variantDefinitions.map((variant) => {
          if (variantIds.has(variant.id)) {
            throw new Error(`Gallery project ${input.id} repeats variant ${variant.id}`);
          }
          variantIds.add(variant.id);
          requireFile(variant.entry);
          const isDefault = variant.id === defaultVariantId;
          const preview = isDefault ? { ...metadata, ...variant } : variant;
          const options = renderOptions(preview);
          const formats =
            variant.exportFormats ??
            (isDefault ? metadata.exportFormats : undefined) ??
            (variant.id === 'openscad' ? meshFormats : solidFormats);
          return {
            id: variant.id,
            label: variant.label ?? labels[variant.id],
            shortLabel: variant.shortLabel ?? shortLabels[variant.id],
            entry: variant.entry,
            kernel: kernels[variant.id],
            language: variant.entry.endsWith('.scad')
              ? 'scad'
              : variant.entry.endsWith('.js')
                ? 'javascript'
                : 'typescript',
            exportFormats: formats,
            ...(preview.renderTimeout ? { renderTimeout: preview.renderTimeout } : {}),
            ...(preview.showPreviewLines === undefined ? {} : { showPreviewLines: preview.showPreviewLines }),
            ...(options ? { renderOptions: options } : {}),
            ...(variant.notes ? { notes: variant.notes } : {}),
          };
        });
  const defaultIds: GalleryVariantId[] = defaultVariantId === 'static' ? [] : [defaultVariantId];
  return {
    id: input.id,
    description: metadata.description,
    mode,
    hidden: metadata.hidden ?? false,
    ...presentationFor(metadata, { input, mode, requireFile }),
    defaultVariantId,
    variants,
    initialParameters: metadata.initialParameters ?? {},
    presets: presetsFor(input.presets, input.id, defaultIds),
    uploads: (metadata.uploads ?? []).map(({ fileName, ...upload }) => ({
      id: fileName,
      filePath: fileName,
      ...upload,
    })),
    ...(metadata.components
      ? { components: { ...metadata.components, variantIds: metadata.components.variantIds ?? defaultIds } }
      : {}),
    filePaths: [...knownPaths].sort(),
    libraries: metadata.libraries ?? [],
    parityExclusions: metadata.parityExclusions ?? {},
  };
};

/** Runtime inputs include text and binary model dependencies, excluding display posters. */
export const isModelInput = (path: string): boolean =>
  /\.(?:[cm]?js|tsx?|scad|json|svg|dxf|txt|stl|3mf|obj|off|amf|dat|csv|ttf|otf|woff2?)$/iu.test(path);

/** Libraries are explicit model dependencies, not implicit global kernel state. */
export const readDeclaredLibraries = (metadata: unknown): readonly string[] =>
  z.object({ libraries: z.array(z.literal('BOSL2')).optional() }).parse(metadata).libraries ?? [];
