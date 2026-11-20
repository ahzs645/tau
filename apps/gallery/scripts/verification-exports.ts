/* oxlint-disable no-await-in-loop -- One live document serializes native exports and artifact writes. */
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { GalleryExportFile, GalleryExportFormat, GallerySession } from '#runtime/types.js';
import type { GeometrySummary } from '#scripts/measure-glb.js';
import { exportValidationSchema, validateExportArtifact } from '#scripts/verification-artifacts.js';

export const exportEvidenceSchema = z.object({
  format: z.string(),
  files: z.array(z.string()),
  artifacts: z.array(z.string()),
  fileSizes: z.array(z.object({ name: z.string(), byteLength: z.number().int().nonnegative() })).optional(),
  error: z.string().optional(),
  validation: exportValidationSchema.optional(),
});
export type ExportEvidence = z.infer<typeof exportEvidenceSchema>;

type ExportVerificationInput = {
  readonly session: Pick<GallerySession, 'export'>;
  readonly geometry: GeometrySummary;
  readonly formats: readonly GalleryExportFormat[];
  readonly onStart?: (format: GalleryExportFormat) => void;
  readonly onValidationStart?: (format: GalleryExportFormat) => void;
  readonly saveFile?: (input: {
    readonly format: GalleryExportFormat;
    readonly file: GalleryExportFile;
    readonly index: number;
  }) => Promise<string | undefined>;
};

const verifyFormat = async (input: ExportVerificationInput, format: GalleryExportFormat): Promise<ExportEvidence> => {
  const evidence: ExportEvidence = { format, files: [], artifacts: [], fileSizes: [] };
  try {
    input.onStart?.(format);
    const files = await input.session.export(format);
    evidence.files = files.map((file) => file.name);
    evidence.fileSizes = files.map(({ name, bytes }) => ({ name, byteLength: bytes.byteLength }));
    // Retain diagnostic bytes before validation, including malformed exports.
    for (const [index, file] of files.entries()) {
      const filename = await input.saveFile?.({ format, file, index });
      if (filename) {
        evidence.artifacts.push(filename);
      }
    }
    assert.ok(files.length > 0, `${format} returned no files`);
    for (const file of files) {
      assert.ok(file.bytes.byteLength > 0, `Exported ${file.name} is empty`);
    }
    input.onValidationStart?.(format);
    evidence.validation = await validateExportArtifact({ format, files, reference: input.geometry });
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
  }
  return evidence;
};

/** Keep every strict format result even when an earlier export fails. */
export const verifyGalleryExports = async (input: ExportVerificationInput): Promise<ExportEvidence[]> => {
  const evidence: ExportEvidence[] = [];
  for (const format of input.formats) {
    evidence.push(await verifyFormat(input, format));
  }
  return evidence;
};
/* oxlint-enable no-await-in-loop */
