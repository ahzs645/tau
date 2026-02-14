# Rendering Pipeline Policy

Internal reference for the CAD rendering pipeline across all conversion paths and the Three.js viewer.

## Unified PBR Defaults

All conversion pipelines must produce GLTF materials with these canonical PBR values:

```
roughnessFactor:  0.35
metallicFactor:   0.0
baseColorFactor:  [0.8, 0.8, 0.8, 1]  (fallback when no source color)
doubleSided:      true
```

These values are defined in `libs/types/src/constants/material.constants.ts` as `cadMaterialDefaults` and imported by all conversion pipelines.

### Pipelines Covered

| Pipeline | Source | File |
|----------|--------|------|
| OCCT (STEP/IGES/BREP) | `packages/converter` | `loaders/occt.loader.ts` |
| ReplicaD Kernel | `apps/ui` | `kernel/replicad/utils/replicad-to-gltf.ts` |
| JSCAD Kernel | `apps/ui` | `kernel/jscad/jscad-to-gltf.ts` |
| OpenSCAD Kernel | `apps/ui` | `kernel/utils/export-glb.ts` |

Edge/line materials use `metallicFactor: 0`, `roughnessFactor: 1`, as they are rendered as flat-shaded `LineMaterial` and do not participate in PBR lighting.

## Material Policy

- **Non-metallic default**: All CAD surfaces default to `metallicFactor: 0.0`. None of the source formats (STEP, ReplicaD, JSCAD, OpenSCAD) carry per-part metal/non-metal metadata.
- **Semi-glossy roughness**: `roughnessFactor: 0.35` produces a glossy CAD sheen with visible specular highlights under studio lighting, closely matching professional CAD viewers like Onshape.
- **Source colors preserved**: When the source provides a color (STEP color, `colorize()`, etc.), it overrides the default `baseColorFactor`. Roughness and metalness remain at defaults unless the source format provides PBR data (only Rhino 3DM currently does).
- **Fallback material**: Meshes with no source color receive a unified neutral grey material (`[0.8, 0.8, 0.8, 1]`) across all pipelines rather than inheriting Three.js defaults.

## Tone Mapping Policy

The renderer uses `ACESFilmicToneMapping` (React Three Fiber default) with default exposure.

**Rationale**: Environment maps contain HDR values exceeding 1.0. Without tone mapping, bright reflections clip to pure white, losing surface detail. ACES filmic provides good highlight rolloff while preserving natural colour appearance.

**Decision gate for AgX**: If visual testing reveals unacceptable hue shifts under ACES (particularly in saturated reds/blues), switch to `THREE.AgXToneMapping` which preserves hues more accurately under bright lighting. Acceptance criteria:
- Highlight rolloff: smooth gradation from specular peak to diffuse, no hard clipping
- Color shift: saturated base colors (red, blue, green) should not visibly shift hue under bright environment
- White clipping: no pure-white patches on curved metallic surfaces

## Environment Strategy

The main CAD viewer uses an `<Environment>` component with `<Lightformer>` children (from `@react-three/drei`) for studio-style lighting.

### Design Decisions

- **Lightformers, not HDRI presets**: Full control over light panel placement, no CDN dependency, deterministic appearance across environments.
- **Size-aware placement**: All Lightformer positions and scales are expressed as multiples of the scene's bounding sphere radius (`sceneRadius`). This ensures a 5mm watch gear and a 5-meter building frame both receive proportionally sized soft panels.
- **No background**: The environment map is used for reflections only (`background` is not set). The app's CSS background shows through, consistent with standard CAD viewer behaviour.
- **Conditional on matcap**: When matcap is enabled, the environment is skipped entirely since `MeshMatcapMaterial` ignores environment maps. This avoids unnecessary GPU work.
- **Camera-relative key light**: A directional light (intensity `0.6`) is parented to the camera so the primary illumination follows the user's viewpoint, preventing uneven shading during orbit.
- **Environment resolution**: `512px` for sharp, defined reflections on surfaces.
- **Ambient light**: Low intensity (`0.15`) to preserve contrast and allow environment reflections to dominate.
- **Post-load envMapIntensity**: After GLTF load, all `MeshStandardMaterial` instances receive `envMapIntensity = 1.5` (PBR path only) to amplify environment reflections for a glossy appearance.

### Presets

| Preset | Description |
|--------|-------------|
| `studio` | Full Lightformer rig -- key (2.0), fill (1.0), rim (0.8), ground (0.3). Default. |
| `neutral` | Reduced intensity, minimal reflections. |
| `soft` | Hemisphere + ambient only, no environment map. |
| `performance` | No environment, minimal lights. Equivalent to matcap-era setup. |

## Color Pipeline

```
Source color (sRGB) --> GLTF baseColorFactor (linear via spec) --> Three.js linear shading --> Tone mapping --> sRGB output
```

- GLTF spec requires `baseColorFactor` in linear space. The `@gltf-transform/core` API handles this correctly when values are provided in 0-1 range.
- Three.js `GLTFLoader` creates `MeshStandardMaterial` with `colorSpace: SRGBColorSpace` on base color textures. For factor-only materials (no textures), the factor is treated as linear.
- Tone mapping converts the linear HDR result to displayable sRGB range.

### Verification Checklist

- A pure red part (`baseColorFactor: [1, 0, 0, 1]`) should appear red, not orange or pink, under default lighting.
- A white part should appear neutral white, not warm or cool-shifted.
- Both matcap ON and matcap OFF should produce visually acceptable results on the same model.

## Tessellation Quality

Current defaults per kernel:

| Kernel | Linear Tolerance | Angular Tolerance | Notes |
|--------|-----------------|-------------------|-------|
| ReplicaD | 0.1mm | 30deg | Configurable via `meshConfiguration` |
| ReplicaD (export) | 0.01mm | 30deg | Higher quality for file export |
| JSCAD | N/A | N/A | Fan triangulation of CSG output polygons |
| OpenSCAD | N/A | N/A | Manifold backend defaults |
| OCCT (converter) | OCCT defaults | OCCT defaults | `undefined` passed to `ReadStepFile` |

**Known limitation**: The OCCT converter does not expose tessellation quality parameters. This means curved surfaces may appear faceted on high-detail models. Future work: expose `linearDeflection` and `angularDeflection` options.

## Testing Notes (Future Reference)

These testing approaches are documented for future implementation, not actioned now.

### Canonical Test Models

- **Onshape vise assembly** (`MAIN ASSEMBLY.step`): Complex multi-part assembly with varied colours, good for overall appearance comparison.
- **Single filleted cube**: Tests specular highlight rolloff on curved surfaces.
- **Multi-coloured assembly**: Tests per-part colour preservation across pipeline.
- **Very small part** (< 10mm): Tests size-aware light placement.
- **Very large part** (> 1m): Tests size-aware light placement at scale.

### Visual Regression Approach

- Fixed camera snapshots at canonical angles (front-iso, top, right) for each test model.
- Compare before/after for each rendering change.
- Pixel-diff threshold for automated regression (future CI integration).

### A/B Acceptance Criteria for Tone Mapping

- Compare ACES vs AgX vs NoToneMapping on all canonical models.
- Evaluate: highlight rolloff, colour shift on saturated parts, white clipping, shadow depth.
- Document chosen algorithm and rationale.

## Known Limitations

- **No per-material metalness heuristics**: STEP files do not carry metal/non-metal metadata. All surfaces default to non-metallic. Future work could infer metalness from part names or colour patterns.
- **No normal map generation**: The pipeline relies on vertex normals from tessellation. No tangent-space normal maps are generated for surface detail enhancement.
- **Fixed tessellation quality for OCCT**: The converter passes `undefined` to `ReadStepFile`, using OCCT library defaults. Curved surfaces may appear faceted.
- **Matcap ignores environment**: When matcap is enabled, the environment map is skipped. The matcap texture provides its own baked lighting.
