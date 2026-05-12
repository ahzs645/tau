import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { Group, LineSegments, Material, Object3D, Scene, Vector2 } from 'three';
import { InterleavedBufferAttribute } from 'three';
import { LineSegments2, LineSegmentsGeometry, LineMaterial } from 'three/addons';
import { LineSegments2 as WebGpuFatLineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { Line2NodeMaterial } from '#components/geometry/graphics/three/materials/line2.material.js';
import type { ResolvedGraphicsBackend } from '#constants/editor.constants.js';

/**
 * Default line width in pixels for edge rendering.
 * This is screen-space width, not world units.
 */
const defaultLineWidth = 1;

/**
 * Edge color for fat line materials.
 * Default: black (matching middleware)
 */
const defaultEdgeColor = 0x00_00_00;

/**
 * Depth bias multiplier shared by WebGL (`LineMaterial`) and WebGPU (`Line2NodeMaterial.depthBias`).
 *
 * **WebGL (logarithmicDepthBuffer)** — biases are appended only in the vertex shader after
 * `<logdepthbuf_vertex>`: `vFragDepth *= pow(depthBiasFactor, fovScale)` on **perspective** cameras
 * so `log2(vFragDepth)` in three's bundled fragment chunk gains a constant offset in log space.
 * Omitting `<logdepthbuf_fragment>` replacement avoids rewriting `gl_FragDepth` in the fragment
 * shader, which restores MSAA coverage compared to injecting `gl_FragDepth` manually.
 *
 * **WebGPU** — forwarded to {@link Line2NodeMaterial.depthBias}. The subclass'
 * `setupDepth(builder)` override picks the matching `viewZTo*Depth` encoder per renderer
 * (reversed-Z viewport, log-depth screenshot/offscreen, or standard perspective) so the
 * emitted depth always shares the surrounding surface rasterizer's encoding. Hardcoding a
 * single encoder at construction time was the "lines never occluded in screenshots"
 * smoking gun (see `docs/research/webgpu-fat-line-renderer-aware-depth.md`).
 *
 * **FOV adaptation (WebGL perspective only)**:
 * `fovScale = tan(fov/2)/tan(30°)`; `adjustedBias = pow(depthBiasFactor, fovScale)`.
 * Orthographic projection is intentionally not biased here (`gl_FragCoord.z` path in three's chunk);
 * defer ortho parity to a dedicated follow-up.
 *
 * Tuning trade-off (WebGL subtle bias vs ghosting): weaker bias preserves occlusion from real
 * occluders; stronger bias restores full opaque line coverage against coplanar faces.
 *
 * @see `docs/policy/webgpu-rendering-pipeline.md`
 * @see `docs/research/webgpu-fat-line-renderer-aware-depth.md`
 */
const depthBiasFactor = 0.999;

/**
 * Extract positions from indexed geometry with InterleavedBufferAttribute.
 */
function extractFromInterleavedIndexed(
  positionAttribute: InterleavedBufferAttribute,
  indices: Iterable<number>,
): number[] {
  const interleavedBuffer = positionAttribute.data;
  const { stride } = interleavedBuffer;
  const { offset } = positionAttribute;
  const { array } = interleavedBuffer;
  const positions: number[] = [];

  for (const index of indices) {
    const vertexIndex = index * stride + offset;
    const x = array[vertexIndex] ?? 0;
    const y = array[vertexIndex + 1] ?? 0;
    const z = array[vertexIndex + 2] ?? 0;
    positions.push(x, y, z);
  }

  return positions;
}

/**
 * Extract positions from non-indexed geometry with InterleavedBufferAttribute.
 */
function extractFromInterleavedNonIndexed(positionAttribute: InterleavedBufferAttribute): number[] {
  const interleavedBuffer = positionAttribute.data;
  const { stride } = interleavedBuffer;
  const { offset } = positionAttribute;
  const { array } = interleavedBuffer;
  const { count } = positionAttribute;
  const positions: number[] = [];

  for (let i = 0; i < count; i++) {
    const vertexIndex = i * stride + offset;
    const x = array[vertexIndex] ?? 0;
    const y = array[vertexIndex + 1] ?? 0;
    const z = array[vertexIndex + 2] ?? 0;
    positions.push(x, y, z);
  }

  return positions;
}

/**
 * Extract positions from indexed geometry with regular BufferAttribute.
 */
function extractFromRegularIndexed(array: Float32Array, indices: Iterable<number>): number[] {
  const positions: number[] = [];

  for (const index of indices) {
    const vertexIndex = index * 3;
    const x = array[vertexIndex] ?? 0;
    const y = array[vertexIndex + 1] ?? 0;
    const z = array[vertexIndex + 2] ?? 0;
    positions.push(x, y, z);
  }

  return positions;
}

/**
 * Extract positions from a LineSegments geometry, handling both regular and interleaved buffers.
 * Expands indexed geometry to non-indexed positions as required by LineSegmentsGeometry.
 *
 * @param lineSegments - The LineSegments object to extract positions from
 * @returns Array of position values [x1, y1, z1, x2, y2, z2, ...] or undefined if extraction fails
 */
function extractPositions(lineSegments: LineSegments): number[] | undefined {
  const { geometry } = lineSegments;
  const positionAttribute = geometry.attributes['position'];

  if (!positionAttribute) {
    console.warn('[FatLines] No position attribute found on LineSegments');
    return undefined;
  }

  const indexAttribute = geometry.index;

  // Handle InterleavedBufferAttribute (GLTFLoader optimization)
  if (positionAttribute instanceof InterleavedBufferAttribute) {
    if (indexAttribute) {
      return extractFromInterleavedIndexed(positionAttribute, indexAttribute.array);
    }

    return extractFromInterleavedNonIndexed(positionAttribute);
  }

  // Regular BufferAttribute
  const array = positionAttribute.array as Float32Array;

  if (indexAttribute) {
    return extractFromRegularIndexed(array, indexAttribute.array);
  }

  // Non-indexed regular buffer - copy directly
  return [...array];
}

/**
 * WebGL fat-line material paired with `LineSegments2` (`three/addons/lines/LineSegments2`).
 *
 * Injects multiplicative bias on `vFragDepth` in the vertex shader only (after three's
 * `<logdepthbuf_vertex>`), so the engine's `<logdepthbuf_fragment>` chunk (r180+
 * `USE_LOGARITHMIC_DEPTH_BUFFER`) stays authoritative and fragment MSAA stays valid.
 *
 * Exported so the screenshot capability path can allocate fresh materials per capture
 * — sharing the live viewport's `LineMaterial` across renderer instances is structurally
 * unsafe (the shared `'dispose'` listeners purge pipeline state on every renderer using
 * the material). See `docs/research/screenshot-viewport-shared-material-state-bleed.md`.
 *
 * @param resolution - The viewport resolution for line width calculation.
 * @returns A configured LineMaterial with FOV-adaptive depth bias (perspective only).
 */
export function createWebGlGltfFatLineMaterial(resolution: Vector2): LineMaterial {
  const material = new LineMaterial({
    color: defaultEdgeColor,
    linewidth: defaultLineWidth,
    worldUnits: false, // Screen-space pixels
    resolution: resolution.clone(),
    // Keep depth test enabled for proper occlusion
  });

  const depthBiasUniform = { value: depthBiasFactor };

  material.onBeforeCompile = (shader) => {
    shader.uniforms['depthBias'] = depthBiasUniform;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <logdepthbuf_pars_vertex>',
      `#include <logdepthbuf_pars_vertex>
      uniform float depthBias;`,
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <logdepthbuf_vertex>',
      `#include <logdepthbuf_vertex>
      #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
        if (projectionMatrix[3][3] == 0.0) {
          float tanHalfFov = 1.0 / projectionMatrix[1][1];
          float fovScale = tanHalfFov / 0.57735;
          vFragDepth *= pow(depthBias, fovScale);
        }
      #endif`,
    );
  };

  // Store reference to uniform for runtime updates
  // To adjust: material.userData['depthBiasUniform'].value = 0.995;
  material.userData['depthBiasUniform'] = depthBiasUniform;

  return material;
}

/**
 * Convert a LineSegments object to fat line segments for the active Three.js backend.
 *
 * @param lineSegments - The LineSegments object to convert
 * @param resolution - The viewport resolution for line width calculation
 * @param backend - WebGL retains custom log-depth tuned LineMaterial; WebGPU uses {@link Line2NodeMaterial}.
 */
function convertToFatLineSegments2(
  lineSegments: LineSegments,
  resolution: Vector2,
  backend: ResolvedGraphicsBackend,
): Object3D | undefined {
  const positions = extractPositions(lineSegments);

  if (!positions || positions.length === 0) {
    console.warn('[FatLines] Failed to extract positions from LineSegments');
    return undefined;
  }

  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);

  if (backend === 'webgpu') {
    const material = createWebGpuGltfFatLineMaterial();

    const lineSegments2 = new WebGpuFatLineSegments2(geometry, material);

    lineSegments2.position.copy(lineSegments.position);
    lineSegments2.rotation.copy(lineSegments.rotation);
    lineSegments2.scale.copy(lineSegments.scale);
    lineSegments2.quaternion.copy(lineSegments.quaternion);

    lineSegments2.name = lineSegments.name;
    lineSegments2.userData = { ...lineSegments.userData };

    lineSegments2.renderOrder = 1;

    return lineSegments2;
  }

  const material = createWebGlGltfFatLineMaterial(resolution);

  const lineSegments2 = new LineSegments2(geometry, material);

  lineSegments2.position.copy(lineSegments.position);
  lineSegments2.rotation.copy(lineSegments.rotation);
  lineSegments2.scale.copy(lineSegments.scale);
  lineSegments2.quaternion.copy(lineSegments.quaternion);

  lineSegments2.name = lineSegments.name;
  lineSegments2.userData = { ...lineSegments.userData };

  lineSegments2.renderOrder = 1;

  return lineSegments2;
}

/**
 * Apply fat line segments to a GLTF scene by converting LineSegments to LineSegments2.
 *
 * This function traverses the GLTF scene, finds all LineSegments objects (created by
 * the edge detection middleware), and converts them to LineSegments2 for fat line
 * rendering with constant screen-space width.
 *
 * @param gltf - The GLTF scene to process
 * @param resolution - The viewport resolution for line width calculation
 * @param backend - Active rendering backend for the host viewer
 */
export function applyFatLineSegments(gltf: GLTF, resolution: Vector2, backend: ResolvedGraphicsBackend): void {
  // Collect LineSegments for replacement (avoid modifying during traversal)
  const replacements: Array<{
    parent: Group;
    oldChild: LineSegments;
    newChild: Object3D;
  }> = [];

  gltf.scene.traverse((object) => {
    if (object.type === 'LineSegments') {
      const lineSegments = object as LineSegments;
      const parent = lineSegments.parent as Group | undefined;

      if (parent) {
        const lineSegments2 = convertToFatLineSegments2(lineSegments, resolution, backend);
        if (lineSegments2) {
          replacements.push({ parent, oldChild: lineSegments, newChild: lineSegments2 });
        }
      }
    }
  });

  // Perform replacements
  for (const { parent, oldChild, newChild } of replacements) {
    parent.remove(oldChild);
    parent.add(newChild);

    // Dispose old geometry and material
    oldChild.geometry.dispose();
    if (Array.isArray(oldChild.material)) {
      for (const material of oldChild.material) {
        material.dispose();
      }
    } else {
      oldChild.material.dispose();
    }
  }
}

/**
 * WebGPU fat-line material paired with {@link LineSegmentsGeometry} via
 * `three/addons/lines/webgpu/LineSegments2`.
 *
 * **`alphaToCoverage = false`** — opts the WebGPU material out of upstream
 * `Line2NodeMaterial`'s default `_useAlphaToCoverage = true` so the screen-space rounded
 * endcap branch falls through to the deterministic `discard` path. Upstream WebGL
 * `LineMaterial` already takes that path by default (`USE_ALPHA_TO_COVERAGE` define
 * absent) and produces the crisp 5-level MSAA coverage Tau ships today; mirroring the
 * WebGPU side closes the screenshot crispness gap because the WebGPU spec leaves the
 * alpha→sample-mask conversion vendor-defined (e.g. Qualcomm's documented 4×4
 * area-dither LUT, gpuweb/gpuweb#4867) which surfaces as visible graininess on
 * dithered drivers. See `docs/research/webgpu-edge-line-crispness-gap.md`.
 *
 * The coplanar bias is forwarded as `material.depthBias`; the renderer-aware encoder
 * dispatch lives inside {@link Line2NodeMaterial.setupDepth}, so the same material
 * instance can be rendered correctly by either the reversed-Z viewport renderer or the
 * log-depth screenshot/offscreen renderer in the same frame budget.
 */
export function createWebGpuGltfFatLineMaterial(): Line2NodeMaterial {
  const material = new Line2NodeMaterial({
    color: defaultEdgeColor,
    linewidth: defaultLineWidth,
    worldUnits: false,
  });

  material.alphaToCoverage = false;
  material.depthBias = depthBiasFactor;

  return material;
}

type ApplyEdgeMaterialsToClonedSceneOptions = Readonly<{
  backend: ResolvedGraphicsBackend;
  /** Required for the WebGL `LineMaterial` `resolution` uniform; ignored on WebGPU. */
  resolution: Vector2;
}>;

/**
 * Allocate fresh fat-line materials on every `LineSegments2` in a cloned screenshot scene.
 *
 * The screenshot renderer's flag set diverges from the viewport's on `reversedDepthBuffer`,
 * `logarithmicDepthBuffer`, and the `RenderPipeline`/`PassNode` post-processing chain. A
 * `Line2NodeMaterial` whose TSL graph is materialised once against the viewport's flags
 * cannot legally be reused by a renderer with a different sample-count contract — three.js
 * caches the built node graph on the material instance, so the screenshot renderer would
 * inherit the viewport's reversed-Z depth encoder, HalfFloat color attachment expectations,
 * and PassNode-level filtering assumptions.
 *
 * Allocating fresh materials here means each renderer compiles its own pipeline against
 * its own flag set. Tau's `Line2NodeMaterial.setupDepth` then correctly picks the
 * screenshot renderer's `viewZToLogarithmicDepth` branch instead of the viewport's
 * `viewZToReversedPerspectiveDepth` one. Combined with `applyMatcapToClonedScene`'s
 * existing fresh-allocation pattern for surface meshes, this closes the captured-output
 * graininess gap (Symptom B in
 * `docs/research/screenshot-viewport-shared-material-state-bleed.md`).
 *
 * @returns The set of newly-allocated edge materials owned by this clone pass.
 */
export function applyEdgeMaterialsToClonedScene(
  scene: Scene,
  options: ApplyEdgeMaterialsToClonedSceneOptions,
): Set<Material> {
  const allocated = new Set<Material>();

  scene.traverse((child) => {
    if (!('type' in child) || child.type !== 'LineSegments2') {
      return;
    }

    // Both the WebGL `LineSegments2` (from `three/addons`) and the WebGPU
    // `LineSegments2` (from `three/addons/lines/webgpu/LineSegments2.js`) set
    // `.type === 'LineSegments2'`. Their `material` slots accept different
    // concrete material classes (`LineMaterial` vs `Line2NodeMaterial`), so we
    // treat both via the structural intersection both materials expose.
    type FatLineMesh = { material: { color?: { getHex(): number }; linewidth?: number } };
    const lineSegments = child as unknown as FatLineMesh;
    const sourceMaterial = lineSegments.material;

    const fresh =
      options.backend === 'webgpu'
        ? createWebGpuGltfFatLineMaterial()
        : createWebGlGltfFatLineMaterial(options.resolution);

    if (sourceMaterial.color && 'color' in fresh) {
      (fresh as { color: { setHex(hex: number): void } }).color.setHex(sourceMaterial.color.getHex());
    }
    if (typeof sourceMaterial.linewidth === 'number') {
      (fresh as { linewidth: number }).linewidth = sourceMaterial.linewidth;
    }

    lineSegments.material = fresh as { color?: { getHex(): number }; linewidth?: number };
    allocated.add(fresh);
  });

  return allocated;
}

/**
 * Update the resolution of all LineMaterial instances in a scene.
 * Call this when the viewport size changes to maintain correct line widths.
 *
 * @param scene - The scene to update
 * @param resolution - The new viewport resolution
 */
export function updateLineMaterialResolution(scene: Group, resolution: Vector2): void {
  scene.traverse((object) => {
    if (object.type !== 'LineSegments2') {
      return;
    }

    const { material } = object as LineSegments2;
    if ('resolution' in material) {
      (material as { resolution: Vector2 }).resolution.copy(resolution);
    }
  });
}
