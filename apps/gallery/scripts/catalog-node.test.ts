import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadNodeProjectFiles, readNodeCatalog } from '#scripts/catalog-node.js';
import { parseProjectDefinition } from '#catalog/schema.js';

describe('gallery migration inventory', () => {
  it('should preserve all twenty public IDs and keep Wham hidden', async () => {
    const catalogue = await readNodeCatalog();
    expect(
      catalogue
        .filter(({ project }) => !project.hidden)
        .map(({ project }) => project.id)
        .sort(),
    ).toEqual([
      '3d-rack-scad',
      'atmospheric-sampler',
      'bottle-separator',
      'catan-insert',
      'gel-comb-scad',
      'keyguard-with-raised-tabs',
      'networking',
      'networking-rack-scad',
      'opencascade-box',
      'openscad-bracket',
      'parametric-gel-comb',
      'pendant-lamp',
      'periodic-table',
      'pet-bottle-opener',
      'pre-chamber-nozzle-insert',
      'replicad-tray',
      'saboteur-card-holder',
      'stamp',
      'tray-scad',
      'vane-trap',
    ]);
    expect(catalogue.find(({ project }) => project.id === 'wham')?.project.hidden).toBe(true);
    expect(catalogue.filter(({ project }) => !project.hidden).flatMap(({ project }) => project.variants)).toHaveLength(
      30,
    );
  });

  it('should preserve the recovered original includes and their license notices byte for byte', async () => {
    const catalogue = await readNodeCatalog();
    const originals = [
      ['tray-scad', 'Untitled-1.scad', '04bcafc8c022cf440adf23e28c6a51dc669d03c7'],
      ['saboteur-card-holder', 'grid.scad', '7cf96da1bb22bce76a8d5259bc042dfcefc350f9'],
      ['wham', 'Untitled-1.scad', '4a9294e9f13099fd8fd07fd75755b1517f28159a'],
    ] as const;
    const gitBlobHash = (bytes: Uint8Array<ArrayBuffer>): string =>
      createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    await Promise.all(
      originals.map(async ([id, source, hash]) => {
        const entry = catalogue.find(({ project }) => project.id === id);
        if (!entry) {
          throw new Error(`Missing restored project ${id}`);
        }
        const files = await loadNodeProjectFiles(entry);
        const content = files[source];
        if (!content) {
          throw new Error(`Missing original include ${id}/${source}`);
        }
        expect(gitBlobHash(content)).toBe(hash);
        expect(gitBlobHash(new Uint8Array(await readFile(path.join(entry.directory, 'SOURCE_LICENSE.md'))))).toBe(
          '0cda52d9f6c6fd8dde2d3403e926bde18a571718',
        );
      }),
    );
  });

  it('should stage the pinned BOSL2 library beside each project that includes it', async () => {
    const catalogue = await readNodeCatalog();
    const consumers = catalogue.filter(({ project }) => project.libraries.includes('BOSL2'));
    expect(consumers.map(({ project }) => project.id).sort()).toEqual([
      '3d-rack-scad',
      'pendant-lamp',
      'pre-chamber-nozzle-insert',
      'vane-trap',
    ]);
    await Promise.all(
      consumers.map(async (entry) => {
        const files = await loadNodeProjectFiles(entry);
        expect(files['BOSL2/std.scad']?.length).toBeGreaterThan(0);
        expect(files['BOSL2/threading.scad']?.length).toBeGreaterThan(0);
        expect(entry.project.filePaths).toContain('BOSL2/THIRD_PARTY_NOTICES.md');
        expect(entry.project.filePaths).toContain('BOSL2/SOURCE.txt');
      }),
    );
  });

  it('should load the complete stamp including byte-exact STL templates and replaceable SVG', async () => {
    const catalogue = await readNodeCatalog();
    const stamp = catalogue.find(({ project }) => project.id === 'stamp');
    if (!stamp) {
      throw new Error('Missing stamp catalogue entry');
    }
    const files = await loadNodeProjectFiles(stamp);
    await Promise.all(
      ['stamp_template_handle.stl', 'stamp_template_knub.stl', 'yaa.svg'].map(async (name) => {
        expect(files[name]).toEqual(new Uint8Array(await readFile(path.join(stamp.directory, name))));
      }),
    );
    expect(stamp.project.uploads).toEqual([
      {
        id: 'yaa.svg',
        filePath: 'yaa.svg',
        accept: '.svg,image/svg+xml',
        label: 'Artwork (SVG)',
      },
    ]);
    expect(stamp.project.components?.variantIds).toEqual(['openscad']);
    expect(Object.keys(files)).toContain('lib/svg-strokes.ts');
  });

  it('should keep presets on the schema they were authored for and retain public variant IDs', async () => {
    const catalogue = await readNodeCatalog();
    const lamp = catalogue.find(({ project }) => project.id === 'pendant-lamp')?.project;
    expect(lamp?.defaultVariantId).toBe('openscad');
    expect(lamp?.variants.map(({ id, kernel }) => ({ id, kernel }))).toEqual([
      { id: 'openscad', kernel: 'openscad' },
      { id: 'opencascade', kernel: 'opencascade' },
      { id: 'replicad', kernel: 'replicad' },
    ]);
    expect(lamp?.presets.length).toBeGreaterThan(0);
    expect(lamp?.presets.every((preset) => preset.variantIds.length === 1 && preset.variantIds[0] === 'openscad')).toBe(
      true,
    );
    expect(lamp?.variants.find(({ id }) => id === 'opencascade')?.renderOptions).toEqual({
      tessellation: { linearTolerance: 0.02, angularTolerance: 8 },
      includeEdges: false,
    });
    expect(lamp?.variants.find(({ id }) => id === 'openscad')?.exportFormats).toContain('step');
    expect(
      catalogue.find(({ project }) => project.id === 'openscad-bracket')?.project.variants[0]?.exportFormats,
    ).toEqual(['glb']);
  });

  it('should reject missing source and unsafe metadata paths before publishing a route', () => {
    const input = {
      id: 'missing',
      collection: 'projects',
      metadata: { title: 'Missing', description: '', entry: 'main.scad' },
      filePaths: [],
      resourceUrl: (name: string) => name,
    } satisfies Parameters<typeof parseProjectDefinition>[0];
    expect(() => parseProjectDefinition(input)).toThrow('missing main.scad');
    expect(() =>
      parseProjectDefinition({ ...input, metadata: { ...input.metadata, entry: '../private.scad' } }),
    ).toThrow('parent traversal');
  });

  it('should select the preserved classic engine explicitly and permit OpenRSCAD only by declaration', async () => {
    const catalogue = await readNodeCatalog();
    const scadVariants = catalogue.flatMap(({ project }) => project.variants).filter(({ id }) => id === 'openscad');
    expect(scadVariants.length).toBeGreaterThan(0);
    expect(scadVariants.every(({ kernel }) => kernel === 'openscad')).toBe(true);
    const project = parseProjectDefinition({
      id: 'deliberate-openrscad',
      collection: 'curated',
      metadata: { title: 'Explicit engine', description: '', entry: 'main.scad', runtimeKernel: 'openrscad' },
      filePaths: ['main.scad'],
      resourceUrl: (name) => name,
    });
    expect(project.variants.map(({ id, kernel }) => ({ id, kernel }))).toEqual([
      { id: 'openscad', kernel: 'openrscad' },
    ]);
  });
});
