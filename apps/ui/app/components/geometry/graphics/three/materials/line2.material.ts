/* oxlint-disable typescript-eslint/ban-ts-comment -- verbatim port of three.js Line2NodeMaterial.setup; TS cannot type the TSL graph body */
// @ts-nocheck -- verbatim port of three r184 Line2NodeMaterial.setup; @types/three collapses TSL generics to never

/* oxlint-disable eslint(new-cap) -- three/tsl `Fn`/`If`/`ElseIf`/`Else` are shader graph factories */
/* oxlint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- verbatim three.js Line2NodeMaterial.setup port; three/tsl node graph is loosely typed vs strict Oxlint inference */
/* oxlint-disable unicorn-js/no-zero-fractions -- numeric literals match upstream Line2NodeMaterial.js */
/* oxlint-disable unicorn-js/prevent-abbreviations -- identifiers match upstream Line2NodeMaterial.js */

import type { Line2NodeMaterialParameters as ThreeLine2NodeMaterialParameters } from 'three/webgpu';
import { Line2NodeMaterial as ThreeLine2NodeMaterial } from 'three/webgpu';
import {
  attribute,
  cameraNear,
  cameraProjectionMatrix,
  dashSize,
  float,
  Fn,
  gapSize,
  If,
  materialColor,
  materialLineDashOffset,
  materialLineDashSize,
  materialLineGapSize,
  materialLineScale,
  materialLineWidth,
  materialOpacity,
  mix,
  modelViewMatrix,
  positionGeometry,
  screenDPR,
  smoothstep,
  uv,
  vec2,
  vec3,
  vec4,
  varyingProperty,
  viewport,
  viewportOpaqueMipTexture,
} from 'three/tsl';

/**
 * Fat-line node material for overlays on the WebGPU viewport (`reversedDepthBuffer: true`).
 *
 * **Divergence**: three.js `Line2NodeMaterial` estimates the camera near plane as
 * `projectionMatrix[3][2] * -0.5 / projectionMatrix[2][2]`, which collapses to `-far/2`
 * under reversed-Z perspective. Long segments with an endpoint behind the camera then
 * get an invalid trim `alpha` and `mix()` flips the line into the opposite hemisphere
 * (viewport axes at `size ≈ 50_000`, typical CAD camera distances).
 *
 * This subclass uses TSL **`cameraNear`** so the near estimate stays **`-camera.near`** in
 * camera space for both standard and reversed depth buffers.
 *
 * @see `docs/policy/webgpu-rendering-pipeline.md`
 * @see `docs/research/webgpu-line2-reversed-z-trim.md`
 */
export class Line2NodeMaterial extends ThreeLine2NodeMaterial {
  /** @inheritdoc */
  public static override get type(): string {
    return 'Line2NodeMaterial';
  }

  public constructor(parameters?: ThreeLine2NodeMaterialParameters) {
    super(parameters);
  }

  /** @inheritdoc */
  public override setup(builder: unknown): void {
    const self = this as any;
    const { renderer } = builder as { readonly renderer: { readonly currentSamples: number } };

    const useAlphaToCoverage = self._useAlphaToCoverage as boolean;
    const vertexColors = self.vertexColors as boolean | undefined;
    const useDash = self._useDash as boolean;
    const useWorldUnits = self._useWorldUnits as boolean;

    const trimSegment = Fn(({ start, end }: { readonly start: any; readonly end: any }) => {
      const nearEstimate = cameraNear.negate();
      const alpha = nearEstimate.sub(start.z).div(end.z.sub(start.z));
      return vec4(mix(start.xyz, end.xyz, alpha), end.w);
    }).setLayout({
      name: 'trimSegmentCameraNear',
      type: 'vec4',
      inputs: [
        { name: 'start', type: 'vec4' },
        { name: 'end', type: 'vec4' },
      ],
    });

    self.vertexNode = Fn(() => {
      const instanceStart = attribute('instanceStart');
      const instanceEnd = attribute('instanceEnd');

      const start = vec4(modelViewMatrix.mul(vec4(instanceStart, 1.0))).toVar('start');
      const end = vec4(modelViewMatrix.mul(vec4(instanceEnd, 1.0))).toVar('end');

      if (useDash) {
        const dashScaleNode = self.dashScaleNode ? float(self.dashScaleNode) : materialLineScale;
        const offsetNode = self.offsetNode ? float(self.offsetNode) : materialLineDashOffset;

        const instanceDistanceStart = attribute('instanceDistanceStart');
        const instanceDistanceEnd = attribute('instanceDistanceEnd');

        let lineDistance = positionGeometry.y
          .lessThan(0.5)
          .select(dashScaleNode.mul(instanceDistanceStart), dashScaleNode.mul(instanceDistanceEnd));
        lineDistance = lineDistance.add(offsetNode);

        varyingProperty('float', 'lineDistance').assign(lineDistance);
      }

      if (useWorldUnits) {
        varyingProperty('vec3', 'worldStart').assign(start.xyz);
        varyingProperty('vec3', 'worldEnd').assign(end.xyz);
      }

      const aspect = viewport.z.div(viewport.w);

      const perspective = cameraProjectionMatrix.element(2).element(3).equal(-1.0);

      If(perspective, () => {
        If(start.z.lessThan(0.0).and(end.z.greaterThan(0.0)), () => {
          end.assign(trimSegment({ start, end }));
        }).ElseIf(end.z.lessThan(0.0).and(start.z.greaterThanEqual(0.0)), () => {
          start.assign(trimSegment({ start: end, end: start }));
        });
      });

      const clipStart = cameraProjectionMatrix.mul(start);
      const clipEnd = cameraProjectionMatrix.mul(end);

      const ndcStart = clipStart.xyz.div(clipStart.w);
      const ndcEnd = clipEnd.xyz.div(clipEnd.w);

      const dir = ndcEnd.xy.sub(ndcStart.xy).toVar();

      dir.x.assign(dir.x.mul(aspect));
      dir.assign(dir.normalize());

      const clip = vec4().toVar();

      if (useWorldUnits) {
        const worldDir = end.xyz.sub(start.xyz).normalize();
        const tmpFwd = mix(start.xyz, end.xyz, 0.5).normalize();
        const worldUp = worldDir.cross(tmpFwd).normalize();
        const worldFwd = worldDir.cross(worldUp);

        const worldPos = varyingProperty('vec4', 'worldPos');

        worldPos.assign(positionGeometry.y.lessThan(0.5).select(start, end));

        const hw = materialLineWidth.mul(0.5);
        worldPos.addAssign(vec4(positionGeometry.x.lessThan(0.0).select(worldUp.mul(hw), worldUp.mul(hw).negate()), 0));

        if (!useDash) {
          worldPos.addAssign(
            vec4(positionGeometry.y.lessThan(0.5).select(worldDir.mul(hw).negate(), worldDir.mul(hw)), 0),
          );

          worldPos.addAssign(vec4(worldFwd.mul(hw), 0));

          If(positionGeometry.y.greaterThan(1.0).or(positionGeometry.y.lessThan(0.0)), () => {
            worldPos.subAssign(vec4(worldFwd.mul(2.0).mul(hw), 0));
          });
        }

        clip.assign(cameraProjectionMatrix.mul(worldPos));

        const clipPose = vec3().toVar();

        clipPose.assign(positionGeometry.y.lessThan(0.5).select(ndcStart, ndcEnd));
        clip.z.assign(clipPose.z.mul(clip.w));
      } else {
        const offset = vec2(dir.y, dir.x.negate()).toVar('offset');

        dir.x.assign(dir.x.div(aspect));
        offset.x.assign(offset.x.div(aspect));

        offset.assign(positionGeometry.x.lessThan(0.0).select(offset.negate(), offset));

        If(positionGeometry.y.lessThan(0.0), () => {
          offset.assign(offset.sub(dir));
        }).ElseIf(positionGeometry.y.greaterThan(1.0), () => {
          offset.assign(offset.add(dir));
        });

        offset.assign(offset.mul(materialLineWidth));

        offset.assign(offset.div(viewport.w.div(screenDPR)));

        clip.assign(positionGeometry.y.lessThan(0.5).select(clipStart, clipEnd));

        offset.assign(offset.mul(clip.w));

        clip.assign(clip.add(vec4(offset, 0, 0)));
      }

      return clip;
    })();

    const closestLineToLine = Fn(
      ({ p1, p2, p3, p4 }: { readonly p1: any; readonly p2: any; readonly p3: any; readonly p4: any }) => {
        const p13 = p1.sub(p3);
        const p43 = p4.sub(p3);

        const p21 = p2.sub(p1);

        const d1343 = p13.dot(p43);
        const d4321 = p43.dot(p21);
        const d1321 = p13.dot(p21);
        const d4343 = p43.dot(p43);
        const d2121 = p21.dot(p21);

        const denom = d2121.mul(d4343).sub(d4321.mul(d4321));
        const numer = d1343.mul(d4321).sub(d1321.mul(d4343));

        const mua = numer.div(denom).clamp();
        const mub = d1343.add(d4321.mul(mua)).div(d4343).clamp();

        return vec2(mua, mub);
      },
    );

    self.colorNode = Fn(() => {
      const vUv = uv();

      if (useDash) {
        const dashSizeNode = self.dashSizeNode ? float(self.dashSizeNode) : materialLineDashSize;
        const gapSizeNode = self.gapSizeNode ? float(self.gapSizeNode) : materialLineGapSize;

        dashSize.assign(dashSizeNode);
        gapSize.assign(gapSizeNode);

        const vLineDistance = varyingProperty('float', 'lineDistance');

        vUv.y.lessThan(-1.0).or(vUv.y.greaterThan(1.0)).discard();

        vLineDistance.mod(dashSize.add(gapSize)).greaterThan(dashSize).discard();
      }

      const alpha = float(1).toVar('alpha');

      if (useWorldUnits) {
        const worldStart = varyingProperty('vec3', 'worldStart');
        const worldEnd = varyingProperty('vec3', 'worldEnd');

        const rayEnd = varyingProperty('vec4', 'worldPos').xyz.normalize().mul(1e5);
        const lineDir = worldEnd.sub(worldStart);
        const params = closestLineToLine({ p1: worldStart, p2: worldEnd, p3: vec3(0.0, 0.0, 0.0), p4: rayEnd });

        const pPoint1 = worldStart.add(lineDir.mul(params.x));
        const pPoint2 = rayEnd.mul(params.y);
        const delta = pPoint1.sub(pPoint2);
        const len = delta.length();
        const norm = len.div(materialLineWidth);

        if (!useDash) {
          if (useAlphaToCoverage && renderer.currentSamples > 0) {
            const dnorm = norm.fwidth();
            alpha.assign(smoothstep(dnorm.negate().add(0.5), dnorm.add(0.5), norm).oneMinus());
          } else {
            norm.greaterThan(0.5).discard();
          }
        }
      } else if (useAlphaToCoverage && renderer.currentSamples > 0) {
        const aUv = vUv.x;
        const bUv = vUv.y.greaterThan(0.0).select(vUv.y.sub(1.0), vUv.y.add(1.0));

        const len2 = aUv.mul(aUv).add(bUv.mul(bUv));

        const dlen = float(len2.fwidth()).toVar('dlen');

        If(vUv.y.abs().greaterThan(1.0), () => {
          alpha.assign(smoothstep(dlen.oneMinus(), dlen.add(1), len2).oneMinus());
        });
      } else {
        If(vUv.y.abs().greaterThan(1.0), () => {
          const rcA = vUv.x;
          const rcB = vUv.y.greaterThan(0.0).select(vUv.y.sub(1.0), vUv.y.add(1.0));
          const rcLen2 = rcA.mul(rcA).add(rcB.mul(rcB));

          rcLen2.greaterThan(1.0).discard();
        });
      }

      let lineColorNode;

      if (self.lineColorNode) {
        lineColorNode = self.lineColorNode;
      } else if (vertexColors) {
        const instanceColorStart = attribute('instanceColorStart');
        const instanceColorEnd = attribute('instanceColorEnd');

        const instanceColor = positionGeometry.y.lessThan(0.5).select(instanceColorStart, instanceColorEnd);

        lineColorNode = instanceColor.mul(materialColor);
      } else {
        lineColorNode = materialColor;
      }

      return vec4(lineColorNode, alpha);
    })();

    if (self.transparent) {
      const opacityNode = self.opacityNode ? float(self.opacityNode) : materialOpacity;

      self.outputNode = vec4(
        self.colorNode.rgb.mul(opacityNode).add(viewportOpaqueMipTexture().rgb.mul(opacityNode.oneMinus())),
        self.colorNode.a,
      );
    }

    // Skip `ThreeLine2NodeMaterial.setup` (which would rebuild `vertexNode`/`colorNode`/`outputNode`
    // with the upstream broken `nearEstimate = b * -0.5 / a` trim — wiping the corrected graph)
    // and call the grandparent `NodeMaterial.setup` directly to wire the vertex/fragment stages.
    // Use `ThreeLine2NodeMaterial`'s prototype chain (not a fresh `NodeMaterial` import binding) so a
    // duplicate `three/webgpu` graph cannot desynchronise `.prototype` identity across modules.
    Reflect.apply(Object.getPrototypeOf(ThreeLine2NodeMaterial.prototype).setup, this, [builder]);
  }
}
