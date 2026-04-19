import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyMeshClipping,
  collectAndClipMeshes,
  enforceMaterialClipping,
  isClosedManifold,
} from '#components/geometry/graphics/three/react/section-view.utils.js';

const testPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

function createDoubleSidedMesh(): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  return new THREE.Mesh(geometry, material);
}

function createFrontSidedMesh(): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ side: THREE.FrontSide });
  return new THREE.Mesh(geometry, material);
}

describe('applyMeshClipping', () => {
  it('should set clippingPlanes when enabled', () => {
    const mesh = createDoubleSidedMesh();

    applyMeshClipping(mesh, { enable: true, plane: testPlane });

    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat.clippingPlanes).toHaveLength(1);
    expect(mat.clippingPlanes![0]).toBe(testPlane);
  });

  it('should preserve DoubleSide on materials when enabled', () => {
    const mesh = createDoubleSidedMesh();

    applyMeshClipping(mesh, { enable: true, plane: testPlane });

    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat.side).toBe(THREE.DoubleSide);
  });

  it('should preserve FrontSide on materials when enabled', () => {
    const mesh = createFrontSidedMesh();

    applyMeshClipping(mesh, { enable: true, plane: testPlane });

    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat.side).toBe(THREE.FrontSide);
  });

  it('should clear clippingPlanes when disabled', () => {
    const mesh = createDoubleSidedMesh();

    applyMeshClipping(mesh, { enable: true, plane: testPlane });
    applyMeshClipping(mesh, { enable: false, plane: testPlane });

    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat.side).toBe(THREE.DoubleSide);
    expect(mat.clippingPlanes).toHaveLength(0);
  });

  it('should handle mesh with material array', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const materials = [
      new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }),
      new THREE.MeshStandardMaterial({ side: THREE.FrontSide }),
    ];
    const mesh = new THREE.Mesh(geometry, materials);

    applyMeshClipping(mesh, { enable: true, plane: testPlane });

    expect(materials[0]!.side).toBe(THREE.DoubleSide);
    expect(materials[0]!.clippingPlanes).toHaveLength(1);
    expect(materials[1]!.side).toBe(THREE.FrontSide);
    expect(materials[1]!.clippingPlanes).toHaveLength(1);
  });
});

describe('collectAndClipMeshes', () => {
  function createTestSceneGraph(): {
    rootGroup: THREE.Group;
    mesh1: THREE.Mesh;
    mesh2: THREE.Mesh;
    lineSegments: THREE.LineSegments;
  } {
    const rootGroup = new THREE.Group();

    const mesh1 = createDoubleSidedMesh();
    const mesh2 = createDoubleSidedMesh();
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 1, 1),
    ]);
    const lineSegments = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial());

    rootGroup.add(mesh1);
    rootGroup.add(mesh2);
    rootGroup.add(lineSegments);

    return { rootGroup, mesh1, mesh2, lineSegments };
  }

  it('should collect only THREE.Mesh children', () => {
    const { rootGroup, mesh1, mesh2 } = createTestSceneGraph();

    const result = collectAndClipMeshes(rootGroup, {
      enableSection: true,
      enableLines: true,
      enableMesh: true,
      plane: testPlane,
    });

    expect(result).toHaveLength(2);
    expect(result).toContain(mesh1);
    expect(result).toContain(mesh2);
  });

  it('should apply clippingPlanes to all mesh materials when enableMesh is true', () => {
    const { rootGroup } = createTestSceneGraph();

    const result = collectAndClipMeshes(rootGroup, {
      enableSection: true,
      enableLines: true,
      enableMesh: true,
      plane: testPlane,
    });

    for (const mesh of result) {
      const mat = mesh.material as THREE.Material;
      expect(mat.clippingPlanes).toHaveLength(1);
      expect(mat.clippingPlanes![0]).toBe(testPlane);
    }
  });

  it('should clear mesh clippingPlanes when enableMesh is false but still return meshes', () => {
    const { rootGroup } = createTestSceneGraph();

    const result = collectAndClipMeshes(rootGroup, {
      enableSection: true,
      enableLines: true,
      enableMesh: false,
      plane: testPlane,
    });

    expect(result).toHaveLength(2);
    for (const mesh of result) {
      const mat = mesh.material as THREE.Material;
      expect(mat.clippingPlanes).toHaveLength(0);
    }
  });

  it('should apply clippingPlanes to LineSegments when enableLines is true', () => {
    const { rootGroup, lineSegments } = createTestSceneGraph();

    collectAndClipMeshes(rootGroup, {
      enableSection: true,
      enableLines: true,
      enableMesh: true,
      plane: testPlane,
    });

    const mat = lineSegments.material as THREE.Material;
    expect(mat.clippingPlanes).toHaveLength(1);
  });

  it('should clear LineSegments clippingPlanes when enableLines is false', () => {
    const { rootGroup, lineSegments } = createTestSceneGraph();

    collectAndClipMeshes(rootGroup, {
      enableSection: true,
      enableLines: false,
      enableMesh: true,
      plane: testPlane,
    });

    const mat = lineSegments.material as THREE.Material;
    expect(mat.clippingPlanes).toHaveLength(0);
  });

  it('should clear all clipping when enableSection is false', () => {
    const { rootGroup, mesh1, mesh2 } = createTestSceneGraph();

    collectAndClipMeshes(rootGroup, {
      enableSection: true,
      enableLines: true,
      enableMesh: true,
      plane: testPlane,
    });

    const result = collectAndClipMeshes(rootGroup, {
      enableSection: false,
      enableLines: true,
      enableMesh: true,
      plane: testPlane,
    });

    expect(result).toHaveLength(0);

    for (const mesh of [mesh1, mesh2]) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      expect(mat.clippingPlanes).toHaveLength(0);
      expect(mat.side).toBe(THREE.DoubleSide);
    }
  });

  it('should set matrixAutoUpdate to false on collected meshes', () => {
    const { rootGroup, mesh1, mesh2 } = createTestSceneGraph();

    collectAndClipMeshes(rootGroup, {
      enableSection: true,
      enableLines: true,
      enableMesh: true,
      plane: testPlane,
    });

    expect(mesh1.matrixAutoUpdate).toBe(false);
    expect(mesh2.matrixAutoUpdate).toBe(false);
  });
});

// -- Geometry helpers for manifold tests --

type QuadVertices = readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];

function createQuadFace(vertices: QuadVertices): THREE.BufferGeometry {
  const [v0, v1, v2, v3] = vertices;
  const positions = new Float32Array([
    v0.x,
    v0.y,
    v0.z,
    v1.x,
    v1.y,
    v1.z,
    v2.x,
    v2.y,
    v2.z,
    v2.x,
    v2.y,
    v2.z,
    v3.x,
    v3.y,
    v3.z,
    v0.x,
    v0.y,
    v0.z,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

function createDecomposedBox(size = 1): THREE.BufferGeometry[] {
  const h = size / 2;

  const frontLeftBottom = new THREE.Vector3(-h, -h, h);
  const frontRightBottom = new THREE.Vector3(h, -h, h);
  const frontRightTop = new THREE.Vector3(h, h, h);
  const frontLeftTop = new THREE.Vector3(-h, h, h);

  const backLeftBottom = new THREE.Vector3(-h, -h, -h);
  const backRightBottom = new THREE.Vector3(h, -h, -h);
  const backRightTop = new THREE.Vector3(h, h, -h);
  const backLeftTop = new THREE.Vector3(-h, h, -h);

  return [
    createQuadFace([frontLeftBottom, frontRightBottom, frontRightTop, frontLeftTop]),
    createQuadFace([backRightBottom, backLeftBottom, backLeftTop, backRightTop]),
    createQuadFace([frontRightBottom, backRightBottom, backRightTop, frontRightTop]),
    createQuadFace([backLeftBottom, frontLeftBottom, frontLeftTop, backLeftTop]),
    createQuadFace([frontLeftTop, frontRightTop, backRightTop, backLeftTop]),
    createQuadFace([backLeftBottom, backRightBottom, frontRightBottom, frontLeftBottom]),
  ];
}

/**
 * Creates a hollow box (square tube) as decomposed quad faces.
 *
 * The inner cavity has the same height as the outer box but reduced x/z extents,
 * forming a tube with 4 outer walls, 4 inner walls (reversed normals), and rim
 * quads connecting outer to inner edges at top and bottom.
 */
function createHollowBoxFaces(outerSize = 2, innerSize = 1.5): THREE.BufferGeometry[] {
  const oh = outerSize / 2;
  const ih = innerSize / 2;

  // Outer vertices
  const oFlb = new THREE.Vector3(-oh, -oh, oh);
  const oFrb = new THREE.Vector3(oh, -oh, oh);
  const oFrt = new THREE.Vector3(oh, oh, oh);
  const oFlt = new THREE.Vector3(-oh, oh, oh);
  const oBlb = new THREE.Vector3(-oh, -oh, -oh);
  const oBrb = new THREE.Vector3(oh, -oh, -oh);
  const oBrt = new THREE.Vector3(oh, oh, -oh);
  const oBlt = new THREE.Vector3(-oh, oh, -oh);

  // Inner vertices (same y extents, smaller x/z)
  const innerFlb = new THREE.Vector3(-ih, -oh, ih);
  const innerFrb = new THREE.Vector3(ih, -oh, ih);
  const innerFrt = new THREE.Vector3(ih, oh, ih);
  const innerFlt = new THREE.Vector3(-ih, oh, ih);
  const innerBlb = new THREE.Vector3(-ih, -oh, -ih);
  const innerBrb = new THREE.Vector3(ih, -oh, -ih);
  const innerBrt = new THREE.Vector3(ih, oh, -ih);
  const innerBlt = new THREE.Vector3(-ih, oh, -ih);

  const outerWalls = [
    createQuadFace([oFlb, oFrb, oFrt, oFlt]),
    createQuadFace([oBrb, oBlb, oBlt, oBrt]),
    createQuadFace([oFrb, oBrb, oBrt, oFrt]),
    createQuadFace([oBlb, oFlb, oFlt, oBlt]),
  ];

  // Reversed winding — normals point inward toward cavity center
  const innerWalls = [
    createQuadFace([innerFrb, innerFlb, innerFlt, innerFrt]),
    createQuadFace([innerBlb, innerBrb, innerBrt, innerBlt]),
    createQuadFace([innerBrb, innerFrb, innerFrt, innerBrt]),
    createQuadFace([innerFlb, innerBlb, innerBlt, innerFlt]),
  ];

  const topRim = [
    createQuadFace([oFlt, oFrt, innerFrt, innerFlt]),
    createQuadFace([oBrt, oBlt, innerBlt, innerBrt]),
    createQuadFace([oFrt, oBrt, innerBrt, innerFrt]),
    createQuadFace([oBlt, oFlt, innerFlt, innerBlt]),
  ];

  const bottomRim = [
    createQuadFace([oFrb, oFlb, innerFlb, innerFrb]),
    createQuadFace([oBlb, oBrb, innerBrb, innerBlb]),
    createQuadFace([oBrb, oFrb, innerFrb, innerBrb]),
    createQuadFace([oFlb, oBlb, innerBlb, innerFlb]),
  ];

  return [...outerWalls, ...innerWalls, ...topRim, ...bottomRim];
}

describe('isClosedManifold', () => {
  it('should identify a single BoxGeometry as closed', () => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const result = isClosedManifold([box]);

    expect(result.closed).toBe(true);
    expect(result.openEdges).toBe(0);
  });

  it('should identify a single quad face as NOT closed', () => {
    const face = createQuadFace([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(1, 1, 0),
      new THREE.Vector3(0, 1, 0),
    ]);
    const result = isClosedManifold([face]);

    expect(result.closed).toBe(false);
    expect(result.openEdges).toBeGreaterThan(0);
  });

  it('should identify six decomposed box faces as closed', () => {
    const faces = createDecomposedBox(1);
    const result = isClosedManifold(faces);

    expect(result.closed).toBe(true);
    expect(result.openEdges).toBe(0);
  });

  it('should identify five faces of a box (missing one) as NOT closed', () => {
    const faces = createDecomposedBox(1);
    faces.pop();
    const result = isClosedManifold(faces);

    expect(result.closed).toBe(false);
    expect(result.openEdges).toBeGreaterThan(0);
  });

  it('should identify hollow box shell WITH rim faces as closed', () => {
    const faces = createHollowBoxFaces(2, 1.5);
    const result = isClosedManifold(faces);

    expect(result.closed).toBe(true);
    expect(result.openEdges).toBe(0);
  });

  it('should identify hollow box shell WITHOUT rim faces as NOT closed', () => {
    const faces = createHollowBoxFaces(2, 1.5);
    // Remove all 8 rim faces (last 8 in the array: 4 top + 4 bottom)
    const openFaces = faces.slice(0, -8);
    const result = isClosedManifold(openFaces);

    expect(result.closed).toBe(false);
    expect(result.openEdges).toBeGreaterThan(0);
  });

  it('should identify hollow box WITHOUT bottom rim as NOT closed', () => {
    const faces = createHollowBoxFaces(2, 1.5);
    // Remove only the 4 bottom rim faces (last 4) — top is closed, bottom is open
    const openBottomFaces = faces.slice(0, -4);
    const result = isClosedManifold(openBottomFaces);

    expect(result.closed).toBe(false);
    expect(result.openEdges).toBeGreaterThan(0);
  });

  it('should handle empty geometry array', () => {
    const result = isClosedManifold([]);

    expect(result.closed).toBe(true);
    expect(result.openEdges).toBe(0);
    expect(result.totalEdges).toBe(0);
  });

  it('should handle indexed geometry', () => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    expect(box.getIndex()).not.toBeNull();

    const result = isClosedManifold([box]);
    expect(result.closed).toBe(true);
  });
});

describe('enforceMaterialClipping', () => {
  it('should set clippingPlanes when material has none (post-applyMatcap scenario)', () => {
    const mesh = createDoubleSidedMesh();
    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat.clippingPlanes).toBeNull();

    enforceMaterialClipping([mesh], testPlane, true);

    expect(mat.clippingPlanes).toHaveLength(1);
    expect(mat.clippingPlanes![0]).toBe(testPlane);
  });

  it('should be a no-op when clippingPlanes already reference the correct plane', () => {
    const mesh = createDoubleSidedMesh();
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const existingPlanes = [testPlane];
    mat.clippingPlanes = existingPlanes;

    enforceMaterialClipping([mesh], testPlane, true);

    expect(mat.clippingPlanes).toBe(existingPlanes);
  });

  it('should replace clippingPlanes when they reference a different plane', () => {
    const mesh = createDoubleSidedMesh();
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const stalePlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 5);
    mat.clippingPlanes = [stalePlane];

    enforceMaterialClipping([mesh], testPlane, true);

    expect(mat.clippingPlanes).toHaveLength(1);
    expect(mat.clippingPlanes[0]).toBe(testPlane);
  });

  it('should clear clippingPlanes when enableMesh is false', () => {
    const mesh = createDoubleSidedMesh();
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.clippingPlanes = [testPlane];

    enforceMaterialClipping([mesh], testPlane, false);

    expect(mat.clippingPlanes).toHaveLength(0);
  });

  it('should be a no-op when enableMesh is false and clippingPlanes already empty', () => {
    const mesh = createDoubleSidedMesh();
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.clippingPlanes = [];

    enforceMaterialClipping([mesh], testPlane, false);

    expect(mat.clippingPlanes).toHaveLength(0);
  });

  it('should handle mesh with material array', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const materials = [
      new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }),
      new THREE.MeshStandardMaterial({ side: THREE.FrontSide }),
    ];
    const mesh = new THREE.Mesh(geometry, materials);

    enforceMaterialClipping([mesh], testPlane, true);

    expect(materials[0]!.clippingPlanes).toHaveLength(1);
    expect(materials[0]!.clippingPlanes![0]).toBe(testPlane);
    expect(materials[1]!.clippingPlanes).toHaveLength(1);
    expect(materials[1]!.clippingPlanes![0]).toBe(testPlane);
  });

  it('should handle multiple meshes', () => {
    const mesh1 = createDoubleSidedMesh();
    const mesh2 = createFrontSidedMesh();

    enforceMaterialClipping([mesh1, mesh2], testPlane, true);

    const mat1 = mesh1.material as THREE.MeshStandardMaterial;
    const mat2 = mesh2.material as THREE.MeshStandardMaterial;
    expect(mat1.clippingPlanes).toHaveLength(1);
    expect(mat2.clippingPlanes).toHaveLength(1);
  });
});
