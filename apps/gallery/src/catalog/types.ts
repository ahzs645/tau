/** Kernels selected by this gallery; public variant IDs retain the old URLs. */
export type GalleryKernel = 'openrscad' | 'opencascade' | 'replicad';

export type GalleryVariantId = 'openscad' | 'opencascade' | 'replicad';

export type GalleryExportFormat = 'glb' | 'stl' | '3mf' | 'obj' | 'step';

export type GalleryFiles = Record<string, Uint8Array<ArrayBuffer>>;

export type GalleryRenderOptions = {
  readonly tessellation?: { readonly linearTolerance: number; readonly angularTolerance: number };
  readonly includeEdges?: boolean;
};

export type GalleryVariant = {
  readonly id: GalleryVariantId;
  readonly label: string;
  readonly shortLabel: string;
  readonly entry: string;
  readonly kernel: GalleryKernel;
  readonly language: 'scad' | 'typescript' | 'javascript';
  readonly exportFormats: readonly GalleryExportFormat[];
  readonly renderTimeout?: number;
  readonly renderOptions?: GalleryRenderOptions;
  readonly showPreviewLines?: boolean;
  readonly notes?: string;
};

export type GalleryPreset = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly parameters: Record<string, unknown>;
  /** Presets are authored against one schema and never migrate across kernels. */
  readonly variantIds: readonly GalleryVariantId[];
};

export type GalleryUpload = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly accept: string;
  readonly filePath: string;
  readonly parameter?: string;
  readonly maxBytes?: number;
};

export type GalleryComponents = {
  readonly parameter: string;
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly variantIds: readonly GalleryVariantId[];
};

export type GalleryProject = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category?: string;
  readonly tags: readonly string[];
  readonly author?: string;
  readonly sourceUrl: string;
  readonly license?: string;
  readonly imageUrl?: string;
  readonly mode: 'parametric' | 'static';
  readonly hidden: boolean;
  readonly defaultVariantId: GalleryVariantId | 'static';
  readonly variants: readonly GalleryVariant[];
  readonly initialParameters: Record<string, unknown>;
  readonly presets: readonly GalleryPreset[];
  readonly uploads: readonly GalleryUpload[];
  readonly components?: GalleryComponents;
  readonly staticPreviewUrl?: string;
  readonly staticPreviewFile?: string;
  /** Authored preview axes, normalized to canonical glTF before viewing or AR. */
  readonly staticPreviewCoordinateSystem?: 'y-up' | 'z-up';
  /** Files relative to the project folder, including binary inputs and attribution. */
  readonly filePaths: readonly string[];
  readonly libraries: readonly string[];
  /** Intentional modelling differences are recorded separately from failed parity. */
  readonly parityExclusions: Readonly<Partial<Record<GalleryVariantId, string>>>;
};
