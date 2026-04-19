/**
 * Credit to https://github.com/r3f-cutter/r3f-cutter for the original implementation.
 *
 * This has been modified to support conditional cutting of meshes and lines.
 */

import * as React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { Plane } from '@react-three/drei';
import {
  collectAndClipMeshes,
  enforceMaterialClipping,
} from '#components/geometry/graphics/three/react/section-view.utils.js';
import { sceneTag, sceneTagData } from '#components/geometry/graphics/three/utils/scene-tags.js';

// Reusable temporaries for per-frame plane positioning (avoids GC pressure)
const _defaultNormal = new THREE.Vector3(0, 0, 1);
const _quaternion = new THREE.Quaternion();
const _worldPosition = new THREE.Vector3();

export type CutterProperties = {
  readonly children: React.ReactNode;
  readonly plane: THREE.Plane;
  readonly enableSection?: boolean;
  readonly enableLines?: boolean;
  readonly enableMesh?: boolean;
  readonly cappingMaterial: THREE.Material;
};

type PlaneStencilGroupProperties = {
  readonly meshObj: THREE.Mesh;
  readonly plane: THREE.Plane;
  readonly renderOrder: number;
};

export const SectionView = React.forwardRef<{ update: () => void }, CutterProperties>(
  (
    { children, plane, enableSection = true, enableLines = true, enableMesh = true, cappingMaterial },
    ref,
  ): React.JSX.Element => {
    const { gl } = useThree();
    const rootGroupRef = React.useRef<THREE.Group>(null);

    const [meshList, setMeshList] = React.useState<THREE.Mesh[]>([]);
    const [planeSize, setPlaneSize] = React.useState(10);
    // Track the previous set of mesh IDs to avoid unnecessary setMeshList calls
    // when only clipping plane values changed (the mesh list itself is stable).
    const previousMeshIdsRef = React.useRef<string>('');

    const update: () => void = React.useCallback(() => {
      const rootGroup = rootGroupRef.current;

      if (!enableSection) {
        setMeshList([]);

        if (rootGroup) {
          collectAndClipMeshes(rootGroup, {
            enableSection: false,
            enableLines,
            enableMesh,
            plane,
          });
        }

        return;
      }

      if (!rootGroup) {
        return;
      }

      const meshChildren = collectAndClipMeshes(rootGroup, {
        enableSection: true,
        enableLines,
        enableMesh,
        plane,
      });

      // Only update the mesh list and recompute bounds when the set of meshes
      // actually changed (not on every plane drag). The mesh list is stable during
      // plane manipulation -- only clipping plane values on materials change.
      const meshIdsKey = meshChildren.map((m) => m.id).join(',');
      if (meshIdsKey !== previousMeshIdsRef.current) {
        previousMeshIdsRef.current = meshIdsKey;

        const bbox = new THREE.Box3();
        bbox.setFromObject(rootGroup);

        const boxSize = new THREE.Vector3();
        bbox.getSize(boxSize);

        const calculatedPlaneSize = 2 * boxSize.length();
        setPlaneSize(calculatedPlaneSize);
        setMeshList(meshChildren);
      }
      // Depend on primitive values instead of plane object to avoid infinite loop
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- plane.normal and plane.constant are extracted below
    }, [
      plane.normal.x,
      plane.normal.y,
      plane.normal.z,
      plane.constant,
      enableSection,
      enableLines,
      enableMesh,
      cappingMaterial,
    ]);

    const cappingPlaneReferencesRef = React.useRef<Map<number, React.ComponentRef<typeof Plane>>>(new Map());

    useFrame(() => {
      if (!enableSection) {
        return;
      }

      if (rootGroupRef.current && cappingPlaneReferencesRef.current.size > 0) {
        _defaultNormal.set(0, 0, 1);
        _quaternion.setFromUnitVectors(_defaultNormal, plane.normal);

        plane.coplanarPoint(_worldPosition);

        const zFightingOffset = 0.1;
        _worldPosition.addScaledVector(plane.normal, -zFightingOffset);

        for (const planeObject of cappingPlaneReferencesRef.current.values()) {
          rootGroupRef.current.worldToLocal(planeObject.position.copy(_worldPosition));
          planeObject.quaternion.copy(_quaternion);
        }
      }

      enforceMaterialClipping(meshList, plane, enableMesh);
    });

    React.useEffect(() => {
      update();
    }, [update, children]);

    // While section view is active, enable local clipping in the renderer. Individual
    // materials only clip when they have non-empty clippingPlanes — safe even when
    // mesh surfaces are not clipped (enableMesh false) but stencil caps still need it.
    React.useEffect(() => {
      gl.localClippingEnabled = enableSection;

      return () => {
        gl.localClippingEnabled = false;
      };
    }, [gl, enableSection]);

    React.useImperativeHandle(ref, () => ({ update }), [update]);

    return (
      <group>
        <group ref={rootGroupRef}>{children}</group>
        {enableSection && meshList.length > 0
          ? meshList.map((meshObject, index) => (
              <React.Fragment key={meshObject.id}>
                <PlaneStencilGroup meshObj={meshObject} plane={plane} renderOrder={index + 1} />
                <Plane
                  ref={(node) => {
                    const references = cappingPlaneReferencesRef.current;
                    if (node) {
                      references.set(index, node);
                    } else {
                      references.delete(index);
                    }
                  }}
                  args={[planeSize, planeSize]}
                  renderOrder={index + 1.1}
                  material={cappingMaterial}
                  userData={sceneTagData(sceneTag.sectionViewHelper)}
                  onAfterRender={(renderer) => {
                    renderer.clearStencil();
                  }}
                />
              </React.Fragment>
            ))
          : null}
      </group>
    );
  },
);

function PlaneStencilGroup({ meshObj, plane, renderOrder }: PlaneStencilGroupProperties): React.JSX.Element {
  const groupRef = React.useRef<THREE.Group>(null);

  React.useEffect(() => {
    meshObj.updateMatrix();
    meshObj.updateMatrixWorld();
    const group = groupRef.current;
    if (!group) {
      return;
    }
    meshObj.getWorldPosition(group.position);
    meshObj.getWorldScale(group.scale);
    meshObj.getWorldQuaternion(group.quaternion);
  }, [meshObj]);

  return (
    <group ref={groupRef}>
      <mesh geometry={meshObj.geometry} renderOrder={renderOrder} userData={sceneTagData(sceneTag.sectionViewHelper)}>
        <meshBasicMaterial
          stencilWrite
          depthWrite={false}
          depthTest={false}
          colorWrite={false}
          stencilFunc={THREE.AlwaysStencilFunc}
          side={THREE.FrontSide}
          clippingPlanes={[plane]}
          stencilFail={THREE.DecrementWrapStencilOp}
          stencilZFail={THREE.DecrementWrapStencilOp}
          stencilZPass={THREE.DecrementWrapStencilOp}
        />
      </mesh>
      <mesh geometry={meshObj.geometry} renderOrder={renderOrder} userData={sceneTagData(sceneTag.sectionViewHelper)}>
        <meshBasicMaterial
          stencilWrite
          depthWrite={false}
          depthTest={false}
          colorWrite={false}
          stencilFunc={THREE.AlwaysStencilFunc}
          side={THREE.BackSide}
          clippingPlanes={[plane]}
          stencilFail={THREE.IncrementWrapStencilOp}
          stencilZFail={THREE.IncrementWrapStencilOp}
          stencilZPass={THREE.IncrementWrapStencilOp}
        />
      </mesh>
    </group>
  );
}
