import assert from 'node:assert/strict';
import { z } from 'zod';
import type { GalleryExportFile, GalleryExportFormat } from '#runtime/types.js';
import { assertBoundsParity, measureGlb } from '#scripts/measure-glb.js';
import type { GeometrySummary } from '#scripts/measure-glb.js';
import { measureStlFiles } from '#scripts/measure-stl.js';
import {
  validateWavefrontStructure,
  validateStepStructure,
  validateThreeMfStructure,
} from '#scripts/export-structure.js';

const pointSchema = z.tuple([z.number(), z.number(), z.number()]);
export const exportValidationSchema = z.object({
  level: z.enum(['geometry', 'structure']),
  checks: z.array(z.string()),
  counts: z.record(z.string(), z.number().nonnegative()),
  sourceCoordinateSystem: z.enum(['y-up', 'z-up']).optional(),
  sourceUnit: z.enum(['m', 'mm']).optional(),
  boundsCoordinateSystem: z.literal('y-up').optional(),
  boundsMm: z.object({ min: pointSchema, max: pointSchema, size: pointSchema }).optional(),
});
export type ExportValidation = z.infer<typeof exportValidationSchema>;

const validateStructure = (files: readonly GalleryExportFile[], format: '3mf' | 'step' | 'obj'): ExportValidation => {
  const selected = files.filter(
    (file) =>
      file.name.toLowerCase().endsWith(`.${format}`) || (format === 'step' && file.name.toLowerCase().endsWith('.stp')),
  );
  assert.ok(selected.length > 0, `${format} export has no primary geometry file`);
  const counts: Record<string, number> = { files: selected.length };
  const checks = {
    '3mf': [
      'ZIP package manifests',
      'well-formed model XML',
      'finite vertices',
      'triangle indices',
      'build references reach mesh geometry without cycles',
    ],
    step: [
      'STEP physical-file markers',
      'header/schema/data sections',
      'unique entity IDs',
      'geometric surface entities',
    ],
    obj: ['finite vertex records', 'nonempty face records', 'positive and negative face indices'],
  } as const;
  for (const file of selected) {
    const result =
      format === '3mf'
        ? validateThreeMfStructure(file.bytes)
        : format === 'step'
          ? validateStepStructure(file.bytes)
          : validateWavefrontStructure(file.bytes);
    for (const [name, count] of Object.entries(result)) {
      counts[name] = (counts[name] ?? 0) + count;
    }
  }
  return { level: 'structure', checks: [...checks[format]], counts };
};

/** Check exported data at its actual strength: decoded geometry for GLB/STL, structure for other containers. */
export const validateExportArtifact = async (input: {
  readonly format: GalleryExportFormat;
  readonly files: readonly GalleryExportFile[];
  readonly reference: Pick<GeometrySummary, 'boundsMm'>;
}): Promise<ExportValidation> => {
  if (input.format === 'stl') {
    const measured = await measureStlFiles(input.files);
    assertBoundsParity(input.reference, measured);
    return {
      level: 'geometry',
      checks: [
        'binary/ASCII STL decoding',
        'complete triangles',
        'nonempty triangle surfaces',
        'finite vertices',
        'aggregate part bounds',
        'Z-up/mm (x,y,z) → Y-up/mm (x,z,-y)',
      ],
      counts: { files: measured.files, triangles: measured.triangles },
      sourceCoordinateSystem: 'z-up',
      sourceUnit: 'mm',
      boundsCoordinateSystem: 'y-up',
      boundsMm: { min: [...measured.boundsMm.min], max: [...measured.boundsMm.max], size: [...measured.boundsMm.size] },
    };
  }
  if (input.format === 'glb') {
    const files = input.files.filter((file) => file.mimeType === 'model/gltf-binary' || file.name.endsWith('.glb'));
    assert.equal(files.length, 1, 'GLB export must contain one complete scene');
    const file = files[0];
    assert.ok(file);
    const measured = await measureGlb(new Uint8Array(file.bytes));
    assertBoundsParity(input.reference, measured);
    return {
      level: 'geometry',
      checks: ['GLB scene decoding', 'finite transformed triangle vertices', 'scene bounds'],
      counts: { files: files.length, triangles: measured.triangles, meshInstances: measured.meshInstances },
      sourceCoordinateSystem: 'y-up',
      sourceUnit: 'm',
      boundsCoordinateSystem: 'y-up',
      boundsMm: { min: [...measured.boundsMm.min], max: [...measured.boundsMm.max], size: [...measured.boundsMm.size] },
    };
  }
  return validateStructure(input.files, input.format);
};
