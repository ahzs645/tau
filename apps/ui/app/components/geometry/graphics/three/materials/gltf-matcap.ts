import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { Mesh } from 'three';
import { DoubleSide, MeshMatcapMaterial } from 'three';
import { LineSegments2 } from 'three/addons';
import { matcapMaterial } from '#components/geometry/graphics/three/materials/matcap-material.js';

/**
 * Apply Three.js matcap to a GLTF scene, respecting vertex colors and material colors.
 *
 * Note: LineSegments2 extends Mesh but uses LineMaterial for fat line rendering.
 * We must exclude LineSegments2 from matcap application to preserve edge rendering.
 *
 * @param gltf - The GLTF scene to apply matcap to.
 */
export const applyMatcap = async (gltf: GLTF): Promise<void> => {
  // Load matcap texture
  const matcapTexture = matcapMaterial();

  gltf.scene.traverse((child) => {
    // Skip LineSegments2 - they extend Mesh but use LineMaterial for fat lines
    if (child instanceof LineSegments2) {
      return;
    }

    if ('isMesh' in child && child.isMesh) {
      const meshMatcap = new MeshMatcapMaterial({
        matcap: matcapTexture,
        side: DoubleSide,
      });
      const mesh = child as Mesh;

      const hasVertexColors = Boolean(mesh.geometry.attributes['color'] ?? mesh.geometry.attributes['COLOR_0']);

      if (hasVertexColors) {
        meshMatcap.vertexColors = true;
      } else {
        if ('color' in mesh.material) {
          const material = mesh.material as { color: { getHexString(): string } };
          meshMatcap.color.set(`#${material.color.getHexString()}`);
        }

        if ('opacity' in mesh.material) {
          const material = mesh.material as { opacity: number };
          meshMatcap.opacity = material.opacity;
          if (material.opacity < 1) {
            meshMatcap.transparent = true;
          }
        }
      }

      mesh.material = meshMatcap;
    }
  });
};
