// @vitest-environment node
/* eslint-disable @typescript-eslint/naming-convention -- filenames and OpenSCAD customizer keys match the model */
/* oxlint-disable no-await-in-loop -- each export uses the same WASM runtime in sequence */
import { expect, it } from 'vitest';
import { openscad } from '@taucad/openscad';
import { createNodeClient } from '@taucad/runtime/node';
import { converterTranscoder } from '@taucad/runtime/transcoder';
import { analyzeGlb } from '@taucad/testing/geometry';
import { loadProjectExample } from '#routes/playground/projects.js';

// Expected outside widths in millimetres. A centered 6 mm gap with 1.5 mm
// clearance per side gives a 3 mm divider and an 86 mm center spacing.
const fits = [
  { parameters: {}, widths: [300.6, 400, 400, 101.8] },
  { parameters: { bottle_diameter: 80, side_clearance: 1.5, bottle_gap: 6 }, widths: [261, 347, 347, 89] },
];

it.each(fits)('exports every bottle separator preset at fit $parameters', { timeout: 120_000 }, async (fit) => {
  const project = await loadProjectExample('bottle-separator');
  if (!project?.presets) {
    throw new Error('Bottle Separator must include arrangement presets');
  }

  const client = await createNodeClient(undefined, { kernels: [openscad()], transcoders: [converterTranscoder()] });
  const code = { 'main.scad': project.code };
  try {
    expect(project.presets).toHaveLength(4);
    for (const [index, preset] of project.presets.entries()) {
      const parameters = { ...preset.parameters, 'Bottle fit': fit.parameters };
      for (const format of project.exportFormats) {
        const result = await client.export(format, { code, parameters });
        if (!result.success) {
          throw new Error(`${preset.name} (${format}): ${result.issues.map((issue) => issue.message).join(', ')}`);
        }

        expect(result.data.bytes.byteLength).toBeGreaterThan(0);
        if (format === 'glb') {
          const geometry = await analyzeGlb(result.data.bytes);
          expect(geometry.watertight).toBe(true);
          expect(geometry.connectedComponents(0.001)).toBe(1);
          expect(geometry.boundingBox!.size[0] * 1000).toBeCloseTo(fit.widths[index]!, 2);
        }
      }
    }
  } finally {
    client.terminate();
  }
});

it('rejects a gap too narrow for the requested side clearance', async () => {
  const project = (await loadProjectExample('bottle-separator'))!;
  const code = { 'main.scad': project.code };
  const client = await createNodeClient(undefined, { kernels: [openscad()] });
  try {
    const invalid = await client.export('glb', { code, parameters: { bottle_gap: 2, side_clearance: 1.5 } });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.issues.map((issue) => issue.message).join(' ')).toContain('Bottle gap must be at least 4');
    }
  } finally {
    client.terminate();
  }
});

it('sizes modular parts for the usable bed and exposes a two-piece fit test', { timeout: 120_000 }, async () => {
  const project = (await loadProjectExample('bottle-separator'))!;
  const code = { 'main.scad': project.code };
  const client = await createNodeClient(undefined, { kernels: [openscad()] });
  try {
    const cases = [
      { layout: 'Honeycomb', part: 'Print one cell', bed: [180, 180], size: [103, 115.05, 65], pieces: 1 },
      { layout: 'Honeycomb', part: 'Print one cell', bed: [120, 105], size: [115.05, 103, 65], pieces: 1 },
      { layout: 'Inline', part: 'Print one cell', bed: [110, 110], size: [103, 103, 65], pieces: 1 },
      { layout: 'Honeycomb', part: 'Joint test pair', bed: [100, 100], size: [5.05, 22.8, 12], pieces: 2 },
    ];
    for (const { layout, part, bed, size, pieces } of cases) {
      const result = await client.export('glb', {
        code,
        parameters: { layout, output_part: part, bed_width: bed[0], bed_depth: bed[1] },
      });
      if (!result.success) {
        throw new Error(result.issues.map((issue) => issue.message).join(', '));
      }

      const geometry = await analyzeGlb(result.data.bytes);
      expect(geometry.watertight).toBe(true);
      expect(geometry.connectedComponents(0.001)).toBe(pieces);
      for (const [axis, length] of size.entries()) {
        expect(Math.abs(geometry.boundingBox!.size[axis]! * 1000 - length)).toBeLessThan(0.02);
      }
    }

    const tooSmall = await client.export('glb', { code, parameters: { output_part: 'Print one cell', bed_width: 100 } });
    expect(tooSmall.success).toBe(false);
    if (!tooSmall.success) {
      expect(tooSmall.issues.map((issue) => issue.message).join(' ')).toContain('Usable bed');
    }
  } finally {
    client.terminate();
  }
});
