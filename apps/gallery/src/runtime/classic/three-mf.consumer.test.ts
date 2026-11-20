// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { BufferGeometry, Color, Material, SRGBColorSpace } from 'three';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { parseClassicOff } from '#runtime/classic/mesh.js';
import { classicMeshToThreeMf } from '#runtime/classic/three-mf.js';

// Explicit base-class guards retain their public default generics when traversing Object3D values.
const isGeometry = (value: unknown): value is BufferGeometry => value instanceof BufferGeometry;
const isMaterial = (value: unknown): value is Material => value instanceof Material;

describe('native 3MF independent consumer compatibility', () => {
  it('should load the complete oriented surface and every sRGB display color including alpha', () => {
    const source = parseClassicOff(`OFF 4 4 0
10 -20 30
20 -20 30
10 0 30
10 -20 60
3 0 2 1 249 215 44 255
3 0 1 3 157 203 81 255
3 0 3 2 255 0 0 127
3 1 2 3 0 0 255 127
`);
    const bytes = classicMeshToThreeMf(source);
    const group = new ThreeMFLoader().parse(bytes.buffer);
    const resources: Array<{ geometry: BufferGeometry; material: Material }> = [];
    try {
      const properties: Array<{ color: string; alpha: number; triangles: number }> = [];
      group.traverse((object) => {
        if (!('isMesh' in object) || object.isMesh !== true) {
          return;
        }
        if (
          !('geometry' in object) ||
          !isGeometry(object.geometry) ||
          !('material' in object) ||
          !isMaterial(object.material)
        ) {
          throw new TypeError('Expected a mesh with geometry and one material.');
        }
        const { geometry, material } = object;
        resources.push({ geometry, material });
        if (!('color' in material) || !(material.color instanceof Color)) {
          throw new TypeError('Expected one color material per decoded 3MF face palette entry.');
        }
        const position = geometry.getAttribute('position');
        properties.push({
          color: material.color.getHexString(SRGBColorSpace).toUpperCase(),
          alpha: material.opacity,
          triangles: (geometry.getIndex()?.count ?? position.count) / 3,
        });
      });
      expect(properties).toEqual(
        expect.arrayContaining([
          { color: 'F9D72C', alpha: 1, triangles: 1 },
          { color: '9DCB51', alpha: 1, triangles: 1 },
          { color: 'FF0000', alpha: 127 / 255, triangles: 1 },
          { color: '0000FF', alpha: 127 / 255, triangles: 1 },
        ]),
      );
      expect(properties).toHaveLength(4);
      expect(group.children).toHaveLength(1);
    } finally {
      for (const { geometry, material } of resources) {
        geometry.dispose();
        material.dispose();
      }
    }
  });
});
