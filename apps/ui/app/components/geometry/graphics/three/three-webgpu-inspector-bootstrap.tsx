import type { ReactNode } from 'react';
import { useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Inspector } from 'three/addons/inspector/Inspector.js';
import type { WebGPURenderer } from 'three/webgpu';

/**
 * Default export for `React.lazy`: mounts Three.js {@link Inspector} on the shared WebGPU renderer.
 *
 * Implemented in its own module so Vite splits the bulky inspector bundle from the CAD viewer baseline.
 */
export default function ThreeWebGpuInspectorBootstrap(): ReactNode {
  const { gl } = useThree();

  useLayoutEffect(() => {
    if (!('isWebGPURenderer' in gl) || !gl.isWebGPURenderer) {
      return undefined;
    }

    const gpuRenderer = gl as unknown as WebGPURenderer;

    /** Prior inspector attachment (typically `InspectorBase` from three.js). */
    const previousInspector: unknown = gpuRenderer.inspector;

    const inspector = new Inspector();

    gpuRenderer.inspector = inspector;
    globalThis.document.body.append(inspector.domElement);

    return (): void => {
      inspector.hide();

      inspector.domElement.remove();

      gpuRenderer.inspector = previousInspector as WebGPURenderer['inspector'];
    };
  }, [gl]);

  return undefined;
}
