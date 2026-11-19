import { describe, expect, it } from 'vitest';
import { NodeIO } from '@gltf-transform/core';
import { allExtensions } from '@taucad/geometry-core';
import { unzipSync } from 'fflate';
import { createNodeGallerySession } from '#runtime/node.js';
import type { GalleryRenderResult } from '#runtime/types.js';

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
      const triangles = new DataView(stl.bytes.buffer, stl.bytes.byteOffset, stl.bytes.byteLength).getUint32(80, true);
      expect(triangles).toBeGreaterThan(0);
      expect(stl.bytes.byteLength).toBe(84 + 50 * triangles);
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
