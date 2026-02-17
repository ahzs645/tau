import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { calculateOptimalGrid } from '#machines/screenshot-capability.machine.js';
import {
  applyMatcapToClonedScene,
  disposeClonedSceneMaterials,
} from '#components/geometry/graphics/three/materials/gltf-matcap.js';
import { calculateFovDistanceCompensation } from '#components/geometry/graphics/three/utils/math.utils.js';

describe('calculateOptimalGrid', () => {
  describe('edge cases', () => {
    it('should return { columns: 1, rows: 1 } for 0 items', () => {
      const result = calculateOptimalGrid(0);
      expect(result).toEqual({ columns: 1, rows: 1 });
    });

    it('should return { columns: 1, rows: 1 } for negative item count', () => {
      const result = calculateOptimalGrid(-5);
      expect(result).toEqual({ columns: 1, rows: 1 });
    });

    it('should return { columns: 1, rows: 1 } for 1 item', () => {
      const result = calculateOptimalGrid(1);
      expect(result).toEqual({ columns: 1, rows: 1 });
    });
  });

  describe('default 3:2 preferred ratio', () => {
    it('should return { columns: 2, rows: 1 } for 2 items', () => {
      const result = calculateOptimalGrid(2);
      expect(result).toEqual({ columns: 2, rows: 1 });
    });

    it('should return { columns: 2, rows: 2 } for 3 items (2/2=1.0 closest to 1.5)', () => {
      // 3/1=3.0 (diff 1.5), 2/2=1.0 (diff 0.5) -- 2x2 wins
      const result = calculateOptimalGrid(3);
      expect(result).toEqual({ columns: 2, rows: 2 });
    });

    it('should return { columns: 3, rows: 2 } for 4 items (perfect 1.5 ratio)', () => {
      // 4/1=4.0 (diff 2.5), 2/2=1.0 (diff 0.5), 3/2=1.5 (diff 0) -- 3x2 wins
      const result = calculateOptimalGrid(4);
      expect(result).toEqual({ columns: 3, rows: 2 });
    });

    it('should return a valid layout for 5 items', () => {
      const result = calculateOptimalGrid(5);
      expect(result.columns * result.rows).toBeGreaterThanOrEqual(5);
    });

    it('should return { columns: 3, rows: 2 } for 6 items (perfect 3:2 match)', () => {
      const result = calculateOptimalGrid(6);
      expect(result).toEqual({ columns: 3, rows: 2 });
    });

    it('should return a valid layout for 7 items', () => {
      const result = calculateOptimalGrid(7);
      expect(result.columns * result.rows).toBeGreaterThanOrEqual(7);
    });

    it('should return a valid layout for 8 items', () => {
      const result = calculateOptimalGrid(8);
      expect(result.columns * result.rows).toBeGreaterThanOrEqual(8);
    });

    it('should return { columns: 4, rows: 3 } for 9 items (4/3=1.33 closest to 1.5)', () => {
      // 3/3=1.0 (diff 0.5), 4/3=1.33 (diff 0.17), 5/2=2.5 (diff 1.0) -- 4x3 wins
      const result = calculateOptimalGrid(9);
      expect(result).toEqual({ columns: 4, rows: 3 });
    });

    it('should return a valid layout for 12 items', () => {
      const result = calculateOptimalGrid(12);
      expect(result.columns * result.rows).toBeGreaterThanOrEqual(12);
      // 4x3 = 12, ratio 4/3 = 1.33, close to 3/2 = 1.5
      // 3x4 = 12, ratio 3/4 = 0.75, further from 1.5
      // 6x2 = 12, ratio 6/2 = 3.0, further from 1.5
      expect(result.columns).toBeGreaterThanOrEqual(result.rows);
    });
  });

  describe('custom preferred ratio', () => {
    it('should prefer square layouts with 1:1 ratio', () => {
      const result = calculateOptimalGrid(4, { columns: 1, rows: 1 });
      expect(result).toEqual({ columns: 2, rows: 2 });
    });

    it('should prefer wide layouts with 4:1 ratio', () => {
      const result = calculateOptimalGrid(8, { columns: 4, rows: 1 });
      // 8x1 = ratio 8, 4x2 = ratio 2, etc. -- 4x2 is closest to 4
      expect(result.columns).toBeGreaterThan(result.rows);
    });

    it('should prefer tall layouts with 1:3 ratio', () => {
      const result = calculateOptimalGrid(6, { columns: 1, rows: 3 });
      // Target ratio = 1/3 ≈ 0.33
      // 1x6 = 0.167, 2x3 = 0.667, 3x2 = 1.5, 6x1 = 6
      // Closest to 0.33 is 1x6 (0.167) or 2x3 (0.667)
      expect(result.rows).toBeGreaterThanOrEqual(result.columns);
    });
  });

  describe('capacity guarantee', () => {
    it('should always return a grid that can fit all items', () => {
      for (let count = 1; count <= 20; count++) {
        const result = calculateOptimalGrid(count);
        expect(result.columns * result.rows).toBeGreaterThanOrEqual(count);
      }
    });

    it('should always return positive columns and rows', () => {
      for (let count = 0; count <= 20; count++) {
        const result = calculateOptimalGrid(count);
        expect(result.columns).toBeGreaterThanOrEqual(1);
        expect(result.rows).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('consistency', () => {
    it('should return the same result for the same inputs', () => {
      const result1 = calculateOptimalGrid(6);
      const result2 = calculateOptimalGrid(6);
      expect(result1).toEqual(result2);
    });

    it('should return the same result with explicit default ratio', () => {
      const withDefault = calculateOptimalGrid(6);
      const withExplicit = calculateOptimalGrid(6, { columns: 3, rows: 2 });
      expect(withDefault).toEqual(withExplicit);
    });
  });
});

// ── Helpers for screenshot feature tests ──────────────────────────────────────

/** Creates a minimal matcap texture stub for testing. */
function createStubTexture(): THREE.Texture {
  const texture = new THREE.Texture();
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Creates a mesh with a MeshStandardMaterial of the given color and opacity. */
function createColoredMesh(
  color = 0xff_00_00,
  opacity = 1,
): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color, opacity, transparent: opacity < 1 });
  return new THREE.Mesh(geometry, material);
}

/** Creates a mesh with vertex colors on the geometry. */
function createVertexColoredMesh(): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const { count } = geometry.attributes['position']!;
  const colors = new Float32Array(count * 3);
  for (let index = 0; index < count * 3; index++) {
    colors[index] = Math.random();
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.MeshStandardMaterial();
  return new THREE.Mesh(geometry, material);
}

// ── applyMatcapToClonedScene ────────────────────────────────────────────────

describe('applyMatcapToClonedScene', () => {
  it('should replace mesh materials with MeshMatcapMaterial', () => {
    const scene = new THREE.Scene();
    const mesh = createColoredMesh();
    scene.add(mesh);
    const texture = createStubTexture();

    applyMatcapToClonedScene(scene, texture);

    expect(mesh.material).toBeInstanceOf(THREE.MeshMatcapMaterial);
  });

  it('should set the matcap texture on the replacement material', () => {
    const scene = new THREE.Scene();
    const mesh = createColoredMesh();
    scene.add(mesh);
    const texture = createStubTexture();

    applyMatcapToClonedScene(scene, texture);

    const matcapMat = mesh.material as THREE.MeshMatcapMaterial;
    expect(matcapMat.matcap).toBe(texture);
  });

  it('should use DoubleSide on the replacement material', () => {
    const scene = new THREE.Scene();
    const mesh = createColoredMesh();
    scene.add(mesh);
    const texture = createStubTexture();

    applyMatcapToClonedScene(scene, texture);

    const matcapMat = mesh.material as THREE.MeshMatcapMaterial;
    expect(matcapMat.side).toBe(THREE.DoubleSide);
  });

  it('should preserve the original material color', () => {
    const scene = new THREE.Scene();
    const mesh = createColoredMesh(0x00_ff_00);
    scene.add(mesh);
    const texture = createStubTexture();

    applyMatcapToClonedScene(scene, texture);

    const matcapMat = mesh.material as THREE.MeshMatcapMaterial;
    expect(matcapMat.color.getHex()).toBe(0x00_ff_00);
  });

  it('should preserve opacity and set transparent when opacity < 1', () => {
    const scene = new THREE.Scene();
    const mesh = createColoredMesh(0xff_00_00, 0.5);
    scene.add(mesh);
    const texture = createStubTexture();

    applyMatcapToClonedScene(scene, texture);

    const matcapMat = mesh.material as THREE.MeshMatcapMaterial;
    expect(matcapMat.opacity).toBe(0.5);
    expect(matcapMat.transparent).toBe(true);
  });

  it('should not set transparent when opacity is 1', () => {
    const scene = new THREE.Scene();
    const mesh = createColoredMesh(0xff_00_00, 1);
    scene.add(mesh);
    const texture = createStubTexture();

    applyMatcapToClonedScene(scene, texture);

    const matcapMat = mesh.material as THREE.MeshMatcapMaterial;
    expect(matcapMat.opacity).toBe(1);
    expect(matcapMat.transparent).toBe(false);
  });

  it('should enable vertexColors when geometry has a color attribute', () => {
    const scene = new THREE.Scene();
    const mesh = createVertexColoredMesh();
    scene.add(mesh);
    const texture = createStubTexture();

    applyMatcapToClonedScene(scene, texture);

    const matcapMat = mesh.material as THREE.MeshMatcapMaterial;
    expect(matcapMat.vertexColors).toBe(true);
  });

  it('should not enable vertexColors when geometry has no color attribute', () => {
    const scene = new THREE.Scene();
    const mesh = createColoredMesh();
    scene.add(mesh);
    const texture = createStubTexture();

    applyMatcapToClonedScene(scene, texture);

    const matcapMat = mesh.material as THREE.MeshMatcapMaterial;
    expect(matcapMat.vertexColors).toBe(false);
  });

  it('should NOT dispose original materials (they are shared with the live scene)', () => {
    const scene = new THREE.Scene();
    const mesh = createColoredMesh();
    const originalMaterial = mesh.material;
    const disposeSpy = vi.spyOn(originalMaterial, 'dispose');
    scene.add(mesh);
    const texture = createStubTexture();

    applyMatcapToClonedScene(scene, texture);

    expect(disposeSpy).not.toHaveBeenCalled();
  });

  it('should process meshes nested in groups', () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    const mesh = createColoredMesh();
    group.add(mesh);
    scene.add(group);
    const texture = createStubTexture();

    applyMatcapToClonedScene(scene, texture);

    expect(mesh.material).toBeInstanceOf(THREE.MeshMatcapMaterial);
  });

  it('should handle a scene with no meshes without error', () => {
    const scene = new THREE.Scene();
    scene.add(new THREE.Group());
    const texture = createStubTexture();

    expect(() => {
      applyMatcapToClonedScene(scene, texture);
    }).not.toThrow();
  });

  it('should handle multiple meshes with distinct colors', () => {
    const scene = new THREE.Scene();
    const meshRed = createColoredMesh(0xff_00_00);
    const meshBlue = createColoredMesh(0x00_00_ff);
    scene.add(meshRed);
    scene.add(meshBlue);
    const texture = createStubTexture();

    applyMatcapToClonedScene(scene, texture);

    const matRed = meshRed.material as THREE.MeshMatcapMaterial;
    const matBlue = meshBlue.material as THREE.MeshMatcapMaterial;
    expect(matRed.color.getHex()).toBe(0xff_00_00);
    expect(matBlue.color.getHex()).toBe(0x00_00_ff);
  });
});

// ── disposeClonedSceneMaterials ─────────────────────────────────────────────

describe('disposeClonedSceneMaterials', () => {
  it('should call dispose on each mesh material', () => {
    const scene = new THREE.Scene();
    const mesh1 = createColoredMesh();
    const mesh2 = createColoredMesh();
    scene.add(mesh1);
    scene.add(mesh2);
    const texture = createStubTexture();

    // Apply matcap first (mimics screenshot pipeline)
    applyMatcapToClonedScene(scene, texture);

    const disposeSpy1 = vi.spyOn(mesh1.material as THREE.Material, 'dispose');
    const disposeSpy2 = vi.spyOn(mesh2.material as THREE.Material, 'dispose');

    disposeClonedSceneMaterials(scene);

    expect(disposeSpy1).toHaveBeenCalledOnce();
    expect(disposeSpy2).toHaveBeenCalledOnce();
  });

  it('should handle an empty scene without error', () => {
    const scene = new THREE.Scene();

    expect(() => {
      disposeClonedSceneMaterials(scene);
    }).not.toThrow();
  });

  it('should dispose nested mesh materials', () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    const mesh = createColoredMesh();
    group.add(mesh);
    scene.add(group);
    const texture = createStubTexture();

    applyMatcapToClonedScene(scene, texture);
    const disposeSpy = vi.spyOn(mesh.material as THREE.Material, 'dispose');

    disposeClonedSceneMaterials(scene);

    expect(disposeSpy).toHaveBeenCalledOnce();
  });
});

// ── Screenshot FOV zoom compensation ────────────────────────────────────────

describe('screenshot FOV zoom compensation', () => {
  /**
   * Replicates the exact zoom compensation logic from captureScreenshots:
   *
   *   const screenshotFov = 45;
   *   const zoomCompensation = calculateFovDistanceCompensation(screenshotFov, originalFov, 1);
   *   screenshotCamera.zoom = config.zoomLevel * zoomCompensation;
   *
   * The math: zoomCompensation = tan(45/2) / tan(originalFov/2)
   */
  const screenshotFov = 45;

  function computeZoomCompensation(originalFov: number): number {
    return calculateFovDistanceCompensation(screenshotFov, originalFov, 1);
  }

  it('should return 1.0 when the original FOV is already 45', () => {
    const compensation = computeZoomCompensation(45);

    expect(compensation).toBeCloseTo(1, 10);
  });

  it('should return < 1 when the original FOV is wider than 45 (needs zoom-out)', () => {
    // Going from wide FOV (90) to narrower 45: the 45 FOV already sees less,
    // so zoom must decrease to keep the same visible area.
    const compensation = computeZoomCompensation(90);

    expect(compensation).toBeLessThan(1);
    // Tan(22.5°) / tan(45°) ≈ 0.4142
    expect(compensation).toBeCloseTo(Math.tan((22.5 * Math.PI) / 180) / Math.tan((45 * Math.PI) / 180), 6);
  });

  it('should return > 1 when the original FOV is narrower than 45 (needs zoom-in)', () => {
    // Going from narrow FOV (10) to wider 45: the 45 FOV sees more,
    // so zoom must increase to keep the same visible area.
    const compensation = computeZoomCompensation(10);

    expect(compensation).toBeGreaterThan(1);
    // Tan(22.5°) / tan(5°) ≈ 4.74
    expect(compensation).toBeCloseTo(Math.tan((22.5 * Math.PI) / 180) / Math.tan((5 * Math.PI) / 180), 6);
  });

  it('should preserve the visible frustum half-height', () => {
    // In Three.js: visible half-height = tan(fov/2) / zoom
    // After compensation, tan(45/2)/newZoom must equal tan(originalFov/2)/originalZoom
    const originalFov = 70;
    const originalZoom = 1.5;
    const compensation = computeZoomCompensation(originalFov);
    const newZoom = originalZoom * compensation;

    const originalHalfHeight = Math.tan(((originalFov / 2) * Math.PI) / 180) / originalZoom;
    const newHalfHeight = Math.tan(((screenshotFov / 2) * Math.PI) / 180) / newZoom;

    expect(newHalfHeight).toBeCloseTo(originalHalfHeight, 10);
  });

  it('should preserve visible area for extreme narrow FOV', () => {
    const originalFov = 1;
    const originalZoom = 2;
    const compensation = computeZoomCompensation(originalFov);
    const newZoom = originalZoom * compensation;

    const originalHalfHeight = Math.tan(((originalFov / 2) * Math.PI) / 180) / originalZoom;
    const newHalfHeight = Math.tan(((screenshotFov / 2) * Math.PI) / 180) / newZoom;

    expect(newHalfHeight).toBeCloseTo(originalHalfHeight, 10);
  });

  it('should preserve visible area for extreme wide FOV', () => {
    const originalFov = 89;
    const originalZoom = 0.8;
    const compensation = computeZoomCompensation(originalFov);
    const newZoom = originalZoom * compensation;

    const originalHalfHeight = Math.tan(((originalFov / 2) * Math.PI) / 180) / originalZoom;
    const newHalfHeight = Math.tan(((screenshotFov / 2) * Math.PI) / 180) / newZoom;

    expect(newHalfHeight).toBeCloseTo(originalHalfHeight, 10);
  });

  it('should be monotonically decreasing as original FOV increases', () => {
    const fovValues = [10, 20, 30, 45, 60, 75, 89];
    const compensations = fovValues.map((fov) => computeZoomCompensation(fov));

    for (let index = 1; index < compensations.length; index++) {
      expect(compensations[index]!).toBeLessThan(compensations[index - 1]!);
    }
  });

  it('should be symmetric with the underlying distance compensation formula', () => {
    // Verify that our zoom compensation is the exact inverse ratio:
    // computeZoomCompensation(fov) = tan(screenshotFov/2) / tan(fov/2)
    for (const fov of [10, 30, 45, 60, 80]) {
      const expected = Math.tan(((screenshotFov / 2) * Math.PI) / 180) / Math.tan(((fov / 2) * Math.PI) / 180);
      expect(computeZoomCompensation(fov)).toBeCloseTo(expected, 10);
    }
  });
});
