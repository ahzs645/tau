import { DoubleSide, NotEqualStencilFunc, ReplaceStencilOp, Color } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { cos, float, Fn, fwidth, mix, mod, mul, positionLocal, sin, smoothstep, uniform, vec3 } from 'three/tsl';
import type { StripedMaterialProperties } from '#components/geometry/graphics/three/materials/striped-material.types.js';

/* oxlint-disable eslint(new-cap) -- three/tsl `Fn()` builds node graphs via factory calls */

/** WebGPU/TSL analogue of {@link createStripedMaterial}. */
export function createStripedNodeMaterial(properties?: StripedMaterialProperties): MeshBasicNodeMaterial {
  const {
    stripeFrequency = 2,
    stripeWidth = 0.25,
    baseColor = 0xdd_dd_dd,
    stripeColor = 0xbb_bb_bb,
    stripeAngle = Math.PI / 4,
  } = properties ?? {};

  const uBaseColor = uniform(new Color(baseColor));
  const uStripeColor = uniform(new Color(stripeColor));
  const uStripeFrequency = uniform(stripeFrequency);
  const uStripeWidth = uniform(stripeWidth);
  const uStripeAngle = uniform(stripeAngle);

  const material = new MeshBasicNodeMaterial({
    side: DoubleSide,
    transparent: true,
  });

  material.stencilWrite = true;
  material.stencilRef = 0;
  material.stencilFunc = NotEqualStencilFunc;
  material.stencilFail = ReplaceStencilOp;
  material.stencilZFail = ReplaceStencilOp;
  material.stencilZPass = ReplaceStencilOp;

  material.colorNode = Fn(() => {
    const surfacePlane = positionLocal.xy.toVar('surfaceXY');

    const cAngle = cos(uStripeAngle);
    const sAngle = sin(uStripeAngle);
    const rotatedY = mul(surfacePlane.x, sAngle).add(mul(surfacePlane.y, cAngle)).toVar('rotatedY');

    const pattern = mod(rotatedY, uStripeFrequency).toVar('pattern');
    const aa = mul(fwidth(pattern), float(1.5)).toVar('aa');

    const stripeMask = smoothstep(uStripeWidth.sub(aa), uStripeWidth.add(aa), pattern);

    return vec3(mix(uStripeColor, uBaseColor, stripeMask));
  })();

  return material;
}
