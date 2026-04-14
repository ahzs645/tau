---
title: 'Cross-Kernel Color Parity'
description: 'Root cause analysis of color differences between replicad and OpenCASCADE GLTF rendering pipelines'
status: active
created: '2026-04-13'
updated: '2026-04-13'
category: investigation
related:
  - docs/research/replicad-occt-normal-pipeline-v3.md
---

# Cross-Kernel Color Parity

Investigation into why the same hex color values (e.g. `#1565C0`, `#C62828`, `#2E7D32`, `#FBC02D`) produce visually different colors when rendered through the replicad vs OpenCASCADE kernels.

## Executive Summary

The color difference is caused by two compounding issues: (1) the replicad pipeline writes sRGB color values directly into glTF `baseColorFactor` without the required sRGB→linear conversion, while OCCT correctly linearizes via `Quantity_TOC_sRGB`; and (2) the PBR material parameters differ (`metallicFactor: 0, roughnessFactor: 0.35` vs OCCT's defaults of `1.0, 1.0`), which affects rendering when the matcap material is disabled. The sRGB encoding issue is the primary root cause — it introduces a perceptual shift that compounds through the viewer's color management pipeline.

## Problem Statement

Side-by-side rendering of a DNA helix model shows the same hex color codes producing different visual results between the replicad kernel (left) and the OpenCASCADE kernel (right). Both models specify identical colors (`#1565C0` blue, `#C62828` red, `#2E7D32` green, `#FBC02D` yellow), yet the rendered appearance differs in saturation and brightness.

## Methodology

End-to-end trace of the color pipeline through:

1. Kernel `createGeometry` → color extraction from shape metadata
2. GLTF material encoding (replicad's `replicad-to-gltf.ts` vs OCCT's `RWGltf_CafWriter`)
3. Viewer material application (`gltf-matcap.ts` and `gltf-mesh.tsx`)
4. OCCT source code for `Quantity_Color` sRGB handling and `RWGltf_GltfMaterialMap::DefineMaterial`

## Findings

### Finding 1: sRGB → Linear Conversion Missing in Replicad Pipeline

The glTF 2.0 specification requires `baseColorFactor` to be in **linear** color space. The two kernels handle this differently:

| Pipeline     | Color encoding path                                                                                                              | Result in GLB                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Replicad** | `parseInt(hex)/255` → directly to `baseColorFactor`                                                                              | sRGB values written as-if-linear |
| **OCCT**     | `parseInt(hex)/255` → `Quantity_Color(..., Quantity_TOC_sRGB)` → internal linear storage → `DefineMaterial` writes linear values | Correctly linearized values      |

**Replicad** (`replicad-to-gltf.ts` lines 29–31):

```typescript
const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
```

These sRGB-encoded values are passed directly to `baseColorFactor` without linearization.

**OCCT** (`opencascade-mesh.ts` line 77):

```typescript
const color = new oc.Quantity_Color(r, g, b, oc.Quantity_TypeOfColor.Quantity_TOC_sRGB);
```

OCCT's `Quantity_Color` constructor with `Quantity_TOC_sRGB` applies `Convert_sRGB_To_LinearRGB` internally. The `RWGltf_GltfMaterialMap::DefineMaterial` then writes the stored linear values via `aPbrMat.BaseColor.GetRGB().Red()`, which returns the linear internal representation.

**Concrete example for `#1565C0`:**

| Channel | sRGB (hex/255) | Linear (OCCT output) |
| ------- | -------------- | -------------------- |
| R       | 0.082          | ~0.006               |
| G       | 0.396          | ~0.129               |
| B       | 0.753          | ~0.527               |

The viewer's Three.js `GLTFLoader` reads `baseColorFactor` as linear (per spec). When the matcap path extracts the color via `material.color.getHexString()`, it converts the internal linear representation back to sRGB hex. For replicad's incorrectly-encoded values, this applies an additional gamma curve to already-gamma-encoded values, producing a perceptual color shift.

### Finding 2: PBR Material Parameters Differ

| Property          | Replicad | OCCT                      | glTF 2.0 default |
| ----------------- | -------- | ------------------------- | ---------------- |
| `metallicFactor`  | `0`      | `1.0` (omitted from JSON) | `1.0`            |
| `roughnessFactor` | `0.35`   | `1.0` (omitted from JSON) | `1.0`            |
| `doubleSided`     | `true`   | `true`                    | `false`          |

Source: Replicad uses `cadMaterialDefaults` from `libs/types/src/constants/material.constants.ts` (`metallicFactor: 0, roughnessFactor: 0.35`). OCCT's `RWGltf_CafWriter` uses `XCAFDoc_VisMaterialPBR` defaults (metallic `1.0`, roughness `1.0`) and only writes these properties when they differ from the glTF spec defaults.

In **matcap mode** (the default viewer mode), metallic/roughness are irrelevant because `MeshMatcapMaterial` replaces `MeshPhysicalMaterial` entirely. However, when matcap is disabled and PBR rendering is active (with the studio/neutral environment IBL), these parameters significantly affect appearance — metallic=0 + roughness=0.35 produces a smooth plastic look, while metallic=1 + roughness=1 produces a dull metallic appearance.

### Finding 3: Matcap Material Color Transfer Path

When matcap mode is active (`gltf-matcap.ts` lines 53–57):

```typescript
if ('color' in mesh.material) {
  const material = mesh.material as { color: { getHexString(): string } };
  meshMatcap.color.set(`#${material.color.getHexString()}`);
}
```

The Three.js `Color.getHexString()` converts the internal linear representation to sRGB hex. For the OCCT pipeline (correctly linear `baseColorFactor`), this produces the original hex color. For the replicad pipeline (sRGB values misinterpreted as linear), this applies sRGB OETF to already-sRGB values, resulting in a brighter/lighter appearance.

### Finding 4: Default Base Color Fallback Differs

When no color is specified:

| Pipeline              | Default `baseColorFactor`                                 |
| --------------------- | --------------------------------------------------------- |
| Replicad              | `[0.8, 0.8, 0.8, 1]` (hardcoded in `replicad-to-gltf.ts`) |
| `cadMaterialDefaults` | `[0.7, 0.7, 0.7, 1]` (not used by replicad)               |
| OCCT                  | `[1, 1, 1, 1]` (from `XCAFDoc_VisMaterialPBR` default)    |

The replicad default grey (`0.8`) is inconsistent with both `cadMaterialDefaults` (`0.7`) and OCCT (`1.0`).

## Recommendations

| #   | Action                                                                                       | Priority | Effort  | Impact                                    |
| --- | -------------------------------------------------------------------------------------------- | -------- | ------- | ----------------------------------------- |
| R1  | Apply sRGB→linear conversion in `replicad-to-gltf.ts` before writing `baseColorFactor`       | P0       | Low     | High — fixes the primary color difference |
| R2  | Align PBR defaults: use `cadMaterialDefaults` consistently, or match OCCT defaults           | P1       | Low     | Medium — affects PBR mode appearance      |
| R3  | Use `cadMaterialDefaults.baseColorFactor` for the no-color fallback in `replicad-to-gltf.ts` | P2       | Trivial | Low — consistency fix                     |

### R1: sRGB→Linear Conversion

Add the standard sRGB EOTF (Electro-Optical Transfer Function) to `replicad-to-gltf.ts`:

```typescript
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
```

Apply it to the R, G, B channels before constructing `baseColorFactor`:

```typescript
const r = srgbToLinear(Number.parseInt(hex.slice(1, 3), 16) / 255);
const g = srgbToLinear(Number.parseInt(hex.slice(3, 5), 16) / 255);
const b = srgbToLinear(Number.parseInt(hex.slice(5, 7), 16) / 255);
```

This matches what OCCT does internally via `Quantity_Color::Convert_sRGB_To_LinearRGB`.

### R2: PBR Material Parameter Alignment

Two options:

1. **Match OCCT defaults** (metallic=1, roughness=1): Produces identical GLB material properties. Replicad shapes will look identical to OCCT shapes in both matcap and PBR modes.
2. **Keep `cadMaterialDefaults`** (metallic=0, roughness=0.35): Produces better visual results in PBR mode (smooth plastic CAD look). But differs from OCCT's output.

Recommendation: Keep `cadMaterialDefaults` for the replicad pipeline — it produces the intended CAD aesthetic in PBR mode, and matcap mode ignores these values. Apply the same defaults to the OCCT pipeline if visual consistency across kernels in PBR mode is desired.

## References

- [glTF 2.0 Specification — Material](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#materials): `baseColorFactor` is linear
- Related: `docs/research/replicad-occt-normal-pipeline-v3.md`
