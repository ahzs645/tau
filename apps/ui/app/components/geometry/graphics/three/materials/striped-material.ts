import * as THREE from 'three';
import type { ResolvedGraphicsBackend } from '#constants/editor.constants.js';
import { createStripedNodeMaterial } from '#components/geometry/graphics/three/materials/striped-material.node.js';
import type { StripedMaterialProperties } from '#components/geometry/graphics/three/materials/striped-material.types.js';

/* oxlint-disable-next-line no-barrel-files/no-barrel-files -- façade consumers resolve `StripedMaterialProperties` from this module */
export type { StripedMaterialProperties } from '#components/geometry/graphics/three/materials/striped-material.types.js';

/**
 * Creates a striped material for cap planes.
 *
 * Default behavior: diagonal stripes that are locked to the cap plane's
 * surface (object space), so they do not slide when the camera moves.
 *
 * This material uses stencil operations for cross-section capping, ensuring it only
 * renders at mesh/plane intersections when used with the Cutter component.
 *
 * @param properties - Configuration options for the striped material
 * @param properties.stripeFrequency - Distance between stripes in plane units (same units as geometry)
 * @param properties.baseColor - Base color of the material
 * @param properties.stripeColor - Color of the stripes
 * @returns A THREE.ShaderMaterial with striped pattern
 */
export function createStripedMaterial(properties?: StripedMaterialProperties): THREE.ShaderMaterial {
  const {
    stripeFrequency = 2,
    stripeWidth = 0.25,
    baseColor = 0xdd_dd_dd,
    stripeColor = 0xbb_bb_bb,
    stripeAngle = Math.PI / 4,
  } = properties ?? {};

  const stripedMaterial = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Three.js API naming
    stencilZFail: THREE.ReplaceStencilOp,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Three.js API naming
    stencilZPass: THREE.ReplaceStencilOp,
    uniforms: {
      uBaseColor: {
        value: new THREE.Color(baseColor),
      },
      uStripeFrequency: {
        value: stripeFrequency,
      },
      uStripeColor: {
        value: new THREE.Color(stripeColor),
      },
      uStripeWidth: {
        value: stripeWidth,
      },
      uStripeAngle: {
        value: stripeAngle,
      },
    },

    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      
      varying vec2 vSurfacePos; // plane-local XY in geometry units
      
      void main() {
        vSurfacePos = position.xy; // lock pattern to the plane surface
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        
        #include <logdepthbuf_vertex>
      }
    `,

    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      
      uniform vec3 uBaseColor;
      uniform float uStripeFrequency;
      uniform vec3 uStripeColor;
      uniform float uStripeWidth;
      uniform float uStripeAngle;
      
      varying vec2 vSurfacePos;
      
      mat2 rotation2D(float angle) {
        float s = sin(angle);
        float c = cos(angle);
        return mat2(c, -s, s, c);
      }
      
      void main() {
        #include <logdepthbuf_fragment>
        
        // Rotate plane-local coordinates so the stripes are anchored to the plane
        vec2 rotated = rotation2D(uStripeAngle) * vSurfacePos;
        float pattern = mod(rotated.y, uStripeFrequency);
        
        // Antialiased stripe edge using screen-space derivatives
        float aa = fwidth(pattern) * 1.5;
        float stripeMask = smoothstep(uStripeWidth - aa, uStripeWidth + aa, pattern);
        vec3 finalColor = mix(uStripeColor, uBaseColor, stripeMask);
        
        gl_FragColor = vec4(finalColor, 1.0);
      }
    `,
  });

  return stripedMaterial;
}

/**
 * Discriminated striped cap material factory for dual WebGL/WebGPU stacks.
 */
export function createStripedMaterialForBackend(
  backend: ResolvedGraphicsBackend,
  properties?: StripedMaterialProperties,
): THREE.Material {
  if (backend === 'webgpu') {
    return createStripedNodeMaterial(properties);
  }

  return createStripedMaterial(properties);
}
