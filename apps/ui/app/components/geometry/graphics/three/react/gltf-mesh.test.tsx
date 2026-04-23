import type { MockInstance } from 'vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Group, Mesh, BufferGeometry, BufferAttribute, MeshBasicMaterial } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { probeGltfScene } from '#components/geometry/graphics/three/react/gltf-mesh.js';

const buildMeshWithPositions = (positions: readonly number[]): Mesh => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  return new Mesh(geometry, new MeshBasicMaterial());
};

const createGltfWithChildren = (childCount: number): GLTF => {
  const scene = new Group();
  for (let i = 0; i < childCount; i++) {
    // Unit-cube-ish positions so bbox becomes finite for ≥1-child happy-path tests.
    scene.add(buildMeshWithPositions([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  }
  // GLTF has many other fields the loader populates, but probeGltfScene only
  // inspects `scene` so a partial cast is the minimum surface.
  const gltf: Pick<GLTF, 'scene'> = { scene };
  return gltf as GLTF;
};

const createGltfWithNonFiniteMesh = (): GLTF => {
  const scene = new Group();
  scene.add(buildMeshWithPositions([Number.NaN, 0, 0, 1, Number.NaN, 0, 0, 0, Number.POSITIVE_INFINITY]));
  const gltf: Pick<GLTF, 'scene'> = { scene };
  return gltf as GLTF;
};

const noop = (): void => {
  /* No-op console.warn replacement */
};

describe('probeGltfScene (R6 OCJS smoke trail)', () => {
  let warnSpy: MockInstance<typeof console.warn> | undefined;

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
  });

  describe('Gate 2: GLTFLoader silently dropped nodes (childrenCount === 0)', () => {
    it('should warn with byteLength + childrenCount + bbox when GLTFLoader produces a scene with zero children', () => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
      const gltf = createGltfWithChildren(0);

      probeGltfScene(gltf, 1234);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const call = warnSpy.mock.calls[0]!;
      expect(call[0]).toBe('GLTFLoader produced a scene with zero children');
      const payload = call[1] as Record<string, unknown>;
      expect(payload).toMatchObject({
        byteLength: 1234,
        childrenCount: 0,
        bbox: expect.objectContaining({
          min: expect.any(Object) as unknown,
          max: expect.any(Object) as unknown,
          finite: false,
        }) as unknown,
      });
    });
  });

  describe('Gate 3: coordinate transform regression (childrenCount > 0 but bbox is non-finite)', () => {
    it('should warn with byteLength + childrenCount + bbox when the world bbox contains NaN or Infinity', () => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
      const gltf = createGltfWithNonFiniteMesh();

      probeGltfScene(gltf, 9999);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const call = warnSpy.mock.calls[0]!;
      expect(call[0]).toBe('GLTFLoader produced a scene with a non-finite bounding box');
      const payload = call[1] as Record<string, unknown>;
      expect(payload).toMatchObject({
        byteLength: 9999,
        childrenCount: 1,
        bbox: expect.objectContaining({ finite: false }) as unknown,
      });
    });
  });

  describe('Happy path (childrenCount > 0 AND finite bbox)', () => {
    it('should remain silent when the scene has at least one child with finite positions', () => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
      const gltf = createGltfWithChildren(1);

      probeGltfScene(gltf, 8888);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should remain silent on multi-child scenes with finite positions regardless of byteLength', () => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
      const gltf = createGltfWithChildren(5);

      probeGltfScene(gltf, 0);

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
