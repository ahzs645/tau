---
title: 'Per-Shape PBR Appearance'
description: 'Evaluating options for adding PBR material properties (metallic, roughness) to individual shapes in replicad and OpenSCAD kernels'
status: draft
created: '2026-04-13'
updated: '2026-04-13'
category: comparison
related:
  - docs/research/cross-kernel-color-parity.md
---

# Per-Shape PBR Appearance

Evaluating two architectural options for exposing PBR material properties (metallic, roughness) on individual shapes in the replicad and OpenSCAD kernels, inspired by Zoo/KCL's native `appearance()` function.

## Executive Summary

Zoo/KCL natively couples appearance to geometry via the `appearance()` pipeline operator — the engine embeds PBR materials directly into the exported GLB. The replicad and OpenSCAD kernels lack this: they only support `color`/`opacity` on the return-value shape descriptor, and PBR defaults (`cadMaterialDefaults`) are applied uniformly during GLTF construction. Two options exist: **(A)** extend the existing return-value descriptor with `metallic`/`roughness` fields, or **(B)** add a shape-level API that mutates the shape object's prototype. Option A is recommended for its minimal surface area, zero upstream dependency, and consistency with the existing architecture.

## Problem Statement

Zoo/KCL models can attach full PBR appearance (color, metalness, roughness) to individual shapes via the `appearance()` pipeline operator:

```kcl
sphere |> appearance(color = "#4A90E2", metalness = 50, roughness = 50)
```

This produces per-shape materials directly in the exported GLB. In contrast, the replicad and OpenSCAD kernels only support per-shape `color` and `opacity`. PBR properties (`metallicFactor`, `roughnessFactor`) are applied uniformly from `cadMaterialDefaults` during GLTF construction — all shapes in a scene share identical metallic/roughness values regardless of intent.

The question: what is the best architectural approach to support per-shape PBR in these kernels?

## Methodology

1. Traced the data flow from user return value → kernel `createGeometry` → GLTF writer for all three kernels (Zoo, replicad, OpenSCAD)
2. Identified the shape descriptor contracts (`InputShape`, `ShapeEntry`, OFF color model)
3. Evaluated where PBR properties can be injected with minimal architectural disruption
4. Compared the two candidate approaches against correctness, DX, and implementation effort

## Findings

### Finding 1: Zoo/KCL appearance is engine-native — not reproducible in JS kernels

In Zoo/KCL, `appearance()` is a pipeline operator processed by the Zoo engine (Rust/WebSocket). The engine sets material properties on the B-Rep solid and the resulting GLB export includes per-shape PBR materials natively. Tau's kernel layer (`zoo.kernel.ts`) receives a finished GLB blob — it never touches materials.

This architecture cannot be replicated in the replicad or OpenSCAD kernels because:

- **Replicad**: The OCCT kernel has no concept of "appearance" on a `TopoDS_Shape`. XCAF documents support materials via `XCAFDoc_VisMaterial`, but replicad's `AnyShape` is a thin wrapper around `TopoDS_Shape` with no XCAF integration.
- **OpenSCAD**: The WASM engine outputs geometry in OFF format (vertices + face colors). OFF has no material/PBR concept — only per-face RGBA.

### Finding 2: Current shape descriptor contracts already carry `color`/`opacity`

Both JS kernels already support per-shape display metadata via a return-value descriptor pattern:

| Kernel      | Shape descriptor type    | Current fields                                    |
| ----------- | ------------------------ | ------------------------------------------------- |
| Replicad    | `InputShape`             | `shape`, `name`, `color`, `opacity`, `strokeType` |
| OpenCASCADE | `ShapeEntry`             | `shape`, `name`, `color`, `opacity`               |
| OpenSCAD    | N/A (OFF per-face color) | Per-face RGBA only, no shape-level descriptor     |

The descriptor pattern is the established convention: users return `{ shape, color, name }` from `main()` and the kernel extracts these during normalization.

### Finding 3: PBR properties flow through a single GLTF construction choke point

Every kernel's geometry ultimately passes through a GLTF writer that constructs `GlbMaterial`:

| Kernel      | GLTF construction entry point              | PBR source                      |
| ----------- | ------------------------------------------ | ------------------------------- |
| Replicad    | `replicad-to-gltf.ts` → `writeGlb()`       | `cadMaterialDefaults` (uniform) |
| OpenCASCADE | `opencascade-mesh.ts` → `RWGltf_CafWriter` | `SetDefaultStyle` (uniform)     |
| OpenSCAD    | `export-glb.ts` → `writeGlb()`             | `cadMaterialDefaults` (uniform) |
| JSCAD       | `jscad-to-gltf.ts` → `writeGlb()`          | `cadMaterialDefaults` (uniform) |

The `GlbMaterial` type already has `metallicFactor` and `roughnessFactor` fields. The only missing piece is threading per-shape values from the descriptor to the writer.

### Finding 4: OpenSCAD's OFF format cannot carry PBR metadata

OpenSCAD outputs geometry as OFF (Object File Format), which supports only per-face RGBA colors. There is no mechanism in the OFF spec for metallic/roughness data. Any PBR support for OpenSCAD would need to be:

- A module-level setting (not per-shape), OR
- Applied via a post-processing step on the GLB output

Since OpenSCAD's `color()` module already handles per-face RGBA, and users cannot define custom shape descriptors in OpenSCAD (it's not a JS runtime), per-shape PBR in OpenSCAD would require a different mechanism (e.g., a customizer parameter or `$metallic`/`$roughness` special variables).

## Option A: Extend the return-value descriptor (recommended)

Extend `InputShape` and `ShapeEntry` with optional `metallic` and `roughness` fields. Thread them through to the GLTF writer.

### User-facing API (replicad)

```typescript
import { makeCylinder, makeBox } from 'replicad';

export default function main() {
  const metalPart = makeCylinder(5, 20);
  const plasticPart = makeBox(10, 10, 10);

  return [
    { shape: metalPart, color: '#C0C0C0', metallic: 0.9, roughness: 0.2 },
    { shape: plasticPart, color: '#FF5733', metallic: 0, roughness: 0.8 },
  ];
}
```

### User-facing API (OpenCASCADE)

```typescript
import { BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeBox } from 'opencascade.js';

export default function main() {
  return [
    { shape: new BRepPrimAPI_MakeCylinder(5, 20).Shape(), color: '#C0C0C0', metallic: 0.9, roughness: 0.2 },
    { shape: new BRepPrimAPI_MakeBox(10, 10, 10).Shape(), color: '#FF5733', metallic: 0, roughness: 0.8 },
  ];
}
```

### Implementation steps

1. **Extend `InputShape`** (`render-output.ts`): Add optional `metallic?: number` and `roughness?: number` fields.

2. **Extend `ShapeEntry`** (`opencascade-mesh.ts`): Add optional `metallic?: number` and `roughness?: number` fields.

3. **Extend `GeometryReplicad`** (`replicad.types.ts`): Add optional `metallic?: number` and `roughness?: number` fields to carry through the intermediate geometry type.

4. **Thread through `renderMesh`** (`render-output.ts`): Pass `metallic`/`roughness` from `InputShape` into the `GeometryReplicad` output.

5. **Update `replicad-to-gltf.ts`**: When constructing `GlbMaterial`, use `geometry.metallic ?? cadMaterialDefaults.metallicFactor` and `geometry.roughness ?? cadMaterialDefaults.roughnessFactor`.

6. **Update `opencascade-mesh.ts`**: When constructing the XCAF document, if a `ShapeEntry` has per-shape `metallic`/`roughness`, create a per-shape `XCAFDoc_VisMaterial` with those values instead of relying on the writer-level `SetDefaultStyle`.

7. **Update `normalizeShapes`** (`opencascade.kernel.ts`): Extract `metallic` and `roughness` from the user's return value alongside `color`/`opacity`.

8. **OpenSCAD**: Add optional `$metallic` and `$roughness` special variables (or customizer parameters) that apply uniformly to the entire model. Thread through `export-glb.ts`.

### Pros

- Zero upstream dependency changes — no replicad library modifications needed
- Consistent with existing `{ shape, color, opacity }` descriptor pattern
- Per-shape granularity for JS kernels (replicad, OpenCASCADE)
- Backward compatible — `metallic`/`roughness` default to `cadMaterialDefaults` when omitted
- Simple mental model: "return what you want to see"

### Cons

- Appearance is decoupled from the shape object — not intrinsic to the geometry
- OpenSCAD support is limited to model-level (not per-shape) due to OFF format constraints
- Requires users to repeat PBR properties for shapes that share the same material

## Option B: Shape-level API (prototype extension)

Add an `appearance()` method to replicad's `AnyShape` prototype that stores PBR metadata on the shape instance. The kernel reads it during normalization.

### User-facing API (replicad)

```typescript
import { makeCylinder, makeBox, appearance } from 'replicad';

export default function main() {
  const metalPart = appearance(makeCylinder(5, 20), {
    color: '#C0C0C0',
    metallic: 0.9,
    roughness: 0.2,
  });
  const plasticPart = appearance(makeBox(10, 10, 10), {
    color: '#FF5733',
    metallic: 0,
    roughness: 0.8,
  });
  return [metalPart, plasticPart];
}
```

### Implementation steps

1. **Add `appearance()` to replicad**: Either as a library export (requires upstream PR to replicad) or as a Tau-injected helper registered alongside the replicad module.

2. **Store PBR metadata on shape**: Use a `WeakMap<AnyShape, AppearanceData>` to associate appearance with shape instances without modifying the prototype chain.

3. **Read during normalization**: In `createBasicShapeConfig()`, check the `WeakMap` for any shape that isn't already wrapped in an `InputShape` descriptor.

4. **Thread to GLTF writer**: Same as Option A steps 5-6.

5. **OpenSCAD**: Not applicable — OpenSCAD shapes are not JS objects.

6. **OpenCASCADE**: Would need a similar `WeakMap` for `TopoDS_Shape` instances, which is fragile since shapes are WASM objects that may be cloned/transformed.

### Pros

- Semantically mirrors Zoo/KCL's `appearance()` pattern
- Appearance travels with the shape through transformations (if the WeakMap key survives)
- Cleaner return values: `return [metalPart, plasticPart]` instead of `return [{ shape: metalPart, metallic: 0.9, ... }]`

### Cons

- WeakMap keys are fragile: replicad shape operations (`.fuse()`, `.cut()`, `.rotate()`) create new shape objects, losing the appearance binding
- Requires either upstream replicad changes or monkey-patching the module registration
- Does not work for OpenSCAD or OpenCASCADE kernels (WASM objects, not JS classes)
- Adds hidden mutable state — appearance is invisible in the return value, making debugging harder
- Inconsistent with existing `{ shape, color }` pattern that users already know
- The WeakMap approach conflates geometry identity with display intent — a shape's visual appearance is a rendering concern, not a geometric property

## Comparison

| Criterion                     | Option A (descriptor)                       | Option B (shape API)                                      |
| ----------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| **Implementation effort**     | Low — extend existing types, thread values  | Medium — WeakMap, module registration, fragility handling |
| **Upstream dependency**       | None                                        | Replicad PR or monkey-patch                               |
| **Kernel coverage**           | Replicad, OCJS, OpenSCAD (model-level)      | Replicad only                                             |
| **Survives transforms**       | Yes (descriptor is separate from shape)     | No (WeakMap key lost on `.fuse()`, `.rotate()`)           |
| **DX consistency**            | Matches existing `{ shape, color }` pattern | New pattern, mirrors Zoo/KCL                              |
| **Backward compatibility**    | Full — optional fields with defaults        | Full — shapes without appearance use defaults             |
| **Debugging**                 | Appearance visible in return value          | Appearance hidden in WeakMap                              |
| **Architectural correctness** | Separation of geometry and presentation     | Conflates geometry identity with display                  |

## Recommendations

| #   | Action                                                                    | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Implement Option A for replicad and OpenCASCADE kernels                   | P0       | Low    | High   |
| R2  | Add `$metallic`/`$roughness` special variables for OpenSCAD (model-level) | P1       | Low    | Medium |
| R3  | Extend cross-kernel parity test to verify per-shape PBR properties        | P1       | Low    | Medium |
| R4  | Document the extended descriptor API in kernel docs                       | P2       | Low    | Low    |

### Rationale

Option A is recommended because:

1. **It extends an established pattern** — users already return `{ shape, color, opacity }`. Adding `metallic`/`roughness` is a natural evolution.
2. **Zero fragility** — descriptor properties are plain data, not tied to object identity. They survive any shape transformation.
3. **Cross-kernel** — works for all JS-based kernels. OpenSCAD gets model-level support via special variables.
4. **No upstream dependency** — no replicad library changes needed. The kernel normalization layer already extracts these fields.
5. **Appearance is a rendering concern, not a geometric property** — keeping it in the descriptor maintains clean separation between the B-Rep domain and the visualization domain.

## References

- Related: `docs/research/cross-kernel-color-parity.md`
- [glTF 2.0 PBR specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#metallic-roughness-material)
- KCL `appearance()` documentation: [Zoo KCL docs](https://zoo.dev/docs/kcl-std/appearance)
