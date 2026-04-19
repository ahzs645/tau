---
title: 'Per-Shape PBR Appearance v2'
description: 'Revised architectural analysis for shape-level appearance and physical properties across kernels, informed by OCCT XCAF label-attribute model'
status: active
created: '2026-04-13'
updated: '2026-04-13'
category: architecture
related:
  - docs/research/per-shape-pbr-appearance.md
  - docs/research/cross-kernel-color-parity.md
---

# Per-Shape PBR Appearance v2

Revised architectural analysis for associating PBR visual properties and future physical properties (density, material) with individual shapes in the replicad and OpenSCAD kernels. This supersedes the initial comparison by deeply exploring OCCT's XCAF label-attribute model, replicad's shape identity semantics, and STEP export fidelity.

## Executive Summary

OCCT's XCAF model proves that shape properties (color, PBR material, physical density) belong at the **document** level via label-attribute associations, not on the B-Rep `TopoDS_Shape` itself. Replicad's shape transformations (`.rotate()`, `.fuse()`, `.cut()`) all produce new JS objects and **delete the original**, making `WeakMap`-based approaches fragile. The architecturally correct approach extends the existing flat descriptor with PBR and physical properties — `metallic`, `roughness`, `density`, `materialName` — alongside the existing `color`/`opacity` fields. This keeps the established `{ shape, color, ... }` contract intact while enabling format-aware export (STEP with XCAF color/material, GLTF with PBR).

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Option A: Extend Descriptor Only](#option-a-extend-descriptor-only-v1-approach)
- [Option B: WeakMap Shape API](#option-b-weakmap-shape-api)
- [Option C: Flat Descriptor with XCAF-Aware Export](#option-c-flat-descriptor-with-xcaf-aware-export-recommended)
- [OpenSCAD Considerations](#openscad-considerations)
- [Recommendations](#recommendations)

## Problem Statement

Zoo/KCL models attach full PBR appearance (color, metalness, roughness) to individual shapes via the `appearance()` pipeline operator. The engine embeds these directly into exported GLB. In contrast, replicad and OpenSCAD kernels only support per-shape `color` and `opacity`, with PBR defaults applied uniformly from `cadMaterialDefaults`.

The v1 analysis recommended extending the return-value descriptor. This v2 investigation challenges that recommendation on three fronts:

1. **STEP export fidelity** — STEP files can carry color and physical material (density). Option A ignores this entirely.
2. **Future physical properties** — Density, material name, and validation properties (mass, volume) are first-class in OCCT's XCAF model. The architecture should accommodate these.
3. **Architectural alignment** — Zoo/KCL couples appearance to the shape pipeline. The approach should align with this pattern where possible.

## Methodology

1. Traced replicad's `exportSTEP` → `createAssembly` → XCAF `SetColor` pipeline to verify color round-trips to STEP
2. Read OCCT source: `XCAFDoc_ShapeTool`, `XCAFDoc_ColorTool`, `XCAFDoc_MaterialTool`, `XCAFDoc_VisMaterialTool`, `XCAFDoc_Material` to map the full label-attribute architecture
3. Traced replicad's `Shape` class through all transform methods to validate WeakMap key stability
4. Analyzed `BRepGProp`, `GProp_GProps`, `XCAFDoc_Volume/Area/Centroid` for physical computation workflows
5. Audited STEP export paths (`STEPCAFControl_Writer` vs `STEPControl_Writer`) across all three STEP-capable kernels

## Findings

### Finding 1: OCCT's XCAF architecture proves properties are document-level, not geometry-level

OCCT's extended document framework (XCAF) uses a **label-attribute** model where properties are associated with shape labels via GUID-based tree node references:

| Property                          | Tool class                     | GUID                    | STEP export                                    |
| --------------------------------- | ------------------------------ | ----------------------- | ---------------------------------------------- |
| Color (surface, curve, generic)   | `XCAFDoc_ColorTool`            | `ColorRefGUID(type)`    | Yes (`ColorMode`)                              |
| Physical material (name, density) | `XCAFDoc_MaterialTool`         | `MaterialRefGUID()`     | Yes (`MaterialMode`)                           |
| Visual material (PBR, common)     | `XCAFDoc_VisMaterialTool`      | `VisMaterialRefGUID()`  | Partial (`VisualMaterialMode`, off by default) |
| Volume, area, centroid            | `XCAFDoc_Volume/Area/Centroid` | Direct label attributes | Yes (`PropsMode`)                              |

The critical insight: **`TopoDS_Shape` has no property storage.** All properties live on `TDF_Label` nodes in the document tree. A shape is associated with a label via `TNaming_Builder::Generated()`. Boolean operations produce new shapes — the application must explicitly re-associate properties with new labels.

This validates that properties are a **document/presentation concern**, not intrinsic to geometry. The descriptor pattern aligns with this philosophy.

### Finding 2: Replicad shape transforms destroy JS object identity

Detailed analysis of replicad's compiled source reveals:

| Operation      | Returns new object?          | Deletes `this`?           | WeakMap survives?                               |
| -------------- | ---------------------------- | ------------------------- | ----------------------------------------------- |
| `.rotate()`    | Yes (`cast(...)`)            | **Yes** (`this.delete()`) | **No** — key destroyed                          |
| `.translate()` | Yes (`cast(...)`)            | **Yes** (`this.delete()`) | **No** — key destroyed                          |
| `.mirror()`    | Yes (`cast(...)`)            | **Yes** (`this.delete()`) | **No** — key destroyed                          |
| `.scale()`     | Yes (`cast(...)`)            | **Yes** (`this.delete()`) | **No** — key destroyed                          |
| `.fuse()`      | Yes (`cast(...)`)            | No                        | Operands survive, **result has no association** |
| `.cut()`       | Yes (`cast(...)`)            | No                        | Operands survive, **result has no association** |
| `.clone()`     | Yes (`new constructor(...)`) | No                        | Clone has **no association**                    |

Transform methods (`rotate`, `translate`, `mirror`, `scale`) explicitly call `this.delete()` before returning the new shape. This is not a `WeakMap`-compatibility concern — it's a **fundamental destruction** of the original object. The v1 analysis correctly identified this, but the cause is more severe than "WeakMap key lost" — the original `_wrapped` is set to `null` and the WASM object is freed.

However, this does not invalidate the shape-level approach. It means appearance must be set **after** all transforms, which is the natural usage pattern — just as Zoo/KCL's `appearance()` is a terminal pipeline operator.

### Finding 3: STEP export paths have critical color gaps

Three kernels support STEP export, with varying color fidelity:

| Kernel               | STEP writer                      | Color in STEP?                 | Material in STEP? |
| -------------------- | -------------------------------- | ------------------------------ | ----------------- |
| Replicad (assembly)  | `STEPCAFControl_Writer` via XCAF | **Yes** (`SetColor` on labels) | Not yet           |
| Replicad (per-shape) | `STEPControl_Writer` (no XCAF)   | **No**                         | No                |
| OpenCASCADE          | `STEPControl_Writer` (no XCAF)   | **No**                         | No                |
| Zoo                  | Engine-native                    | **Yes** (engine handles it)    | Unknown           |

The per-shape STEP export path in both replicad and OpenCASCADE uses `STEPControl_Writer`, which has no XCAF integration and therefore loses all color, material, and name information. Only replicad's assembly-mode path (`exportSTEP`) routes through `createAssembly` → XCAF → `STEPCAFControl_Writer`.

This is a gap regardless of which PBR approach we choose. Both replicad (non-assembly) and OpenCASCADE STEP exports should be upgraded to use `STEPCAFControl_Writer` with XCAF documents.

### Finding 4: Replicad's existing `exportSTEP` already uses the descriptor pattern for XCAF

Replicad's `createAssembly` function already accepts `ShapeConfig` descriptors:

```typescript
type ShapeConfig = {
  shape: AnyShape;
  color?: string;
  alpha?: number;
  name?: string;
};
```

And threads them directly to XCAF:

```javascript
for (const { shape, name, color, alpha } of shapes) {
  tool.SetShape(shapeNode, shape.wrapped);
  ctool.SetColor(shapeNode, wrapColor(color || '#f00', alpha ?? 1), XCAFDoc_ColorSurf);
}
```

This proves the **descriptor → XCAF** pipeline already works. Extending the descriptor with `metallic`/`roughness`/`density` and mapping them to the appropriate XCAF tools (`VisMaterialTool`, `MaterialTool`) is a natural extension of this existing pattern.

### Finding 5: Physical properties (density) follow the same label-attribute pattern

OCCT's `XCAFDoc_MaterialTool.SetMaterial()` associates physical material (name, description, density) with a shape label via `MaterialRefGUID` tree nodes. `GetDensityForShape()` resolves the chain. `STEPCAFControl_Writer.writeMaterials()` exports these as STEP property definitions with proper units.

The physical material workflow in OCCT:

1. Create material definition: name + density → label in material table
2. Associate with shape label via `SetMaterial(shapeLabel, materialLabel)`
3. Compute mass: `BRepGProp::VolumeProperties(shape, props)` → `props.Mass()` gives volume; multiply by density
4. Export: `STEPCAFControl_Writer` writes material name + density as STEP property definitions

This maps directly to flat descriptor fields: `{ shape, density, materialName }` → XCAF `MaterialTool.SetMaterial()` at export time.

## Option A: Extend Descriptor Only (v1 approach)

Add `metallic`/`roughness` to `InputShape` and thread to GLTF writer only.

**Strengths:**

- Simple to implement
- Backward compatible

**Weaknesses:**

- Ignores STEP export entirely — metallic/roughness thread to GLTF only, color still lost in per-shape STEP export
- No path to physical properties (density) — would require further ad-hoc field additions later
- No XCAF upgrade — STEP exports remain on `STEPControl_Writer`, losing color/name/material

## Option B: WeakMap Shape API

Store appearance on shape instances via `WeakMap`.

**Strengths:**

- Mirrors Zoo/KCL's `appearance()` pipeline pattern

**Weaknesses:**

- Transforms **destroy** the original object (`this.delete()`), not just lose the WeakMap key — the shape is actively invalidated
- Only works if appearance is set after all transforms (terminal operation)
- Does not extend to OpenSCAD (not a JS runtime) or OpenCASCADE (WASM objects)
- No precedent in replicad's existing code — no shape-metadata pattern exists

## Option C: Flat Descriptor with XCAF-Aware Export (recommended)

Extend `InputShape` with flat PBR and physical property fields alongside existing `color`/`opacity`, and upgrade STEP export paths to use `STEPCAFControl_Writer`.

### Design

The `InputShape` descriptor gains optional flat fields for PBR and physical properties:

```typescript
type InputShape = {
  shape: AnyShape;
  name?: string;
  color?: string;
  opacity?: number;
  metallic?: number;
  roughness?: number;
  density?: number;
  materialName?: string;
};
```

No nested `appearance` object — all properties sit at the top level alongside the existing `color`/`opacity`/`name` fields. This preserves the established pattern where `{ shape, color }` already works, and users simply add more optional fields as needed.

### User-facing API

```typescript
import { makeCylinder, makeBox } from 'replicad';

export default function main() {
  const metalPart = makeCylinder(5, 20).rotate(45);
  const plasticPart = makeBox(10, 10, 10).translate(20, 0, 0);

  return [
    { shape: metalPart, name: 'Metal cylinder', color: '#C0C0C0', metallic: 0.9, roughness: 0.2, density: 7.85 },
    { shape: plasticPart, name: 'Plastic block', color: '#FF5733', metallic: 0, roughness: 0.8, density: 1.05 },
  ];
}
```

Properties are set **after** transforms — the descriptor is the final assembly step. This matches:

- Zoo/KCL where `appearance()` is a terminal pipeline operator
- OCCT's XCAF model where properties are associated with labels at document-assembly time
- Replicad's existing `createAssembly(shapes)` which processes descriptors at export time

### Export format mapping

Each descriptor field maps to the appropriate format-specific representation:

| Descriptor field | GLTF/GLB                          | STEP (XCAF)                                         | STL |
| ---------------- | --------------------------------- | --------------------------------------------------- | --- |
| `color`          | `baseColorFactor` (sRGB→linear)   | `XCAFDoc_ColorTool.SetColor`                        | N/A |
| `opacity`        | `baseColorFactor[3]`, `alphaMode` | `SetColor` alpha                                    | N/A |
| `metallic`       | `metallicFactor`                  | `XCAFDoc_VisMaterialTool` (if `VisualMaterialMode`) | N/A |
| `roughness`      | `roughnessFactor`                 | `XCAFDoc_VisMaterialTool` (if `VisualMaterialMode`) | N/A |
| `density`        | N/A                               | `XCAFDoc_MaterialTool.SetMaterial`                  | N/A |
| `materialName`   | N/A                               | `XCAFDoc_MaterialTool.SetMaterial`                  | N/A |

### Implementation steps

**Phase 1: Descriptor extension and GLTF threading**

1. Add `metallic`, `roughness`, `density`, `materialName` to `InputShape` in `render-output.ts`
2. Add `metallic`/`roughness` to `GeometryReplicad` type
3. Thread `metallic`/`roughness` through `replicad-to-gltf.ts` → `GlbMaterial` (fallback to `cadMaterialDefaults`)
4. Add `metallic`/`roughness`/`density`/`materialName` to `ShapeEntry` in `opencascade-mesh.ts` and thread to `XCAFDoc_VisMaterialPBR`
5. Update `normalizeShapes` in `opencascade.kernel.ts` to extract the new fields from return values

**Phase 2: STEP export upgrade**

6. Upgrade replicad's non-assembly STEP export to use `createAssembly` → `STEPCAFControl_Writer` path (currently uses colorless `blobSTEP`)
7. Upgrade OpenCASCADE kernel's STEP export from `STEPControl_Writer` to `STEPCAFControl_Writer` with XCAF document
8. Thread `color`/`opacity` to `XCAFDoc_ColorTool.SetColor` on XCAF labels
9. Thread `density`/`materialName` to `XCAFDoc_MaterialTool.SetMaterial`
10. Optionally enable `VisualMaterialMode` for PBR in STEP (default off)

**Phase 3: OpenSCAD**

11. Add `$metallic`/`$roughness` as special variable overrides (model-level, since OpenSCAD has no per-shape descriptor)
12. Thread to `export-glb.ts` material construction

**Phase 4: Analytical queries (future)**

13. Expose `computeMass(shape, density)` utility using `BRepGProp::VolumeProperties`
14. If density is on the descriptor, kernel can compute mass automatically and return it as metadata
15. Physical properties from descriptors can feed simulation/analysis tools downstream

## OpenSCAD Considerations

OpenSCAD cannot support per-shape descriptors — it's not a JS runtime. Its `color()` module produces per-face RGBA in the OFF output. PBR properties must be model-level:

- **`$metallic`/`$roughness`** as customizer variables or special variables
- Applied uniformly in `export-glb.ts` when constructing `GlbMaterial`
- No STEP export path exists for OpenSCAD (only GLB/GLTF)

This is acceptable: OpenSCAD is a mesh-oriented kernel without B-Rep representation. Per-shape PBR is not meaningful in OpenSCAD's execution model.

## Comparison

| Criterion               | Option A            | Option B                      | Option C                                        |
| ----------------------- | ------------------- | ----------------------------- | ----------------------------------------------- |
| GLTF PBR                | Yes                 | Yes                           | Yes                                             |
| STEP color preservation | No                  | No                            | **Yes** (via XCAF upgrade)                      |
| STEP physical material  | No                  | No                            | **Yes** (density, materialName)                 |
| Survives transforms     | Yes                 | **Fragile** (`this.delete()`) | Yes                                             |
| Future density/mass     | Ad-hoc field growth | Fragile                       | **Natural** (flat `density` field)              |
| Analytical queries      | No path             | No path                       | **Natural** (descriptor → XCAF → `BRepGProp`)   |
| OpenSCAD support        | Model-level         | None                          | Model-level                                     |
| OpenCASCADE support     | Yes                 | Fragile (WASM objects)        | **Yes** (XCAF-native)                           |
| Zoo/KCL alignment       | Partial             | Closest                       | **Best** (terminal descriptor mirrors pipeline) |
| Backward compatibility  | Full                | Full                          | Full (existing `color`/`opacity` unchanged)     |
| Implementation effort   | Low                 | Medium                        | Medium-High                                     |

## Recommendations

| #   | Action                                                                               | Priority | Effort | Impact | Status       |
| --- | ------------------------------------------------------------------------------------ | -------- | ------ | ------ | ------------ |
| R1  | Implement Option C Phase 1: flat descriptor fields + GLTF threading                  | P0       | Low    | High   | **Resolved** |
| R2  | Implement Option C Phase 2: Upgrade STEP exports to XCAF with color/material/density | P1       | Medium | High   | **Resolved** |
| R3  | Add `$metallic`/`$roughness` for OpenSCAD (Phase 3)                                  | P2       | Low    | Medium | Pending      |
| R4  | Extend cross-kernel parity test for per-shape PBR                                    | P1       | Low    | Medium | **Resolved** |
| R5  | Expose `computeMass(shape, density)` utility (Phase 4)                               | P2       | Medium | Medium | Pending      |
| R6  | Document descriptor API in kernel docs                                               | P2       | Low    | Low    | **Resolved** |

### Rationale

Option C is recommended because:

1. **XCAF alignment** — The flat descriptor maps directly to OCCT's label-attribute model, which is the established standard for associating properties with CAD shapes. Properties live alongside shape references, not on the B-Rep object — matching exactly how XCAF works.

2. **Format-agnostic** — A single flat descriptor serves both GLTF (PBR material) and STEP (XCAF color + physical material). The kernel's export layer maps each field to the appropriate format representation. This avoids format-specific leakage into user code.

3. **Physical property path** — `density` and `materialName` on the descriptor unlock `XCAFDoc_MaterialTool` for STEP export and `BRepGProp` for mass computation. This cannot be retrofitted onto Option A or B without re-architecting.

4. **Transform-safe** — Properties are set after transforms (terminal operation), matching Zoo/KCL's pipeline pattern. No fragile WeakMap keys. No object identity concerns.

5. **STEP export upgrade** — The investigation revealed that both replicad (non-assembly) and OpenCASCADE STEP exports currently lose color. Upgrading to `STEPCAFControl_Writer` is independently valuable and naturally integrates with the descriptor fields.

## References

- Related: `docs/research/per-shape-pbr-appearance.md`
- Related: `docs/research/cross-kernel-color-parity.md`
- [glTF 2.0 PBR specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#metallic-roughness-material)
- [STEP AP242 material representation](https://www.steptools.com/stds/stp_aim/html/t_product_definition.html)
- OCCT source: `repos/OCCT/src/DataExchange/TKXCAF/XCAFDoc/`
