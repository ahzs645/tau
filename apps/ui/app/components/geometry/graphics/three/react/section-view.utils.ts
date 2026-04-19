import * as THREE from 'three';
import { LineSegments2 } from 'three/addons';

type ClipMeshOptions = {
  readonly enable: boolean;
  readonly plane: THREE.Plane;
};

/**
 * Applies or removes clipping planes on a mesh's materials.
 *
 * Materials keep their original `side` property (typically DoubleSide from GLTF).
 * The stencil capping technique relies on DoubleSide so that back faces render at
 * the clipping boundary, providing a solid appearance at the cross-section.
 */
export function applyMeshClipping(mesh: THREE.Mesh, options: ClipMeshOptions): void {
  const { enable, plane } = options;
  const materials: THREE.Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

  for (const mat of materials) {
    mat.clippingPlanes = enable ? [plane] : [];
  }
}

type CollectAndClipOptions = {
  readonly enableSection: boolean;
  readonly enableLines: boolean;
  readonly enableMesh: boolean;
  readonly plane: THREE.Plane;
};

/**
 * Traverses a root group to collect meshes for stencil capping and apply
 * clipping planes to all relevant objects. Returns the list of solid meshes
 * that should participate in stencil capping.
 *
 * - `LineSegments` and `LineSegments2` are clipped via `enableLines` but
 *   never included in the mesh list (they don't get caps).
 * - Solid `THREE.Mesh` objects are clipped via `enableMesh` and always
 *   included in the mesh list (capping is independent of surface clipping).
 * - When `enableSection` is false, all clipping planes are removed.
 */
export function collectAndClipMeshes(rootGroup: THREE.Group, options: CollectAndClipOptions): THREE.Mesh[] {
  const { enableSection, enableLines, enableMesh, plane } = options;

  if (!enableSection) {
    rootGroup.traverse((child: THREE.Object3D) => {
      const isMeshOrLine = child instanceof THREE.Mesh || child instanceof THREE.LineSegments;

      if (isMeshOrLine && child.material) {
        if (Array.isArray(child.material)) {
          for (const mat of child.material) {
            mat.clippingPlanes = [];
          }
        } else {
          child.material.clippingPlanes = [];
        }
      }
    });

    return [];
  }

  const meshChildren: THREE.Mesh[] = [];

  rootGroup.traverse((child: THREE.Object3D) => {
    if (child instanceof THREE.LineSegments) {
      if (child.material) {
        if (Array.isArray(child.material)) {
          for (const mat of child.material) {
            mat.clippingPlanes = enableLines ? [plane] : [];
          }
        } else {
          child.material.clippingPlanes = enableLines ? [plane] : [];
        }
      }

      return;
    }

    if (child instanceof LineSegments2) {
      if (Array.isArray(child.material)) {
        for (const mat of child.material) {
          mat.clippingPlanes = enableLines ? [plane] : [];
        }
      } else {
        child.material.clippingPlanes = enableLines ? [plane] : [];
      }

      return;
    }

    if (child instanceof THREE.Mesh && child.material && child.geometry) {
      child.matrixAutoUpdate = false;

      applyMeshClipping(child as THREE.Mesh, {
        enable: enableMesh,
        plane,
      });

      // oxlint-disable-next-line @typescript-eslint/no-unsafe-argument -- Mesh type generics are complex
      meshChildren.push(child);
    }
  });

  return meshChildren;
}

/**
 * Per-frame guard that ensures mesh materials retain the expected clipping planes.
 *
 * Material replacement operations (matcap toggle, GLTF reload) create new materials
 * that lack `clippingPlanes`. This function detects the mismatch and re-applies them.
 * When clipping is already correct, the reference identity check makes this a no-op.
 */
export function enforceMaterialClipping(meshes: THREE.Mesh[], plane: THREE.Plane, enableMesh: boolean): void {
  for (const mesh of meshes) {
    const materials: THREE.Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

    for (const mat of materials) {
      if (enableMesh) {
        if (!mat.clippingPlanes?.length || mat.clippingPlanes[0] !== plane) {
          mat.clippingPlanes = [plane];
        }
      } else if (mat.clippingPlanes?.length) {
        mat.clippingPlanes = [];
      }
    }
  }
}

type EdgeKey = string;

function quantize(value: number, precision = 1e-6): number {
  return Math.round(value / precision) * precision;
}

function vertexKey(x: number, y: number, z: number): string {
  return `${quantize(x)},${quantize(y)},${quantize(z)}`;
}

function makeEdgeKey(aKey: string, bKey: string): EdgeKey {
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

type ManifoldResult = {
  readonly closed: boolean;
  readonly openEdges: number;
  readonly totalEdges: number;
};

/**
 * Checks whether a set of triangle geometries together form a closed
 * (watertight) manifold by verifying that every edge is shared by exactly
 * 2 triangles.
 *
 * For the stencil-based capping algorithm to produce correct results, the
 * geometry must be a closed manifold so that front/back face stencil
 * contributions balance to zero at every pixel outside the cross-section.
 */
export function isClosedManifold(geometries: THREE.BufferGeometry[]): ManifoldResult {
  const edgeCounts = new Map<EdgeKey, number>();

  for (const geometry of geometries) {
    const positionAttribute = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!positionAttribute) {
      continue;
    }

    const index = geometry.getIndex();

    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const i0 = index.getX(i);
        const i1 = index.getX(i + 1);
        const i2 = index.getX(i + 2);

        const v0 = vertexKey(positionAttribute.getX(i0), positionAttribute.getY(i0), positionAttribute.getZ(i0));
        const v1 = vertexKey(positionAttribute.getX(i1), positionAttribute.getY(i1), positionAttribute.getZ(i1));
        const v2 = vertexKey(positionAttribute.getX(i2), positionAttribute.getY(i2), positionAttribute.getZ(i2));

        const edge0 = makeEdgeKey(v0, v1);
        const edge1 = makeEdgeKey(v1, v2);
        const edge2 = makeEdgeKey(v2, v0);

        edgeCounts.set(edge0, (edgeCounts.get(edge0) ?? 0) + 1);
        edgeCounts.set(edge1, (edgeCounts.get(edge1) ?? 0) + 1);
        edgeCounts.set(edge2, (edgeCounts.get(edge2) ?? 0) + 1);
      }
    } else {
      for (let i = 0; i < positionAttribute.count; i += 3) {
        const v0 = vertexKey(positionAttribute.getX(i), positionAttribute.getY(i), positionAttribute.getZ(i));
        const v1 = vertexKey(
          positionAttribute.getX(i + 1),
          positionAttribute.getY(i + 1),
          positionAttribute.getZ(i + 1),
        );
        const v2 = vertexKey(
          positionAttribute.getX(i + 2),
          positionAttribute.getY(i + 2),
          positionAttribute.getZ(i + 2),
        );

        const edge0 = makeEdgeKey(v0, v1);
        const edge1 = makeEdgeKey(v1, v2);
        const edge2 = makeEdgeKey(v2, v0);

        edgeCounts.set(edge0, (edgeCounts.get(edge0) ?? 0) + 1);
        edgeCounts.set(edge1, (edgeCounts.get(edge1) ?? 0) + 1);
        edgeCounts.set(edge2, (edgeCounts.get(edge2) ?? 0) + 1);
      }
    }
  }

  let openEdges = 0;
  for (const count of edgeCounts.values()) {
    if (count !== 2) {
      openEdges++;
    }
  }

  return {
    closed: openEdges === 0,
    openEdges,
    totalEdges: edgeCounts.size,
  };
}
