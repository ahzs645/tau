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
  it('exposes depthNode for coplanar line bias (regression guard)', () => {
    const material = createWebGpuGltfFatLineMaterial();
    expect(material.depthNode).not.toBeNull();
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

  it('matches stable stripped WebGPU fat-line material JSON snapshot', async () => {
    const material = createWebGpuGltfFatLineMaterial();
    const serialised = serialiseStrippedTslGraph(material.toJSON());

    await expect(serialised).toMatchFileSnapshot(
      join(currentDirectory, '__shader-snapshots__', 'gltf-fat-line-webgpu-node-material.json'),
    );
  });
});
