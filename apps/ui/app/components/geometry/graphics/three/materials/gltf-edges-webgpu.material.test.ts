// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Line2NodeMaterial as ThreeLine2NodeMaterial } from 'three/webgpu';
import { Line2NodeMaterial } from '#components/geometry/graphics/three/materials/line2.material.js';
import { createWebGpuGltfFatLineMaterial } from '#components/geometry/graphics/three/materials/gltf-edges.js';
import { serialiseStrippedTslGraph } from '#components/geometry/graphics/three/utils/tsl-node-graph-snapshot.js';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));

describe('createWebGpuGltfFatLineMaterial TSL snapshots', () => {
  /**
   * Smoking-gun regression: the WebGPU fat-line material must apply a coplanar bias so edge
   * lines win the depth comparison against the surface they overlay. The bias used to live
   * as a hardcoded `material.depthNode = viewZToReversedPerspectiveDepth(...)` in the
   * factory, but that locked the encoder to the reversed-Z viewport and broke the log-depth
   * screenshot/offscreen renderers (occluded edges leaked through opaque surfaces). The
   * factory now sets `material.depthBias` and the renderer-aware encoder dispatch lives
   * inside `Line2NodeMaterial.setupDepth(builder)` per-frame. See
   * `docs/research/webgpu-fat-line-renderer-aware-depth.md`.
   */
  it('forwards a non-identity depthBias to Line2NodeMaterial.setupDepth (regression guard)', () => {
    const material = createWebGpuGltfFatLineMaterial();
    expect(material.depthBias).toBeGreaterThan(0);
    expect(material.depthBias).toBeLessThan(1);
  });

  /**
   * The fat-line edge material must use the in-tree `Line2NodeMaterial` (which fixes the
   * upstream `nearEstimate = b * -0.5 / a` reversed-Z trim flip — collapses to `-far/2`,
   * making any edge that crosses the camera near plane snap to the opposite hemisphere).
   * The toJSON snapshot can't catch a regression here because both classes serialise
   * `type: 'Line2NodeMaterial'` and TSL graphs aren't built until `setup()`.
   */
  it('uses the in-tree Line2NodeMaterial (reversed-Z trim fix)', () => {
    const material = createWebGpuGltfFatLineMaterial();
    expect(material).toBeInstanceOf(Line2NodeMaterial);
    expect(material.constructor).not.toBe(ThreeLine2NodeMaterial);
  });

  /**
   * Smoking-gun regression guard for the screenshot crispness gap. Upstream
   * `Line2NodeMaterial` defaults `_useAlphaToCoverage = true`, which routes endcap
   * fragments through the smoothstep + hardware alpha-to-coverage path; the
   * alpha→sample-mask conversion is vendor-defined (gpuweb/gpuweb#4867 documents
   * Qualcomm's 4×4 area-dither LUT) and produces visibly grainy edges on dithered
   * drivers vs the deterministic 5-level MSAA `discard` path WebGL takes by default.
   * The Tau factory must opt out so WebGPU joins WebGL on the discard path. See
   * `docs/research/webgpu-edge-line-crispness-gap.md`.
   */
  it('opts out of alphaToCoverage to match WebGL crispness (regression guard)', () => {
    const material = createWebGpuGltfFatLineMaterial();
    expect(material.alphaToCoverage).toBe(false);
  });

  it('matches stable stripped WebGPU fat-line material JSON snapshot', async () => {
    const material = createWebGpuGltfFatLineMaterial();
    const serialised = serialiseStrippedTslGraph(material.toJSON());

    await expect(serialised).toMatchFileSnapshot(
      join(currentDirectory, '__shader-snapshots__', 'gltf-fat-line-webgpu-node-material.json'),
    );
  });
});
