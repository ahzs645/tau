import { useState, useEffect, useRef } from 'react';
import { GLTFLoader, LineSegments2 } from 'three/addons';
import type { Group } from 'three';
import { Vector2 } from 'three';
import { useThree } from '@react-three/fiber';
import { applyMatcap } from '#components/geometry/graphics/three/materials/gltf-matcap.js';
import {
  applyFatLineSegments,
  updateLineMaterialResolution,
} from '#components/geometry/graphics/three/materials/gltf-edges.js';

type GltfMeshDisplayProperties = {
  /**
   * The GLTF file to load.
   */
  readonly gltfFile: Uint8Array<ArrayBuffer>;
  /**
   * Whether to enable matcap material.
   */
  readonly enableMatcap: boolean;
  /**
   * Whether to enable surfaces.
   */
  readonly enableSurfaces?: boolean;
  /**
   * Whether to enable lines.
   */
  readonly enableLines?: boolean;
};

/**
 * Update visibility of surfaces and lines based on object type.
 *
 * Uses Three.js object type for identification:
 * - Mesh objects (including subclasses like SkinnedMesh, InstancedMesh) are surfaces
 * - LineSegments and LineSegments2 objects are edges
 *
 * @param scene - The GLTF scene
 * @param enableSurfaces - Whether to show surfaces
 * @param enableLines - Whether to show lines
 */
function updateVisibility(scene: Group, enableSurfaces: boolean, enableLines: boolean): void {
  scene.traverse((object) => {
    // Check line types first (LineSegments2 has custom type)
    if (object.type === 'LineSegments' || object instanceof LineSegments2) {
      object.visible = enableLines;
    } else if ('isMesh' in object && object.isMesh) {
      // `isMesh` is true for Mesh, SkinnedMesh, InstancedMesh, etc.
      object.visible = enableSurfaces;
    }
  });
}

/**
 * This component renders a GLTF mesh.
 *
 * Rather than using Drei's `Gltf` component, this component is optimized for performance
 * and caters to the needs of a CAD application.
 *
 * It does the following:
 * - Supports toggling visibility of surfaces and lines via object type
 * - Supports matcap material (applied to all Mesh objects)
 * - Converts LineSegments to LineSegments2 for fat line rendering with constant screen-space width
 * - Edges are rendered as LineSegments from the GLTF (processed by edge detection middleware)
 * - Detects and prioritizes vertex colors over material colors
 *   - When vertex colors (COLOR_0 attribute) are present: uses vertex colors exclusively
 *   - When no vertex colors are present: falls back to material colors and opacity
 *
 * @param gltfFile - The GLTF file to load
 * @param enableMatcap - Whether to enable matcap material
 * @param enableSurfaces - Whether to enable surfaces
 * @param enableLines - Whether to enable lines
 * @returns A React component with Three.js primitives that renders the GLTF mesh
 */
export function GltfMesh({
  gltfFile,
  enableMatcap = true,
  enableSurfaces = true,
  enableLines = true,
}: GltfMeshDisplayProperties): React.JSX.Element | undefined {
  const [scene, setScene] = useState<Group | undefined>(undefined);
  const { size, invalidate } = useThree();

  // Memoize resolution vector to avoid creating new objects on each render
  const resolutionRef = useRef(new Vector2(size.width, size.height));

  // Update resolution when size changes
  useEffect(() => {
    resolutionRef.current.set(size.width, size.height);

    // Update LineMaterial resolution for all LineSegments2
    if (scene) {
      updateLineMaterialResolution(scene, resolutionRef.current);
      invalidate();
    }
  }, [size, scene, invalidate]);

  // Load GLTF and process scene
  useEffect(() => {
    let cancelled = false;

    const loadGltf = async (): Promise<void> => {
      try {
        const loader = new GLTFLoader();

        if (typeof SharedArrayBuffer === 'function' && gltfFile.buffer instanceof SharedArrayBuffer) {
          throw new TypeError('SharedArrayBuffer is not supported in <GltfMesh />');
        }

        const gltf = await loader.parseAsync(
          gltfFile.buffer,
          '', // Path (not needed for ArrayBuffer)
        );

        if (cancelled) {
          return;
        }

        // Convert LineSegments to LineSegments2 for fat line rendering
        applyFatLineSegments(gltf, resolutionRef.current);

        // Apply matcap material if enabled
        if (enableMatcap) {
          await applyMatcap(gltf);
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- can be set by cleanup between awaits
        if (cancelled) {
          return;
        }

        // Set initial visibility
        updateVisibility(gltf.scene, enableSurfaces, enableLines);

        setScene(gltf.scene);

        // Force R3F to re-render since we loaded the scene asynchronously
        invalidate();
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load GLTF:', error);
        }
      }
    };

    void loadGltf();

    return () => {
      cancelled = true;
    };
    // Reload GLTF when matcap changes - need fresh materials to toggle matcap
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visibility handled by separate effect
  }, [gltfFile, enableMatcap, invalidate]);

  // Toggle visibility when enableSurfaces or enableLines change
  useEffect(() => {
    if (scene) {
      updateVisibility(scene, enableSurfaces, enableLines);
      invalidate();
    }
  }, [scene, enableSurfaces, enableLines, invalidate]);

  if (!scene) {
    return undefined;
  }

  return <primitive object={scene} />;
}
