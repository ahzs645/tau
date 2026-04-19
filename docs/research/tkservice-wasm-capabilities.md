---
title: 'TKService WASM Capabilities Assessment'
description: 'Inventory and feasibility analysis of OCCT TKService classes for headless CAD in WASM'
status: draft
created: '2026-04-13'
updated: '2026-04-13'
category: audit
related:
  - docs/research/per-shape-pbr-appearance-v2.md
  - docs/research/occt-v8-rc5-migration.md
---

# TKService WASM Capabilities Assessment

Assessment of OCCT's TKService toolkit to identify portable data classes that could enhance the replicad minimal WASM build for headless CAD operations — materials, textures, image handling — without pulling in the GPU-dependent visualization stack.

## Executive Summary

TKService (10 packages, ~67+ classes) is currently excluded entirely from the replicad WASM build. However, many of its classes are **pure data structures** with zero OpenGL dependency — `Graphic3d_PBRMaterial`, `Graphic3d_MaterialAspect`, `Image_PixMap`, `Image_Texture`, and material enums. These are architecturally independent of the rendering backend despite being packaged alongside it. The STEP and glTF export paths in OCCT's data exchange layer do NOT directly consume Graphic3d types; they read XCAF-native structures (`XCAFDoc_VisMaterialPBR` scalars + `Image_Texture` handles). The real blocker is the **build granularity**: TKService ships as a single `libTKService.a` containing windowing, VR/XR, FFmpeg, and GLSL shaders alongside the portable material classes. Selective inclusion requires either a custom CMake split or reliance on linker dead-stripping with careful symbol hygiene.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
  - [Finding 1: TKService Package Inventory](#finding-1-tkservice-package-inventory)
  - [Finding 2: Portable Data Classes](#finding-2-portable-data-classes-no-opengl-dependency)
  - [Finding 3: GPU-Bound Classes](#finding-3-gpu-bound-classes-require-tkopengldisplay)
  - [Finding 4: XCAF Material Pipeline](#finding-4-xcaf-material-pipeline-does-not-directly-consume-graphic3d)
  - [Finding 5: Build Granularity Constraint](#finding-5-build-granularity-constraint)
  - [Finding 6: Font Package Capabilities](#finding-6-font-package-capabilities)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Diagrams](#diagrams)
- [References](#references)
- [Appendix](#appendix)

## Problem Statement

Adding `XCAFDoc_VisMaterial*` symbols to the replicad WASM build caused a `LinkError` at runtime because these XCAF classes internally call `Graphic3d_PBRMaterial` methods (in `TKService`), which transitively depend on `Graphic3d_Texture2D`, `Graphic3d_BSDF::CreateMetallicRoughness`, and other symbols from the excluded `TKService` package. The symbols were reverted, but the question remains: **what useful capabilities does TKService provide, and can any be selectively included in a headless WASM build?**

## Methodology

Source analysis of the OCCT 8.x tree at `repos/opencascade.js/deps/OCCT/src/Visualization/TKService/`:

1. Package inventory from `PACKAGES.cmake` and per-package `FILES.cmake`
2. Header analysis of all classes for inheritance, virtual methods, and Graphic3d dependencies
3. Cross-referencing `XCAFDoc_VisMaterial.cxx`, `STEPCAFControl_Writer.cxx`, and `RWGltf_GltfMaterialMap.cxx` for TKService type usage
4. Build system analysis: `build-wasm.sh`, `buildFromYaml.py`, `filterPackages.py`, `bindgen-filters.yaml`

## Findings

### Finding 1: TKService Package Inventory

TKService contains **10 packages** compiled into a single `libTKService.a`:

| Package       | Classes | Role                                                                                         | WASM Relevance                                                  |
| ------------- | ------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Graphic3d** | ~90+    | 3D graphics abstraction: materials, lights, cameras, buffers, textures, shaders, scene graph | Mixed — data classes are portable; scene/driver classes are not |
| **Image**     | 13      | CPU-side pixel maps, texture descriptors, image I/O, DDS parsing, diff                       | High — pure data containers                                     |
| **Aspect**    | ~67     | Windowing, display connections, input, grids, backgrounds, VR/XR, enums                      | Low — mostly platform-bound                                     |
| **Font**      | 14      | FreeType fonts, system font enumeration, text layout, BRep text                              | Medium — text-to-geometry is valuable                           |
| **Media**     | 10      | FFmpeg codec/format/frame plumbing for video textures                                        | None                                                            |
| **Shaders**   | ~30     | Embedded GLSL source strings (.pxx)                                                          | None                                                            |
| **Xw**        | 1       | X11/GLX window                                                                               | None                                                            |
| **WNT**       | 7       | Windows window helpers                                                                       | None                                                            |
| **Wasm**      | 1       | Emscripten/WebGL window                                                                      | None                                                            |
| **Cocoa**     | 2       | macOS Cocoa window                                                                           | None                                                            |

### Finding 2: Portable Data Classes (No OpenGL Dependency)

These classes are **self-contained value types** with no virtual methods implemented in TKOpenGl, no `Standard_Transient` rendering lifecycle, and no GPU resource management:

| Class                             | Purpose                                                     | Key Fields                                                                                     | Export Value                                                          |
| --------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `Graphic3d_PBRMaterial`           | Metallic-roughness PBR model                                | `myColor`, `myMetallic`, `myRoughness`, `myEmission`, `myIOR`                                  | Direct glTF metallic-roughness mapping                                |
| `Graphic3d_MaterialAspect`        | Full Phong+PBR material with named presets                  | `myBSDF`, `myPBRMaterial`, `myColors[]`, `myTransparencyCoef`, `myShininess`, `myMaterialName` | Named material presets (brass, gold, glass, etc.)                     |
| `Graphic3d_BSDF`                  | Layered BSDF for advanced shading                           | `Kd`, `Ks`, `Kt`, `Le`, `Absorption`, `FresnelCoat`, `FresnelBase`                             | Path-tracing parameters, PBR conversion via `CreateMetallicRoughness` |
| `Graphic3d_Fresnel`               | Fresnel model (nested in BSDF)                              | Schlick/dielectric/conductor/constant modes                                                    | IOR-based material classification                                     |
| `Image_PixMap`                    | In-memory pixel buffer (2D/3D)                              | Row/slice layout, format, pixels, flips                                                        | Texture data for glTF image embedding                                 |
| `Image_Texture`                   | File path / buffer / file-range texture descriptor          | `myPath`, `myPixMap`, `myTexId`, `myOffset`, `myLength`                                        | glTF image URIs or embedded buffers                                   |
| `Image_CompressedPixMap`          | Compressed texel blob (S3TC/DXT)                            | Dimensions, mip sizes, cubemap faces, buffer                                                   | KHR_texture_basisu extension support                                  |
| `Image_DDSParser`                 | DDS file parsing (static methods)                           | —                                                                                              | Compressed texture loading                                            |
| `Image_Diff`                      | Pixel-compare two pixmaps                                   | Tolerance, B/W, border filter                                                                  | Regression testing                                                    |
| `Image_Color*`                    | POD packed pixel structs (RGB, RGBA, float variants)        | Raw pixel data                                                                                 | Interchange format                                                    |
| `Image_Format`                    | Uncompressed pixel layout enum                              | Gray, RGBA, float, half, etc.                                                                  | Format negotiation                                                    |
| `Image_CompressedFormat`          | S3TC variant enum                                           | DXT1-5                                                                                         | GPU-native format selection                                           |
| `Graphic3d_AlphaMode`             | Alpha blend/mask/cutoff mode                                | Enum                                                                                           | glTF alphaMode mapping                                                |
| `Graphic3d_TypeOfBackfacingModel` | Front/back face culling                                     | Enum                                                                                           | glTF doubleSided mapping                                              |
| `Graphic3d_NameOfMaterial`        | Named presets (brass, gold, glass, etc.)                    | Enum                                                                                           | Material library                                                      |
| `Graphic3d_TypeOfMaterial`        | ASPECT vs PHYSIC classification                             | Enum                                                                                           | Material behavior                                                     |
| `Graphic3d_CLight`                | Light parameters (type, color, position, spot, attenuation) | No virtuals                                                                                    | glTF KHR_lights_punctual                                              |
| `Graphic3d_Camera`                | View/projection math                                        | FOV, eye, proj matrix                                                                          | Scene description                                                     |

**Verified**: `Graphic3d_PBRMaterial` and `Graphic3d_MaterialAspect` have **zero virtual methods** and are **not subclassed** by TKOpenGl. OpenGL code **reads** these structs to set GPU state; it does not specialize them.

### Finding 3: GPU-Bound Classes (Require TKOpenGl/Display)

| Class                                                        | Why GPU-Bound                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `Graphic3d_GraphicDriver` / `*Factory`                       | Abstract driver implemented by TKOpenGl                                |
| `Graphic3d_CStructure` / `Group` / `CView` / `Layer`         | Scene graph nodes with GPU lifecycle                                   |
| `Graphic3d_StructureManager`                                 | GPU resource management                                                |
| `Graphic3d_ShaderProgram` / `ShaderObject` / `ShaderManager` | GLSL compilation/linking                                               |
| `Graphic3d_TextureRoot` / `Texture2D` / `TextureSet`         | GPU upload lifecycle (`GetImage`, revision tracking, driver callbacks) |
| `Graphic3d_MediaTexture*`                                    | Video texture with FFmpeg + GPU                                        |
| `Graphic3d_MarkerImage`                                      | Bitmap marker for display                                              |
| `Graphic3d_BvhCStructureSet*`                                | Visualization BVH tied to scene structures                             |
| `Aspect_Window` / `NeutralWindow`                            | Platform window                                                        |
| `Aspect_DisplayConnection`                                   | X11 display handle                                                     |
| `Aspect_*XR*` / `Aspect_OpenVRSession`                       | VR/XR sessions                                                         |
| All platform packages (Xw, WNT, Cocoa, Wasm)                 | Platform-specific windowing                                            |

### Finding 4: XCAF Material Pipeline Does NOT Directly Consume Graphic3d

This is the most architecturally significant finding. The material export paths are **decoupled** from TKService/Graphic3d:

| Export Path                                        | TKService Types Used                                                                                                 | Notes                                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **STEP physical material** (`SetMaterialMode`)     | **None**                                                                                                             | Uses `XCAFDoc_MaterialTool` → `StepRepr_*` directly                                                                          |
| **STEP visual material** (`SetVisualMaterialMode`) | **None at TKDESTEP layer**                                                                                           | `STEPConstruct_RenderingProperties::Init()` reads `XCAFDoc_VisMaterialCommon` scalars, not `Graphic3d_*`                     |
| **glTF** (`RWGltf_GltfMaterialMap`)                | `Graphic3d_AlphaMode`, `Graphic3d_TypeOfBackfacingModel` (enums only)                                                | Reads `XCAFDoc_VisMaterialPBR` scalars + `Image_Texture`; does NOT use `Graphic3d_MaterialAspect` or `Graphic3d_PBRMaterial` |
| **Viewer** (`FillAspect`)                          | `Graphic3d_MaterialAspect`, `Graphic3d_PBRMaterial`, `Graphic3d_BSDF`, `Graphic3d_TextureSet`, `Graphic3d_Texture2D` | **Full** TKService dependency — viewer-only path                                                                             |

The dependency chain that caused our `LinkError`:

```
XCAFDoc_VisMaterial.o (TKXCAF)
  → FillMaterialAspect() calls Graphic3d_PBRMaterial methods
  → FillAspect() creates Graphic3d_TextureSet + Graphic3d_Texture2D
  → These are in TKService (not linked)
  → Undefined WASM imports → LinkError
```

But `FillMaterialAspect()` and `FillAspect()` are **viewer methods** — they're called by `AIS_ColoredShape` and `XCAFPrs_*` for on-screen display. The STEP and glTF writers never call them. The problem is that **compiling `XCAFDoc_VisMaterial.cxx`** pulls in all method implementations, including the viewer-facing ones, even if export paths only need the data accessors.

### Finding 5: Build Granularity Constraint

| Factor               | Status                                                                           |
| -------------------- | -------------------------------------------------------------------------------- |
| OCCT module flag     | `BUILD_MODULE_Visualization=OFF` — TKService is not compiled at all              |
| Archive shape        | Single `libTKService.a` (all 10 packages) — no per-package archives              |
| Link behavior        | Standard static linking (member-level selection by linker, no `--whole-archive`) |
| bindgen-filters.yaml | TKService excluded at package level + class-level overrides                      |
| filterPackages.py    | Operates on toolkit names (e.g. `TKService`), not individual packages            |

**Enabling TKService** requires:

1. `BUILD_MODULE_Visualization=ON` in CMake (or custom toolkit split)
2. Full OCCT `sources` rebuild (~10–30 min)
3. Adding TKService to the allowed list in `bindgen-filters.yaml`
4. Binding only needed symbols in the YAML config
5. The linker would pull only referenced `.o` files from `libTKService.a`

### Finding 6: Font Package Capabilities

The Font package provides text-to-BRep conversion via FreeType:

| Class                                     | Role                    | WASM Feasibility                  |
| ----------------------------------------- | ----------------------- | --------------------------------- |
| `Font_FontMgr`                            | System font enumeration | Limited in WASM (no system fonts) |
| `Font_FTFont` / `Font_FTLibrary`          | FreeType wrapper        | Requires FreeType WASM build      |
| `Font_BRepFont`                           | Text → BRep shapes      | High value for CAD text features  |
| `Font_TextFormatter`                      | Text layout/shaping     | Requires FreeType                 |
| Embedded `Font_DejavuSans_Latin_woff.pxx` | Built-in font data      | Works in WASM out of the box      |

Text-to-BRep would allow rendering text as solid geometry — useful for engraving, labels, and annotations in parametric CAD models.

## Recommendations

| #   | Action                                                                                                                                                                       | Priority | Effort              | Impact   | Notes                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| R1  | **Do nothing for now** — current approach (PBR via code-level GLTF, density via MaterialTool, full PBR STEP via OpenCASCADE kernel) is architecturally sound                 | P0       | None                | Baseline | Current state is correct                                                                                            |
| R2  | **Investigate custom CMake split** to build only Graphic3d + Image as a separate `libTKServiceLite.a`                                                                        | P2       | High                | High     | Would unlock `XCAFDoc_VisMaterial` and `Image_Texture` in WASM; requires OCCT CMake fork                            |
| R3  | **Explore `XCAFDoc_VisMaterial` source surgery** — compile a stripped version of `XCAFDoc_VisMaterial.cxx` that omits `FillMaterialAspect()` / `FillAspect()` viewer methods | P2       | Medium              | High     | Eliminates Graphic3d dependencies while keeping XCAF material storage; requires upstream fork or patch              |
| R4  | **Evaluate FreeType WASM** for text-to-BRep geometry (Font_BRepFont)                                                                                                         | P3       | Medium              | Medium   | Text as solid geometry for engraving/labels; embedded DejaVu font works without system font enumeration             |
| R5  | **Add `Image_PixMap` + `Image_Texture`** if R2/R3 succeeds — enables texture embedding in XCAF documents and native glTF export with textures                                | P3       | Low (if R2/R3 done) | Medium   | OCCT's `RWGltf_CafWriter` reads `Image_Texture` for glTF image embedding                                            |
| R6  | **Evaluate `Graphic3d_PBRMaterial` for canonical PBR model** — single source of truth for material parameters shared across kernels                                          | P3       | Low (if R2/R3 done) | Low      | Currently we define PBR fields ad-hoc on `InputShape`/`ShapeEntry`; `Graphic3d_PBRMaterial` includes IOR + emission |
| R7  | **Monitor OCCT modularization** — OCCT 8.x trend is toward finer-grained modules; future releases may separate data classes from rendering                                   | P4       | None                | Future   | Track upstream CMake changes                                                                                        |

## Trade-offs

### Custom CMake Split (R2) vs Source Surgery (R3)

| Dimension              | CMake Split                                               | Source Surgery                                         |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| **Build complexity**   | New CMake target, needs OCCT build system expertise       | Patch file on XCAFDoc_VisMaterial.cxx                  |
| **Maintenance**        | Must be re-validated on OCCT upgrades                     | Patch may conflict on upgrades                         |
| **Scope**              | Includes ALL Graphic3d data + Image classes               | Surgically removes viewer-only methods                 |
| **WASM size impact**   | Larger (full Graphic3d + Image .o files pulled by linker) | Minimal (only XCAF methods, no new TKService .o files) |
| **Upstream viability** | Could be proposed as an OCCT contribution                 | Less likely to be accepted upstream                    |

### Do Nothing (R1) vs Enable TKService

| Dimension             | Current State                                   | With TKService Subset                                  |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| **PBR in GLTF**       | Code-level in Tau runtime (works)               | Code-level (no change)                                 |
| **PBR in STEP**       | OpenCASCADE kernel only (full build)            | Both kernels via `XCAFDoc_VisMaterial`                 |
| **Density in STEP**   | Both kernels via `XCAFDoc_MaterialTool` (works) | No change                                              |
| **Texture embedding** | Not supported                                   | `Image_Texture` enables texture maps in STEP/glTF      |
| **Named materials**   | Not supported                                   | `Graphic3d_NameOfMaterial` presets (brass, gold, etc.) |
| **IOR / emission**    | Not supported                                   | `Graphic3d_PBRMaterial` includes IOR + emission        |
| **WASM size**         | ~21.7 MB                                        | Estimated +2–5 MB (depends on dead stripping)          |
| **Build complexity**  | Simple                                          | Significant CMake/patch work                           |

## Diagrams

### TKService Package Dependency Map

```
TKService (libTKService.a)
├── Graphic3d/
│   ├── [PORTABLE] PBRMaterial, MaterialAspect, BSDF, Fresnel
│   ├── [PORTABLE] Camera, CLight, LightSet
│   ├── [PORTABLE] Buffer, ArrayOfPrimitives, Vertex
│   ├── [PORTABLE] Enums: AlphaMode, NameOfMaterial, TypeOfMaterial, ...
│   ├── [GPU-BOUND] GraphicDriver, StructureManager, CStructure, Group, CView
│   ├── [GPU-BOUND] ShaderProgram, ShaderObject, ShaderManager
│   └── [GPU-BOUND] TextureRoot, Texture2D, TextureSet, MediaTexture
├── Image/
│   ├── [PORTABLE] PixMap, PixMapData, Color structs, Format enums
│   ├── [PORTABLE] Texture (descriptor), CompressedPixMap, DDSParser, Diff
│   └── [I/O DEP]  AlienPixMap (FreeImage), VideoRecorder (FFmpeg)
├── Font/
│   ├── [FREETYPE] FontMgr, FTFont, FTLibrary, TextFormatter
│   └── [FREETYPE] BRepFont (text → solid geometry)
├── Aspect/ ────── [PLATFORM] Windows, Display, XR, Input, Grids
├── Media/ ─────── [FFMPEG]   Video codecs/frames
├── Shaders/ ───── [GLSL]    Embedded shader source strings
├── Xw/ ────────── [X11]     X11/GLX window
├── WNT/ ───────── [WIN32]   Windows window
├── Wasm/ ──────── [WEBGL]   Emscripten window
└── Cocoa/ ─────── [MACOS]   Cocoa window
```

### Material Data Flow Through OCCT

```
User Code (metallic, roughness, color, density)
    │
    ├──→ XCAFDoc_VisMaterialPBR (XCAF scalars)  ←── No Graphic3d dependency
    │         │
    │         ├──→ STEPCAFControl_Writer (SetVisualMaterialMode)
    │         │         └──→ STEPConstruct_RenderingProperties
    │         │                   └──→ ConvertToCommonMaterial() → StepVisual_*
    │         │                         (No Graphic3d types at STEP layer)
    │         │
    │         ├──→ RWGltf_GltfMaterialMap
    │         │         └──→ Reads PBR scalars + Image_Texture
    │         │               + Graphic3d_AlphaMode (enum only)
    │         │
    │         └──→ XCAFDoc_VisMaterial::FillAspect()  ←── VIEWER ONLY
    │                   └──→ Graphic3d_PBRMaterial ─┐
    │                   └──→ Graphic3d_BSDF ────────┤ TKService
    │                   └──→ Graphic3d_TextureSet ──┘ (GPU path)
    │
    └──→ XCAFDoc_MaterialTool (density, name)  ←── No TKService dependency
              └──→ STEPCAFControl_Writer (SetMaterialMode)
                        └──→ StepRepr_* (STEP physical material)
```

## References

- OCCT source: `repos/opencascade.js/deps/OCCT/src/Visualization/TKService/`
- `XCAFDoc_VisMaterial.cxx`: 25 references to `Graphic3d_*` (all in viewer-facing methods)
- `STEPCAFControl_Writer.cxx`: 0 direct `Graphic3d_*` imports (uses XCAF common model)
- `RWGltf_GltfMaterialMap.cxx`: reads `XCAFDoc_VisMaterialPBR` scalars, not `Graphic3d_PBRMaterial` instances
- Related: `docs/research/per-shape-pbr-appearance-v2.md`
- Related: `docs/research/occt-v8-rc5-migration.md`
- Build config: `repos/opencascade.js/bindgen-filters.yaml` (TKService exclusion)

## Appendix

### A. Full Graphic3d Class Classification

#### Portable Data Classes (28 types)

| Class                              | Category           |
| ---------------------------------- | ------------------ |
| `Graphic3d_PBRMaterial`            | Material           |
| `Graphic3d_MaterialAspect`         | Material           |
| `Graphic3d_BSDF`                   | Material           |
| `Graphic3d_Fresnel`                | Material           |
| `Graphic3d_Aspects`                | Material aggregate |
| `Graphic3d_PresentationAttributes` | Styling            |
| `Graphic3d_PolygonOffset`          | Styling            |
| `Graphic3d_HatchStyle`             | Styling            |
| `Graphic3d_CLight`                 | Lighting           |
| `Graphic3d_LightSet`               | Lighting           |
| `Graphic3d_Camera`                 | View math          |
| `Graphic3d_CameraTile`             | View math          |
| `Graphic3d_WorldViewProjState`     | View math          |
| `Graphic3d_Buffer`                 | Mesh data          |
| `Graphic3d_AttribBuffer`           | Mesh data          |
| `Graphic3d_BoundBuffer`            | Mesh data          |
| `Graphic3d_ArrayOfPrimitives`      | Mesh data          |
| `Graphic3d_Vertex`                 | Mesh data          |
| `Graphic3d_Text`                   | Text desc          |
| `Graphic3d_TransformPers`          | Transform          |
| `Graphic3d_TransformUtils`         | Transform          |
| `Graphic3d_BndBox3d`               | Bounds             |
| `Graphic3d_BndBox4d`               | Bounds             |
| `Graphic3d_BndBox4f`               | Bounds             |
| `Graphic3d_ViewAffinity`           | Display hint       |
| `Graphic3d_RenderingParams`        | Config             |
| `Graphic3d_FrameStatsData`         | Diagnostics        |
| `Graphic3d_DiagnosticInfo`         | Diagnostics        |

#### Enum-Only Types (20+ types)

`Graphic3d_AlphaMode`, `Graphic3d_NameOfMaterial`, `Graphic3d_TypeOfMaterial`, `Graphic3d_TypeOfReflection`, `Graphic3d_TypeOfShadingModel`, `Graphic3d_TypeOfLightSource`, `Graphic3d_TypeOfBackfacingModel`, `Graphic3d_ToneMappingMethod`, `Graphic3d_TypeOfLimit`, `Graphic3d_TypeOfConnection`, `Graphic3d_TypeOfStructure`, `Graphic3d_TypeOfTexture`, `Graphic3d_NameOfTexture2D`, `Graphic3d_NameOfTextureEnv`, `Graphic3d_LevelOfTextureAnisotropy`, `Graphic3d_RenderTransparentMethod`, `Graphic3d_StereoMode`, `Graphic3d_FresnelModel`, `Graphic3d_ClipState`, `Graphic3d_BufferType`.

### B. Image Package Complete Inventory

| Class                      | Pure Data?    | External Dep       | Usefulness                   |
| -------------------------- | ------------- | ------------------ | ---------------------------- |
| `Image_PixMap`             | Yes           | None               | High — pixel buffer          |
| `Image_PixMapData`         | Yes           | None               | High — row/slice layout      |
| `Image_PixMapTypedData<T>` | Yes           | None               | High — typed accessors       |
| `Image_AlienPixMap`        | No            | FreeImage or WIC   | Medium — format I/O          |
| `Image_Texture`            | Yes           | None (I/O in .cxx) | High — texture descriptor    |
| `Image_CompressedPixMap`   | Yes           | None               | Medium — compressed textures |
| `Image_DDSParser`          | Yes           | None               | Low — DDS specific           |
| `Image_Diff`               | Yes           | None               | Low — testing                |
| `Image_SupportedFormats`   | Yes           | None               | Low — capability query       |
| `Image_VideoRecorder`      | No            | FFmpeg             | None                         |
| `Image_Format`             | Yes (enum)    | None               | High — format negotiation    |
| `Image_CompressedFormat`   | Yes (enum)    | None               | Medium                       |
| `Image_Color*`             | Yes (structs) | None               | High — pixel types           |
