import type { JSONSchema7 } from '@taucad/json-schema';
import type { ParameterManifest } from '@taucad/parameters';
import type { Artifact, KernelIssue } from '@taucad/runtime/types';

/** Runtime IDs; OpenRSCAD implements the gallery's OpenSCAD variants. */
export type GalleryKernel = 'openrscad' | 'opencascade' | 'replicad';

export type GalleryExportFormat = 'glb' | 'stl' | '3mf' | 'obj' | 'step';

export type GalleryRenderOptions = Readonly<{
  tessellation?:
    | 'low'
    | 'medium'
    | 'high'
    | 'extra-high'
    | Readonly<{ linearTolerance?: number; angularTolerance?: number; segments?: number }>;
  includeEdges?: boolean;
}>;

export type GallerySessionInput = Readonly<{
  kernel: GalleryKernel;
  entryPath: string;
  files: Readonly<Record<string, string | Uint8Array<ArrayBuffer>>>;
  parameters?: Readonly<Record<string, unknown>>;
  renderOptions?: GalleryRenderOptions;
  /** Browser worker deadline, in milliseconds. Headless verification enforces its deadline in a parent process. */
  operationTimeout?: number;
}>;

export type GallerySessionOptions = Readonly<{
  /** Cancelling this signal releases the document and its worker. */
  signal?: AbortSignal;
  onProgress?: (progress: { phase: string; detail?: Record<string, unknown> }) => void;
}>;

export type GalleryOperationOptions = Readonly<{ signal?: AbortSignal }>;

export type GalleryStaticOptions = GalleryOperationOptions &
  Readonly<{
    /** Authored preview axes; legacy gallery GLBs use Z-up metres. */
    coordinateSystem?: 'y-up' | 'z-up';
  }>;

export type GalleryRenderResult = Readonly<{
  artifact: Artifact;
  artifactHash: string;
  jsonSchema: JSONSchema7 | undefined;
  parameterManifest: ParameterManifest | undefined;
  defaultParameters: Record<string, unknown>;
  parameters: Record<string, unknown>;
  formats: readonly GalleryExportFormat[];
  issues: readonly KernelIssue[];
}>;

export type GalleryExportFile = Readonly<{
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}>;

/** One immutable source revision, with a reusable document for parameter changes. */
export type GallerySession = Readonly<{
  /** Replace overrides over model defaults; omit parameters to reuse the current values. */
  render(
    parameters?: Readonly<Record<string, unknown>>,
    options?: GalleryOperationOptions,
  ): Promise<GalleryRenderResult>;
  /** Export the most recently requested successful evaluation. */
  export(format: GalleryExportFormat, options?: GalleryOperationOptions): Promise<readonly GalleryExportFile[]>;
  /** Close the document and release its kernel, worker, and cached geometry. Safe to repeat. */
  dispose(): Promise<void>;
}>;
