import { describe, expect, it } from 'vitest';
import { NodeIO } from '@gltf-transform/core';
import { allExtensions } from '@taucad/geometry-core';
import { createNodeClient } from '@taucad/runtime/node';
import { unzipSync } from 'fflate';
import { createNodeGallerySession } from '#runtime/node.js';
import type { GalleryRenderResult } from '#runtime/types.js';
import { runtime } from '#runtime/definitions/openscad.js';
import { resolveGalleryParameters } from '#runtime/parameters.js';
import { loadNodeProjectFiles, readNodeCatalog } from '#scripts/catalog-node.js';
import { measureGlb } from '#scripts/measure-glb.js';
import { validateExportArtifact } from '#scripts/verification-artifacts.js';

const glbDocument = async (result: GalleryRenderResult) => {
  if (typeof result.artifact.content === 'string') {
    throw new TypeError('Expected binary GLB content.');
  }
  return new NodeIO().registerExtensions(allExtensions).readBinary(result.artifact.content);
};

const svg = (width: number): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="10mm" viewBox="0 0 ${width} 10"><path d="M0 0 H${width} V10 H0 Z"/></svg>`,
  );

describe('classic OpenSCAD through the public gallery session', { timeout: 60_000 }, () => {
  it('should retain real face colors, grouped booleans, native STL, transcoded exports, and parameter reset', async () => {
    const session = await createNodeGallerySession({
      kernel: 'openscad',
      entryPath: 'main.scad',
      files: {
        'main.scad': `/* [Dimensions] */
width = 10;
enabled = true; // [true,false]
color([1,0,0]) cube([width, enabled ? 2 : 4, 3]);
translate([20,0,0]) color([0,1,0,0.5]) cube(1);`,
      },
    });
    try {
      const initial = await session.render();
      // eslint-disable-next-line @typescript-eslint/naming-convention -- The authored Customizer group is named Dimensions.
      expect(initial.defaultParameters).toEqual({ Dimensions: { width: 10, enabled: true } });
      expect(initial.formats).toEqual(['glb', 'stl', '3mf', 'obj', 'step']);
      const document = await glbDocument(initial);
      expect(document.getRoot().listMeshes()).toHaveLength(2);
      const colors = document
        .getRoot()
        .listMaterials()
        .map((material) => material.getBaseColorFactor());
      expect(colors).toContainEqual([1, 0, 0, 1]);
      expect(
        colors.some(
          ([red, green, blue, alpha]) => red === 0 && green === 1 && blue === 0 && Math.abs(alpha - 0.5) < 0.005,
        ),
      ).toBe(true);
      const edited = await session.render({ width: 12, enabled: false });
      // eslint-disable-next-line @typescript-eslint/naming-convention -- The runtime must preserve the authored Dimensions group.
      expect(edited.parameters).toEqual({ Dimensions: { width: 12, enabled: false } });
      expect(edited.artifactHash).not.toBe(initial.artifactHash);
      const reset = await session.render({});
      expect(reset.artifactHash).toBe(initial.artifactHash);

      const glbFiles = await session.export('glb');
      const glb = glbFiles[0];
      expect(glb?.name).toBe('model.glb');
      if (!glb) {
        throw new Error('Missing GLB export.');
      }
      const exportedDocument = await new NodeIO().readBinary(glb.bytes);
      expect(exportedDocument.getRoot().listMeshes()).toHaveLength(2);
      const stlFiles = await session.export('stl');
      const stl = stlFiles[0];
      expect(stl?.name).toBe('model.stl');
      if (!stl) {
        throw new Error('Missing native STL export.');
      }
      expect(new TextDecoder().decode(stl.bytes)).toMatch(/^solid /u);
      const reference = await measureGlb(glb.bytes);
      const stlValidation = await validateExportArtifact({ format: 'stl', files: stlFiles, reference });
      expect(stlValidation.level).toBe('geometry');
      expect(stlValidation.counts['triangles']).toBeGreaterThan(0);
      const threeMfFiles = await session.export('3mf');
      const threeMf = threeMfFiles[0];
      if (!threeMf) {
        throw new Error('Missing strict 3MF export.');
      }
      expect(threeMf.name).toBe('model.3mf');
      expect(Object.keys(unzipSync(threeMf.bytes)).some((name) => /^3D\/.*\.model$/iu.test(name))).toBe(true);
      const objectFiles = await session.export('obj');
      expect(objectFiles.some(({ name }) => name.endsWith('.obj'))).toBe(true);
      const stepFiles = await session.export('step');
      const step = stepFiles.find(({ name }) => name.endsWith('.step'));
      expect(step).toBeDefined();
      expect(new TextDecoder().decode(step?.bytes)).toContain('ISO-10303-21;');
    } finally {
      await session.dispose();
    }
  });

  it('should retain native decimal precision and return independent copies of the committed ASCII STL', async () => {
    const session = await createNodeGallerySession({
      kernel: 'openscad',
      entryPath: 'main.scad',
      files: { 'main.scad': 'translate([-100.1875,0,0]) cube([200.25,2.123456789,3]);' },
    });
    try {
      const rendered = await session.render();
      if (typeof rendered.artifact.content === 'string') {
        throw new TypeError('Expected binary GLB preview.');
      }
      const reference = await measureGlb(rendered.artifact.content);
      expect(reference.boundsMm.size[0]).toBeCloseTo(200.25, 4);
      const first = await session.export('stl');
      const file = first[0];
      if (!file) {
        throw new Error('Missing paired native ASCII STL.');
      }
      const text = new TextDecoder().decode(file.bytes);
      expect(text).toContain('100.0625');
      expect(text).toContain('-100.1875');
      expect(text).toContain('2.123456789');
      const validation = await validateExportArtifact({ format: 'stl', files: first, reference });
      expect(validation.counts['triangles']).toBe(12);
      const committed = new Uint8Array(file.bytes);
      file.bytes[0] = 0;
      const second = await session.export('stl');
      expect(second[0]?.bytes).toEqual(committed);
    } finally {
      await session.dispose();
    }
  });

  it('should evaluate an authored negative decimal step and retain rejection of values between steps', async () => {
    const session = await createNodeGallerySession({
      kernel: 'openscad',
      entryPath: 'main.scad',
      files: { 'main.scad': 'pleat_offset = -1; // [-2:0.1:2]\ncube([10 + pleat_offset, 2, 3]);' },
    });
    try {
      const initial = await session.render();
      expect(initial.defaultParameters['pleat_offset']).toBe(-1);
      if (typeof initial.artifact.content === 'string') {
        throw new TypeError('Expected binary GLB preview.');
      }
      const initialGeometry = await measureGlb(initial.artifact.content);
      expect(initialGeometry.boundsMm.size[0]).toBeCloseTo(9, 5);
      // eslint-disable-next-line @typescript-eslint/naming-convention -- The authored Customizer parameter is named pleat_offset.
      const edited = await session.render({ pleat_offset: -0.3 });
      expect(edited.parameters['pleat_offset']).toBe(-0.3);
      if (typeof edited.artifact.content === 'string') {
        throw new TypeError('Expected binary GLB preview.');
      }
      const editedGeometry = await measureGlb(edited.artifact.content);
      expect(editedGeometry.boundsMm.size[0]).toBeCloseTo(9.7, 5);
      // eslint-disable-next-line @typescript-eslint/naming-convention -- The invalid value targets the same authored parameter.
      await expect(session.render({ pleat_offset: -0.35 })).rejects.toThrow('INVALID_SCHEMA at /pleat_offset');
      const reset = await session.render({});
      expect(reset.parameters['pleat_offset']).toBe(-1);
      expect(reset.artifactHash).toBe(initial.artifactHash);
    } finally {
      await session.dispose();
    }
  });

  it('should evaluate the unchanged pendant defaults and all preserved presets through the public runtime', async () => {
    const catalog = await readNodeCatalog();
    const entry = catalog.find(({ project }) => project.id === 'pendant-lamp');
    const variant = entry?.project.variants.find(({ id }) => id === 'openscad');
    if (!entry || !variant) {
      throw new Error('Missing the preserved pendant OpenSCAD variant.');
    }
    expect(variant.kernel).toBe('openscad');
    expect(entry.project.presets.map(({ name }) => name)).toEqual(['Small', 'Medium', 'Large']);
    const source = { files: await loadNodeProjectFiles(entry), entry: variant.entry };
    const client = await createNodeClient({ runtime });
    try {
      const description = await client.describe({ source });
      expect(description.success).toBe(true);
      if (!description.success) {
        throw new Error('The preserved pendant description failed.');
      }
      expect(description.parameters.defaults['pleat_offset']).toBe(-1);
      const cases = [{ name: 'defaults', parameters: {} }, ...entry.project.presets];
      for (const candidate of cases) {
        const parameters = resolveGalleryParameters(description.parameters.defaults, candidate.parameters);
        expect(parameters['pleat_offset'], candidate.name).toBe(-1);
        const document = client.open({ source, parameters, watch: false });
        try {
          // oxlint-disable-next-line no-await-in-loop -- Evaluate the original saved cases sequentially without native meshing.
          const outcome = await document.evaluation();
          expect(outcome, candidate.name).toMatchObject({ superseded: false, evaluation: { success: true } });
        } finally {
          document.close();
        }
      }
    } finally {
      await client.shutdown();
    }
  });

  it('should mount byte-valued nested imports and invalidate geometry when uploaded bytes change', async () => {
    const renderArtwork = async (width: number): Promise<GalleryRenderResult> => {
      const session = await createNodeGallerySession({
        kernel: 'openscad',
        entryPath: 'model/main.scad',
        files: {
          'model/main.scad': 'svg_file="artwork.svg";\nlinear_extrude(2) import(svg_file);',
          'model/artwork.svg': svg(width),
        },
      });
      try {
        return await session.render();
      } finally {
        await session.dispose();
      }
    };
    const narrow = await renderArtwork(10);
    const wide = await renderArtwork(20);
    expect(narrow.artifactHash).not.toBe(wide.artifactHash);
    const maximumX = async (result: GalleryRenderResult): Promise<number> => {
      const document = await glbDocument(result);
      const positions = document
        .getRoot()
        .listMeshes()
        .flatMap((mesh) =>
          mesh.listPrimitives().flatMap((primitive) => {
            const array = primitive.getAttribute('POSITION')?.getArray();
            return array ? [...array].filter((_value, index) => index % 3 === 0) : [];
          }),
        );
      return Math.max(...positions);
    };
    expect(await maximumX(wide)).toBeCloseTo(2 * (await maximumX(narrow)), 6);
  });

  it('should apply explicit resolution overrides and restore an authored expression on reset', async () => {
    const session = await createNodeGallerySession({
      kernel: 'openscad',
      entryPath: 'main.scad',
      files: { 'main.scad': 'smoothness = 12;\n$fn = smoothness;\ncylinder(r=10, h=2);' },
    });
    const triangleCount = async (result: GalleryRenderResult): Promise<number> => {
      const document = await glbDocument(result);
      let count = 0;
      for (const mesh of document.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          const corners = primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION')?.getCount() ?? 0;
          count += corners / 3;
        }
      }
      return count;
    };
    try {
      const initial = await session.render();
      expect(initial.defaultParameters).toEqual({ smoothness: 12 });
      const initialTriangles = await triangleCount(initial);
      expect(initialTriangles).toBeGreaterThan(0);
      const explicit = await session.render({ $fn: 24 });
      expect(explicit.parameters).toEqual({ smoothness: 12, $fn: 24 });
      expect(await triangleCount(explicit)).toBeGreaterThan(initialTriangles);
      const reset = await session.render({});
      expect(reset.artifactHash).toBe(initial.artifactHash);
      expect(reset.parameters).toEqual({ smoothness: 12 });
      const derived = await session.render({ smoothness: 20 });
      expect(await triangleCount(derived)).toBeGreaterThan(initialTriangles);
      expect(await triangleCount(derived)).toBeLessThan(await triangleCount(explicit));
      await expect(session.render({ $fn: -1 })).rejects.toThrow();
      await expect(session.export('stl')).rejects.toThrow();
      const recovered = await session.render({});
      expect(recovered.artifactHash).toBe(initial.artifactHash);
    } finally {
      await session.dispose();
    }
  });

  it('should export one closed solid with different face colors through strict canonical 3MF', async () => {
    const session = await createNodeGallerySession({
      kernel: 'openscad',
      entryPath: 'main.scad',
      files: {
        'main.scad': 'union() { color([1,0,0]) cube(10); translate([5,0,0]) color([0,1,0]) cube(10); }',
      },
    });
    try {
      const rendered = await session.render();
      const document = await glbDocument(rendered);
      expect(document.getRoot().listMeshes()).toHaveLength(1);
      expect(document.getRoot().listMeshes()[0]?.listPrimitives()).toHaveLength(2);
      expect(document.getRoot().listMeshes()[0]?.getExtension('EXT_mesh_manifold')).toBeDefined();
      const files = await session.export('3mf');
      const exported = files.find(({ name }) => name.endsWith('.3mf'));
      expect(exported).toBeDefined();
      if (!exported) {
        throw new Error('Missing strict canonical 3MF export.');
      }
      const entries = unzipSync(exported.bytes);
      const model = Object.entries(entries).find(([name]) => /^3D\/.*\.model$/iu.test(name));
      expect(model).toBeDefined();
      expect(new TextDecoder().decode(model?.[1])).toContain('<triangle');
    } finally {
      await session.dispose();
    }
  });

  it('should reject a missing include even when the CLI can produce a partial model', async () => {
    const session = await createNodeGallerySession({
      kernel: 'openscad',
      entryPath: 'main.scad',
      files: { 'main.scad': 'width=10;\ninclude <missing.scad>\ncube(width);' },
    });
    try {
      await expect(session.render()).rejects.toThrow(/include.*missing\.scad/iu);
      await expect(session.export('stl')).rejects.toThrow(/include.*missing\.scad/iu);
    } finally {
      await session.dispose();
    }
  });
});
