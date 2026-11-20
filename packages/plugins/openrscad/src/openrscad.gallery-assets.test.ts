import { describe, expect, it } from 'vitest';
import { createNodeClient } from '@taucad/runtime/node';
import { defineRuntime } from '@taucad/runtime/worker';
import type { ViewSubscription } from '@taucad/runtime/client';
import { getSignedVolumeFromGlb } from '@taucad/runtime-testing';
import { openrscad } from '@taucad/openrscad';

const runtime = defineRuntime({ plugins: [openrscad()] });
const svg = (width: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="10mm" viewBox="0 0 ${width} 10"><path d="M0 0 H${width} V10 H0 Z"/></svg>`;

const renderBytes = async (view: Pick<ViewSubscription, 'rendering'>): Promise<Uint8Array<ArrayBuffer>> => {
  const outcome = await view.rendering();
  if (outcome.superseded || !outcome.rendering.success) {
    throw new Error(
      outcome.superseded ? 'Render superseded' : outcome.rendering.issues.map(({ message }) => message).join('; '),
    );
  }
  const { artifact } = outcome.rendering;
  if (artifact.mimeType !== 'model/gltf-binary' || typeof artifact.content === 'string') {
    throw new Error('Expected a binary glTF preview.');
  }
  return artifact.content;
};

describe('OpenRSCAD gallery assets and parameters', { timeout: 60_000 }, () => {
  it('should admit boolean dropdowns and apply their values to geometry', async () => {
    const client = await createNodeClient({ runtime });
    const source = {
      entry: 'main.scad',
      files: {
        'main.scad': `/* [Features] */
enabled = true; // [true,false]
required = true; // [true:Required]
cube(enabled ? 2 : 1);`,
      },
    } as const;
    try {
      const description = await client.describe({ source });
      if (!description.success) {
        throw new Error(description.issues.map(({ message }) => message).join('; '));
      }
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Customizer group names are preserved external parameter keys.
      expect(description.parameters.defaults).toEqual({ Features: { enabled: true, required: true } });
      expect(description.parameters.legacyProjection).toMatchObject({
        status: 'usable',
        schema: {
          properties: {
            // eslint-disable-next-line @typescript-eslint/naming-convention -- The authored Customizer group is part of the public schema.
            Features: {
              properties: {
                enabled: { type: 'boolean', oneOf: [{ const: true }, { const: false }] },
                required: { type: 'boolean', oneOf: [{ const: true, title: 'Required' }] },
              },
            },
          },
        },
      });
      const document = client.open({ source, watch: false });
      const evaluation = await document.evaluation();
      if (evaluation.superseded || !evaluation.evaluation.success) {
        throw new Error(
          evaluation.superseded
            ? 'Evaluation superseded'
            : evaluation.evaluation.issues.map(({ message }) => message).join('; '),
        );
      }
      const view = document.view('model');
      const initialVolume = Math.abs(await getSignedVolumeFromGlb(await renderBytes(view)));
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Updates must use the unchanged authored Customizer group.
      await document.update({ parameters: { Features: { enabled: false, required: true } } });
      const disabledVolume = Math.abs(await getSignedVolumeFromGlb(await renderBytes(view)));
      expect(disabledVolume / initialVolume).toBeCloseTo(1 / 8, 4);
      document.close();
      await expect(
        client.describe({
          source: {
            entry: 'invalid.scad',
            files: { 'invalid.scad': 'required = false; // [true:Required]\ncube(1);' },
          },
        }),
      ).rejects.toThrow('INVALID_SCHEMA');
    } finally {
      await client.shutdown();
    }
  });

  it('should render parameter-selected SVGs and invalidate replaced upload bytes', async () => {
    const client = await createNodeClient({ runtime });
    const document = client.open({
      watch: false,
      source: {
        entry: 'main.scad',
        files: {
          'main.scad': '/* [Artwork] */\nasset_file = "art/first.svg";\nlinear_extrude(2) import(asset_file);',
          'art/first.svg': svg(10),
          'art/second.svg': new TextEncoder().encode(svg(20)),
        },
      },
    });
    try {
      const evaluation = await document.evaluation();
      if (evaluation.superseded || !evaluation.evaluation.success) {
        throw new Error(
          evaluation.superseded
            ? 'Evaluation superseded'
            : evaluation.evaluation.issues.map(({ message }) => message).join('; '),
        );
      }
      const view = document.view('model');
      const initial = await renderBytes(view);
      const initialVolume = Math.abs(await getSignedVolumeFromGlb(initial));
      expect(initialVolume).toBeGreaterThan(0);
      // eslint-disable-next-line @typescript-eslint/naming-convention -- These group and parameter names belong to the authored SCAD interface.
      await document.update({ parameters: { Artwork: { asset_file: 'art/second.svg' } } });
      const selected = await renderBytes(view);
      expect(Math.abs(await getSignedVolumeFromGlb(selected)) / initialVolume).toBeCloseTo(2, 4);
      await document.update({ stage: { 'art/second.svg': new TextEncoder().encode(svg(30)) } });
      const replaced = await renderBytes(view);
      expect(Math.abs(await getSignedVolumeFromGlb(replaced)) / initialVolume).toBeCloseTo(3, 4);
    } finally {
      document.close();
      await client.shutdown();
    }
  });

  it('should mount binary STL selected by a parameter without a literal import call', async () => {
    const client = await createNodeClient({ runtime });
    const tetrahedron = new TextEncoder().encode(`solid tetrahedron
facet normal 0 0 -1
outer loop
vertex 0 0 0
vertex 0 1 0
vertex 1 0 0
endloop
endfacet
facet normal 0 -1 0
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 0 1
endloop
endfacet
facet normal -1 0 0
outer loop
vertex 0 0 0
vertex 0 0 1
vertex 0 1 0
endloop
endfacet
facet normal 1 1 1
outer loop
vertex 1 0 0
vertex 0 1 0
vertex 0 0 1
endloop
endfacet
endsolid tetrahedron`);
    const document = client.open({
      watch: false,
      source: {
        entry: 'main.scad',
        files: {
          'main.scad': 'asset_file = "tetrahedron.stl";\nimport(file = asset_file);',
          'tetrahedron.stl': tetrahedron,
        },
      },
    });
    try {
      const evaluation = await document.evaluation();
      if (evaluation.superseded || !evaluation.evaluation.success) {
        throw new Error(
          evaluation.superseded
            ? 'Evaluation superseded'
            : evaluation.evaluation.issues.map(({ message }) => message).join('; '),
        );
      }
      const view = document.view('model');
      expect(Math.abs(await getSignedVolumeFromGlb(await renderBytes(view)))).toBeGreaterThan(0);
    } finally {
      document.close();
      await client.shutdown();
    }
  });
});
