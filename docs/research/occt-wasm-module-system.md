---
title: 'OCCT WASM Module System: Native Export & Topology Blueprint'
description: 'Architecture for a modular WASM approach to GLTF export, STEP export, and topology inspection using native OpenCASCADE APIs across all kernel consumers.'
status: draft
created: '2026-03-28'
updated: '2026-03-28'
category: architecture
related:
  - docs/research/code-geometry-correlation.md
  - docs/research/observability-architecture.md
---

# OCCT WASM Module System: Native Export & Topology Blueprint

Architecture and blueprint for building reusable OCCT WASM modules that provide native GLTF export, STEP export, and topology inspection capabilities across all OpenCASCADE kernel consumers (replicad, opencascade.js direct, future kernels).

## Executive Summary

Tau currently has three separate approaches to geometry export: the Zoo kernel delegates to its engine, the OpenCascade kernel uses native `RWGltf_CafWriter`, and the Replicad kernel extracts mesh data in JavaScript and constructs GLTF manually. This fragmentation is expensive — the JS-side GLTF construction in the Replicad kernel is slower, less spec-compliant, and cannot leverage OCCT's native coordinate transforms, Draco compression, or multi-threaded meshing.

This document proposes a **shared WASM module pattern** — reusable C++ wrapper classes defined in YML `additionalCppCode` blocks that can be composed into any opencascade.js build variant. Three modules are designed: **GltfExporter** (native TopoDS → GLB), **StepExporter** (stream-based STEP I/O), and **TopologyInspector** (measurements, face/edge classification, and shape evolution tracking for code↔geometry correlation). Evidence from brepjs (1800-line YML with batch extractors), replicad-opencascadejs (282-line minimal build), and zalo/opencascade.js (OCCT 8.0 RC4 fork) informs the binding patterns and custom C++ approach.

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Current State Analysis](#current-state-analysis)
3. [Prior Art: YML-Based Custom C++ Patterns](#prior-art-yml-based-custom-c-patterns)
4. [OCCT Native Export API Surface](#occt-native-export-api-surface)
5. [Module Architecture](#module-architecture)
6. [Module 1: GltfExporter](#module-1-gltfexporter)
7. [Module 2: StepExporter](#module-2-stepexporter)
8. [Module 3: TopologyInspector](#module-3-topologyinspector)
9. [Integration Strategy](#integration-strategy)
10. [Missing Bindings Analysis](#missing-bindings-analysis)
11. [Build System Integration](#build-system-integration)
12. [Recommendations](#recommendations)
13. [Trade-offs](#trade-offs)

---

## Problem Statement

Three distinct problems drive this investigation:

1. **GLTF export fragmentation**: The Replicad kernel extracts vertices/normals/triangles on the JS side via `replicad-to-gltf.ts`, then constructs GLTF using a custom `glb-writer.js`. The OpenCascade kernel already uses native `RWGltf_CafWriter`. The Replicad approach is slower, bypasses OCCT's coordinate system conversion, and cannot support Draco compression or WASM multi-threading.

2. **Missing STEP/topology infrastructure for code↔geometry correlation**: The `code-geometry-correlation.md` research identifies the need for shape evolution tracking (`Modified()`, `Generated()`, `IsDeleted()`), topology inspection (face/edge classification, measurements), and STEP export — none of which exist as shared infrastructure across kernels.

3. **No reusable pattern for OCCT WASM extensions**: When new OCCT functionality is needed (e.g., BREP validation, tessellation control, measurement APIs), each kernel re-invents the binding approach. We need a composable system where OCCT capabilities are defined once and included in any build variant.

## Current State Analysis

### Kernel Export Approaches

| Kernel          | GLTF Export                                                         | STEP Export                                       | Topology Access                             | Native Handle                      |
| --------------- | ------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- | ---------------------------------- |
| **Replicad**    | JS-side: `renderOutput()` → `replicad-to-gltf.ts` → `glb-writer.js` | `replicad.exportSTEP()` (JS wrapper)              | None (shapes discarded after mesh)          | `InputShape[]` (replicad wrappers) |
| **OpenCascade** | Native: `meshShapesToGltf()` → `RWGltf_CafWriter`                   | `STEPControl_Writer` direct via oc instance       | `TopExp_Explorer` available but not exposed | `ShapeEntry[]` (TopoDS_Shape refs) |
| **Zoo (KCL)**   | Engine-side: `exportFromMemory({ type: 'gltf' })`                   | Engine-side: `exportFromMemory({ type: 'step' })` | Via artifact graph (engine-side)            | `Uint8Array` (GLB blob)            |

### Replicad WASM Build: What's Included vs Missing

The replicad-opencascadejs `custom_build_single.yml` (282 lines, ~220 symbols) includes foundational OCCT classes but notably **lacks** the GLTF export chain:

**Included** (relevant to export/inspection):

- `STEPControl_Writer`, `STEPControl_Reader`, `STEPCAFControl_Writer`
- `TDocStd_Document`, `XCAFDoc_DocumentTool`, `XCAFDoc_ShapeTool`, `XCAFDoc_ColorTool`
- `BRepMesh_IncrementalMesh`, `BRepGProp`, `GProp_GProps`
- `TopExp_Explorer`, `BRep_Tool`, `BRepAdaptor_Surface`, `BRepAdaptor_Curve`
- `GeomAbs_CurveType`, `GeomAbs_SurfaceType`

**Missing** (required for native GLTF export):

- `RWGltf_CafWriter` — the native GLTF/GLB writer
- `RWMesh_CoordinateSystemConverter` — Z-up → Y-up conversion
- `RWMesh_CoordinateSystem` — coordinate system enum
- `TColStd_IndexedDataMapOfStringString` — file info metadata
- `TCollection_AsciiString` — writer path input

### OpenCascade Kernel: Already Has Everything

The `opencascade_full.wasm` build includes `RWGltf_CafWriter` and all export infrastructure. The existing `opencascade-mesh.ts` demonstrates the complete pattern:

```typescript
// Already working in opencascade-mesh.ts
const writer = new oc.RWGltf_CafWriter(writerPath, true);
const converter = new oc.RWMesh_CoordinateSystemConverter();
converter.SetInputLengthUnit(0.001);
converter.SetInputCoordinateSystem(oc.RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Zup);
converter.SetOutputCoordinateSystem(oc.RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_glTF);
writer.SetCoordinateSystemConverter(converter);
writer.Perform(document, fileInfo, progress);
```

## Prior Art: YML-Based Custom C++ Patterns

### Finding 1: brepjs — Comprehensive Batch Extractors (1812-line YML)

brepjs defines its entire OCCT WASM build in a single `brepjs.yml` file with three sections:

- **`bindings`** (~297 symbols): OCCT class allowlist driving linker inclusion
- **`additionalBindCode`** (~50 lines): Manual `EMSCRIPTEN_BINDINGS` blocks for edge cases (PCH conflicts, out-param wrappers)
- **`additionalCppCode`** (~1450 lines): Custom C++ classes compiled and bound automatically

Key custom classes from brepjs that are directly relevant to our module system:

| Class                  | Purpose                                                                                                  | Lines |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ----- |
| `TopologyExtractor`    | Batch topology traversal — extracts all faces/edges/vertices via `TopExp_Explorer` in a single WASM call | ~50   |
| `MeasurementExtractor` | Volume, area, linear properties, center of mass, bounding box — all in one call                          | ~70   |
| `EvolutionExtractor`   | Shape history tracking via `BRepBuilderAPI_MakeShape::Modified/Generated/IsDeleted`                      | ~80   |
| `MeshExtractor`        | Batch triangulation extraction with face groups                                                          | ~60   |
| `StepStreamIO`         | Stream-based STEP import/export (no filesystem temp files)                                               | ~25   |
| `BooleanPipeline`      | Multi-step boolean operations with evolution tracking                                                    | ~200  |

**Critical insight**: brepjs's `EvolutionExtractor` is the exact mechanism needed for code↔geometry correlation. It tracks how faces transform through boolean operations using shape hash codes, mapping `inputFaceHash → [outputFaceHash1, outputFaceHash2, ...]` for modifications and generations, plus a deleted set.

### Finding 2: replicad-opencascadejs — Minimal Custom Code (40 lines)

replicad-opencascadejs keeps custom code minimal:

- `OCJS_ShapeHasher` — `std::hash<TopoDS_Shape>` wrapper
- `BRepToolsWrapper` — `BRepTools::Write/Read` via `std::ostringstream` (BREP serialization)
- `GeomToolsWrapper` — `GeomTools::Write/Read` for `Geom2d_Curve` (2D geometry serialization)

This demonstrates the **minimum viable** custom code pattern: thin static wrappers around OCCT APIs that are hard to bind automatically (out-parameters, stream I/O, complex overloads).

### Finding 3: zalo/opencascade.js — OCCT 8.0 + Custom Mesh Subclass

The zalo fork (CascadeStudio v2) demonstrates:

- **Include filters**: `filterIncludeFiles.py` blocks headers that break WASM compilation (e.g., `RWGltf_GltfJsonParser.hxx` — rapidjson + C++17 issues). The actual `RWGltf_CafWriter` can still be bound via other headers.
- **Custom meshing**: `BRepMesh_IncrementalMeshWrapper` subclass implementing two-pass Watson + DelaBella meshing
- **Website YML variant**: A separate `customBuild.yml` for the web editor that includes `RWGltf_CafWriter`, `TDocStd_Document`, `XCAFDoc_*` — proving the pattern works for GLTF export bindings

### Finding 4: Build Pipeline Architecture

All three projects share the same opencascade.js Docker-based pipeline:

```
YML Config → Docker (buildFromYaml.py) → WASM + JS + .d.ts

Pipeline stages:
1. Validate YAML (Cerberus schema)
2. generateCustomCodeBindings(additionalCppCode) → .cpp + .d.ts.json
3. compileCustomCodeBindings → .o
4. Compile additionalBindCode → .o
5. Link: allowlisted binding .o + OCCT source .o + custom .o → final WASM
```

The key constraint: **all custom C++ classes operate within the same WASM address space** as the OCCT runtime. There is no inter-module communication — everything shares memory. This means TopoDS_Shape pointers are directly usable by custom wrapper classes without serialization.

## OCCT Native Export API Surface

### GLTF Export Chain (TopoDS_Shape → GLB)

Minimal dependency chain identified from OCCT source headers:

```
TopoDS_Shape
  → BRepMesh_IncrementalMesh (tessellate faces)
  → TDocStd_Document (XCAF document container)
    → XCAFDoc_DocumentTool::ShapeTool (add shapes)
    → XCAFDoc_DocumentTool::ColorTool (optional: add colors)
  → RWGltf_CafWriter (path, isBinary=true)
    → RWMesh_CoordinateSystemConverter (Z-up → glTF Y-up)
    → writer.Perform(document, fileInfo, progress)
  → FS.readFile (read GLB from Emscripten virtual filesystem)
```

OCCT toolkit dependencies: `TKLCAF` + `TKXCAF` + `TKMesh` + `TKDEGLTF` + `TKRWMesh`

### STEP Export Chain (TopoDS_Shape → STEP string)

Stream-based approach (no temp files):

```
TopoDS_Shape
  → STEPControl_Writer
    → Transfer(shape, STEPControl_AsIs)
    → WriteStream(ostringstream)
  → return string
```

OCCT toolkit: `TKDESTEP`

### Topology Inspection Chain

```
TopoDS_Shape
  → TopExp_Explorer (iterate faces/edges/vertices)
    → BRep_Tool::Surface(face) → GeomAdaptor_Surface::GetType()
    → BRep_Tool::Curve(edge) → GeomAdaptor_Curve::GetType()
  → BRepGProp (area, volume, linear properties)
  → GProp_GProps (center of mass, inertia)
  → BRepBndLib (bounding box)
```

### Shape Evolution Chain (for code↔geometry correlation)

```
BRepBuilderAPI_MakeShape (any modeling op)
  → Modified(inputFace) → list of output faces
  → Generated(inputFace) → list of new faces created
  → IsDeleted(inputFace) → was face consumed?
  + TopTools_ShapeMapHasher for stable face identification
```

## Module Architecture

### Design Principle: Shared C++ Fragments

Rather than separate WASM binaries (which cannot share memory), the module system is a set of **reusable C++ code fragments** that are composed into any opencascade.js build variant via the `additionalCppCode` YML section. Each "module" is:

1. **A C++ class** with static methods (following brepjs's pattern)
2. **A symbol entry** in the `bindings` list (so Embind auto-generates the JS glue)
3. **A set of required OCCT symbol dependencies** that must also be in the `bindings` list

```
┌─────────────────────────────────────────────────────┐
│              opencascade.js Build Config             │
│                                                     │
│  bindings:                                          │
│    - symbol: <kernel-specific OCCT classes>          │
│    - symbol: <module dependency symbols>             │
│    - symbol: TauGltfExporter        ← module class  │
│    - symbol: TauStepExporter        ← module class  │
│    - symbol: TauTopologyInspector   ← module class  │
│                                                     │
│  additionalCppCode: |                               │
│    // ---- Module: GltfExporter ----                 │
│    class TauGltfExporter { ... };                    │
│    // ---- Module: StepExporter ----                 │
│    class TauStepExporter { ... };                    │
│    // ---- Module: TopologyInspector ----             │
│    class TauTopologyInspector { ... };               │
└─────────────────────────────────────────────────────┘
```

### Naming Convention

All Tau custom classes use the `Tau` prefix to avoid collisions with OCCT, replicad, and brepjs namespaces. This is visible in build manifests and `.d.ts` output.

## Module 1: GltfExporter

### Purpose

Convert one or more `TopoDS_Shape` objects into a spec-compliant GLB binary, entirely within WASM. Replaces the JS-side `replicad-to-gltf.ts` + `glb-writer.js` pipeline.

### Required OCCT Bindings

Symbols that must be in the `bindings` list (beyond what replicad already includes):

```yaml
# GLTF export chain (currently missing from replicad build)
- symbol: RWGltf_CafWriter
- symbol: RWMesh_CoordinateSystemConverter
- symbol: RWMesh_CoordinateSystem
- symbol: TColStd_IndexedDataMapOfStringString
- symbol: TCollection_AsciiString
- symbol: Quantity_TypeOfColor
```

Symbols already included in replicad's build:

```yaml
# Already present
- symbol: TDocStd_Document
- symbol: XCAFDoc_DocumentTool
- symbol: XCAFDoc_ShapeTool
- symbol: XCAFDoc_ColorTool
- symbol: BRepMesh_IncrementalMesh
- symbol: TCollection_ExtendedString
- symbol: Quantity_Color
- symbol: Quantity_ColorRGBA
- symbol: XCAFDoc_ColorType
- symbol: TDF_Label
- symbol: Message_ProgressRange
```

### C++ Implementation

```cpp
class TauGltfExporter {
public:
  struct ShapeInput {
    TopoDS_Shape shape;
    double colorR, colorG, colorB, alpha;
    bool hasColor;
  };

  // Export a single shape to GLB, returning the binary size.
  // GLB data written to Emscripten FS, caller reads with FS.readFile().
  static int exportGlb(
    const TopoDS_Shape& shape,
    double linearDeflection,
    double angularDeflection,
    const char* outputPath
  ) {
    if (shape.IsNull()) return 0;

    // Mesh the shape
    BRepMesh_IncrementalMesh mesh(shape, linearDeflection, false, angularDeflection, false);

    // Create XCAF document
    TCollection_ExtendedString docName;
    opencascade::handle<TDocStd_Document> doc = new TDocStd_Document(docName);
    auto mainLabel = doc->Main();
    auto shapeTool = XCAFDoc_DocumentTool::ShapeTool(mainLabel);

    auto label = shapeTool->NewShape();
    shapeTool->SetShape(label, shape);

    // Configure writer
    TCollection_AsciiString path(outputPath);
    RWGltf_CafWriter writer(path, true); // true = binary GLB

    RWMesh_CoordinateSystemConverter converter;
    converter.SetInputLengthUnit(0.001);  // mm → m
    converter.SetInputCoordinateSystem(RWMesh_CoordinateSystem_Zup);
    converter.SetOutputLengthUnit(1.0);
    converter.SetOutputCoordinateSystem(RWMesh_CoordinateSystem_glTF);
    writer.SetCoordinateSystemConverter(converter);

    Message_ProgressRange progress;
    TColStd_IndexedDataMapOfStringString fileInfo;
    writer.Perform(doc, fileInfo, progress);

    label->Nullify(); // cleanup
    return 1;
  }

  // Export multiple shapes with colors to GLB
  static int exportGlbMulti(
    const TopoDS_Shape* shapes,
    const double* colors, // [r,g,b,a] × N, or nullptr
    int shapeCount,
    double linearDeflection,
    double angularDeflection,
    const char* outputPath
  ) {
    TCollection_ExtendedString docName;
    opencascade::handle<TDocStd_Document> doc = new TDocStd_Document(docName);
    auto mainLabel = doc->Main();
    auto shapeTool = XCAFDoc_DocumentTool::ShapeTool(mainLabel);
    auto colorTool = XCAFDoc_DocumentTool::ColorTool(mainLabel);

    for (int i = 0; i < shapeCount; i++) {
      if (shapes[i].IsNull()) continue;

      BRepMesh_IncrementalMesh mesh(shapes[i], linearDeflection, false, angularDeflection, false);
      auto label = shapeTool->NewShape();
      shapeTool->SetShape(label, shapes[i]);

      if (colors) {
        Quantity_Color c(colors[i*4], colors[i*4+1], colors[i*4+2], Quantity_TOC_sRGB);
        colorTool->SetColor(label, c, XCAFDoc_ColorSurf);
      }
    }

    TCollection_AsciiString path(outputPath);
    RWGltf_CafWriter writer(path, true);

    RWMesh_CoordinateSystemConverter converter;
    converter.SetInputLengthUnit(0.001);
    converter.SetInputCoordinateSystem(RWMesh_CoordinateSystem_Zup);
    converter.SetOutputLengthUnit(1.0);
    converter.SetOutputCoordinateSystem(RWMesh_CoordinateSystem_glTF);
    writer.SetCoordinateSystemConverter(converter);

    Message_ProgressRange progress;
    TColStd_IndexedDataMapOfStringString fileInfo;
    writer.Perform(doc, fileInfo, progress);
    return shapeCount;
  }
};
```

### JS Consumption Pattern

```typescript
// In kernel code (replicad.kernel.ts or opencascade.kernel.ts)
function exportToGlb(oc: OpenCascadeInstance, shape: TopoDS_Shape, options: MeshOptions): Uint8Array {
  const outputPath = `/tmp/export_${Date.now()}.glb`;
  oc.TauGltfExporter.exportGlb(shape, options.linearTolerance, options.angularTolerance * (Math.PI / 180), outputPath);
  const glbData = oc.FS.readFile(outputPath, { encoding: 'binary' });
  oc.FS.unlink(outputPath);
  return new Uint8Array(glbData);
}
```

### Impact

Replaces the current three-file JS pipeline (`render-output.ts` → `replicad-to-gltf.ts` → `glb-writer.js`) with a single WASM call. Benefits:

- **Spec compliance**: OCCT's `RWGltf_CafWriter` produces fully compliant glTF 2.0
- **Coordinate system**: Native Z-up → Y-up conversion (currently done manually in `transformVertexArray`)
- **Units**: Proper mm → meter conversion via `SetInputLengthUnit`
- **Performance**: All vertex/normal/index construction happens in WASM, not JS
- **Future-proofing**: Enables Draco compression, parallel meshing, and PBR materials via OCCT options

## Module 2: StepExporter

### Purpose

Stream-based STEP import/export that avoids Emscripten filesystem temp files for the common case. Follows brepjs's `StepStreamIO` pattern but with additional schema control.

### Required OCCT Bindings

All already present in replicad's build:

```yaml
- symbol: STEPControl_Writer
- symbol: STEPControl_Reader
- symbol: STEPControl_StepModelType
- symbol: IFSelect_ReturnStatus
- symbol: Interface_Static
- symbol: XSControl_WorkSession
```

### C++ Implementation

```cpp
class TauStepExporter {
public:
  // Export shape to STEP string (no temp files)
  static std::string exportStep(const TopoDS_Shape& shape, int schema) {
    STEPControl_Writer writer;
    Interface_Static::SetIVal("write.step.schema", schema);
    writer.Model(Standard_True);
    Message_ProgressRange progress;
    writer.Transfer(shape, STEPControl_AsIs, Standard_True, progress);
    std::ostringstream oss;
    writer.WriteStream(oss);
    return oss.str();
  }

  // Import STEP from string
  static TopoDS_Shape importStep(const std::string& data) {
    std::istringstream iss(data);
    STEPControl_Reader reader;
    if (reader.ReadStream("memory.step", iss) != IFSelect_RetDone) {
      return TopoDS_Shape();
    }
    Message_ProgressRange progress;
    reader.TransferRoots(progress);
    return reader.OneShape();
  }

  // Export with assembly structure via XCAF
  static std::string exportStepAssembly(
    const TopoDS_Shape* shapes,
    const char** names,
    int count
  ) {
    // Uses STEPCAFControl_Writer for named assembly export
    // ... (implementation follows STEPCAFControl_Writer pattern)
    return "";
  }
};
```

### Impact

- Eliminates temp file I/O for STEP export (currently `opencascade.kernel.ts` writes to `/tmp/` then reads back)
- Stream-based approach is faster and avoids Emscripten FS overhead
- Consistent across both kernel consumers

## Module 3: TopologyInspector

### Purpose

Batch topology interrogation: face/edge classification, measurements, and shape evolution tracking. This is the critical module for enabling `code-geometry-correlation.md`.

### Required OCCT Bindings

All already present in replicad's build:

```yaml
- symbol: TopExp_Explorer
- symbol: BRepGProp
- symbol: GProp_GProps
- symbol: BRep_Tool
- symbol: BRepAdaptor_Surface
- symbol: BRepAdaptor_Curve
- symbol: GeomAbs_CurveType
- symbol: GeomAbs_SurfaceType
- symbol: BRepBndLib
- symbol: TopAbs_ShapeEnum
```

### C++ Implementation

Three sub-classes covering topology, measurement, and evolution:

```cpp
// ---- Topology extraction (batch) ----
class TauTopologyResult {
public:
  TauTopologyResult() : shapesPtr_(nullptr), count_(0) {}
  ~TauTopologyResult() { delete[] shapesPtr_; }

  int getCount() const { return count_; }
  TopoDS_Shape getShape(int index) const {
    if (index < 0 || index >= count_ || !shapesPtr_) return TopoDS_Shape();
    return shapesPtr_[index];
  }

private:
  TopoDS_Shape* shapesPtr_;
  int count_;
  friend class TauTopologyInspector;
};

class TauTopologyInspector {
public:
  // Extract all sub-shapes of a given type (faces, edges, vertices)
  static TauTopologyResult extractShapes(
    const TopoDS_Shape& shape, int shapeType
  ) {
    TopAbs_ShapeEnum topoType = static_cast<TopAbs_ShapeEnum>(shapeType);
    NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher> seen;
    std::vector<TopoDS_Shape> shapes;

    for (TopExp_Explorer ex(shape, topoType); ex.More(); ex.Next()) {
      if (seen.Add(ex.Current())) {
        shapes.push_back(ex.Current());
      }
    }

    TauTopologyResult result;
    result.count_ = static_cast<int>(shapes.size());
    if (result.count_ > 0) {
      result.shapesPtr_ = new TopoDS_Shape[result.count_];
      for (int i = 0; i < result.count_; i++) {
        result.shapesPtr_[i] = shapes[i];
      }
    }
    return result;
  }

  // Classify a face: returns GeomAbs_SurfaceType as int
  static int classifyFace(const TopoDS_Face& face) {
    BRepAdaptor_Surface adaptor(face, Standard_True);
    return static_cast<int>(adaptor.GetType());
  }

  // Classify an edge: returns GeomAbs_CurveType as int
  static int classifyEdge(const TopoDS_Edge& edge) {
    BRepAdaptor_Curve adaptor(edge);
    return static_cast<int>(adaptor.GetType());
  }

  // Get face normal at UV center
  static void faceNormal(
    const TopoDS_Face& face, double* outXYZ
  ) {
    BRepAdaptor_Surface adaptor(face, Standard_True);
    double uMid = (adaptor.FirstUParameter() + adaptor.LastUParameter()) / 2.0;
    double vMid = (adaptor.FirstVParameter() + adaptor.LastVParameter()) / 2.0;
    gp_Pnt p;
    gp_Vec du, dv;
    adaptor.D1(uMid, vMid, p, du, dv);
    gp_Vec normal = du.Crossed(dv);
    if (normal.Magnitude() > Precision::Confusion()) {
      normal.Normalize();
    }
    outXYZ[0] = normal.X();
    outXYZ[1] = normal.Y();
    outXYZ[2] = normal.Z();
  }

  // Batch shape hash codes for face group correlation
  static int shapeHashCode(const TopoDS_Shape& shape) {
    return static_cast<int>(std::hash<TopoDS_Shape>{}(shape));
  }
};

// ---- Measurement (batch) ----
class TauMeasurementResult {
public:
  TauMeasurementResult() : dataPtr_(nullptr), dataSize_(0) {}
  ~TauMeasurementResult() { std::free(dataPtr_); }

  int getDataPtr() const {
    return static_cast<int>(reinterpret_cast<uintptr_t>(dataPtr_));
  }
  int getDataSize() const { return dataSize_; }

private:
  double* dataPtr_;
  int dataSize_;
  friend class TauMeasurement;
};

class TauMeasurement {
public:
  // Extract volume, area, linear length, center of mass, bounding box
  // Returns flat double array: [volume, area, length, cx, cy, cz,
  //                             xmin, ymin, zmin, xmax, ymax, zmax]
  static TauMeasurementResult measure(
    const TopoDS_Shape& shape, bool includeLinear
  ) {
    TauMeasurementResult result;
    result.dataSize_ = 12;
    result.dataPtr_ = static_cast<double*>(std::malloc(12 * sizeof(double)));

    GProp_GProps volProps;
    BRepGProp::VolumeProperties(shape, volProps, Standard_True);
    result.dataPtr_[0] = volProps.Mass();

    GProp_GProps surfProps;
    BRepGProp::SurfaceProperties(shape, surfProps, 1e-7, Standard_True);
    result.dataPtr_[1] = surfProps.Mass();

    if (includeLinear) {
      GProp_GProps linProps;
      BRepGProp::LinearProperties(shape, linProps, Standard_True);
      result.dataPtr_[2] = linProps.Mass();
    } else {
      result.dataPtr_[2] = 0.0;
    }

    gp_Pnt center = volProps.CentreOfMass();
    result.dataPtr_[3] = center.X();
    result.dataPtr_[4] = center.Y();
    result.dataPtr_[5] = center.Z();

    Bnd_Box box;
    BRepBndLib::Add(shape, box, Standard_True);
    if (!box.IsVoid()) {
      double xMin, yMin, zMin, xMax, yMax, zMax;
      box.Get(xMin, yMin, zMin, xMax, yMax, zMax);
      result.dataPtr_[6] = xMin;  result.dataPtr_[7] = yMin;  result.dataPtr_[8] = zMin;
      result.dataPtr_[9] = xMax;  result.dataPtr_[10] = yMax; result.dataPtr_[11] = zMax;
    }
    return result;
  }

  // Measure a single face: area + surface type + normal + center
  // Returns: [area, surfaceType, nx, ny, nz, cx, cy, cz]
  static TauMeasurementResult measureFace(const TopoDS_Face& face) {
    TauMeasurementResult result;
    result.dataSize_ = 8;
    result.dataPtr_ = static_cast<double*>(std::malloc(8 * sizeof(double)));

    GProp_GProps props;
    BRepGProp::SurfaceProperties(face, props, 1e-7, Standard_True);
    result.dataPtr_[0] = props.Mass(); // area

    BRepAdaptor_Surface adaptor(face, Standard_True);
    result.dataPtr_[1] = static_cast<double>(adaptor.GetType());

    // Normal at UV center
    double uMid = (adaptor.FirstUParameter() + adaptor.LastUParameter()) / 2.0;
    double vMid = (adaptor.FirstVParameter() + adaptor.LastVParameter()) / 2.0;
    gp_Pnt p;
    gp_Vec du, dv;
    adaptor.D1(uMid, vMid, p, du, dv);
    gp_Vec normal = du.Crossed(dv);
    if (normal.Magnitude() > Precision::Confusion()) normal.Normalize();

    result.dataPtr_[2] = normal.X();
    result.dataPtr_[3] = normal.Y();
    result.dataPtr_[4] = normal.Z();

    gp_Pnt center = props.CentreOfMass();
    result.dataPtr_[5] = center.X();
    result.dataPtr_[6] = center.Y();
    result.dataPtr_[7] = center.Z();
    return result;
  }
};

// ---- Shape Evolution Tracking ----
class TauEvolutionResult {
public:
  TauEvolutionResult()
    : modifiedPtr_(nullptr), generatedPtr_(nullptr), deletedPtr_(nullptr),
      modifiedSize_(0), generatedSize_(0), deletedSize_(0) {}

  ~TauEvolutionResult() {
    std::free(modifiedPtr_);
    std::free(generatedPtr_);
    std::free(deletedPtr_);
  }

  int getModifiedPtr() const  { return static_cast<int>(reinterpret_cast<uintptr_t>(modifiedPtr_)); }
  int getGeneratedPtr() const { return static_cast<int>(reinterpret_cast<uintptr_t>(generatedPtr_)); }
  int getDeletedPtr() const   { return static_cast<int>(reinterpret_cast<uintptr_t>(deletedPtr_)); }
  int getModifiedSize() const  { return modifiedSize_; }
  int getGeneratedSize() const { return generatedSize_; }
  int getDeletedSize() const   { return deletedSize_; }

private:
  int32_t* modifiedPtr_;
  int32_t* generatedPtr_;
  int32_t* deletedPtr_;
  int modifiedSize_, generatedSize_, deletedSize_;
  friend class TauEvolutionTracker;
};

class TauEvolutionTracker {
public:
  // Track how faces evolve through a modeling operation.
  // Uses BRepBuilderAPI_MakeShape::Modified/Generated/IsDeleted.
  // Returns packed int32 arrays:
  //   modified: [inputHash, outputCount, outHash1, outHash2, ...]
  //   generated: [inputHash, outputCount, outHash1, outHash2, ...]
  //   deleted: [inputHash1, inputHash2, ...]
  static TauEvolutionResult track(
    BRepBuilderAPI_MakeShape& builder,
    const TopoDS_Shape& inputShape,
    int hashUpperBound
  ) {
    NCollection_DataMap<int, TopoDS_Shape> facesByHash;
    for (TopExp_Explorer ex(inputShape, TopAbs_FACE); ex.More(); ex.Next()) {
      const TopoDS_Face& face = TopoDS::Face(ex.Current());
      int hash = static_cast<int>(TopTools_ShapeMapHasher{}(face) % hashUpperBound);
      if (!facesByHash.IsBound(hash)) facesByHash.Bind(hash, face);
    }

    std::vector<int32_t> modBuf, genBuf, delBuf;
    for (auto it = facesByHash.cbegin(); it != facesByHash.cend(); ++it) {
      int inputHash = it->first;
      const TopoDS_Shape& face = it->second;

      if (builder.IsDeleted(face)) {
        delBuf.push_back(inputHash);
        continue;
      }

      const TopTools_ListOfShape& modList = builder.Modified(face);
      if (modList.Size() > 0) {
        modBuf.push_back(inputHash);
        modBuf.push_back(modList.Size());
        for (auto lit = modList.cbegin(); lit != modList.cend(); ++lit) {
          modBuf.push_back(static_cast<int>(TopTools_ShapeMapHasher{}(*lit) % hashUpperBound));
        }
      }

      const TopTools_ListOfShape& genList = builder.Generated(face);
      if (genList.Size() > 0) {
        genBuf.push_back(inputHash);
        genBuf.push_back(genList.Size());
        for (auto lit = genList.cbegin(); lit != genList.cend(); ++lit) {
          genBuf.push_back(static_cast<int>(TopTools_ShapeMapHasher{}(*lit) % hashUpperBound));
        }
      }
    }

    TauEvolutionResult result;
    // ... pack buffers into result (same pattern as brepjs EvolutionExtractor)
    return result;
  }
};
```

### Impact on Code↔Geometry Correlation

The `TauEvolutionTracker` directly enables the architecture described in `code-geometry-correlation.md`:

1. Each Replicad API call (fillet, extrude, boolean) creates a `BRepBuilderAPI_MakeShape`
2. After the operation, `TauEvolutionTracker.track(builder, inputShape, hashBound)` maps input face hashes → output face hashes
3. Combined with source map callsite capture (already in `oc-tracing.ts`), this creates the full chain: **source code line → API call → input faces → output faces → mesh face groups**

## Integration Strategy

### Phase 1: Add GLTF Export to Replicad Build

Add the missing ~6 symbols to `replicad-opencascadejs/build-config/custom_build_single.yml` and define `TauGltfExporter` in `additionalCppCode`. This immediately unifies both kernels on native GLTF export.

**Estimated WASM size impact**: `RWGltf_CafWriter` and dependencies add ~200-400 KB to the WASM binary (based on the delta between replicad's current ~14 MB and opencascade-full's ~22 MB, discounting unrelated symbols).

### Phase 2: Add Topology Inspection

Define `TauTopologyInspector`, `TauMeasurement`, and `TauTopologyResult` in `additionalCppCode`. No new bindings needed — all OCCT symbols are already present.

### Phase 3: Add Evolution Tracking

Define `TauEvolutionTracker` and `TauEvolutionResult`. Requires `BRepBuilderAPI_MakeShape` to be accessible — already included via `BRepBuilderAPI_MakeShape`, `BRepAlgoAPI_Cut`, etc.

### Phase 4: Shared TypeScript Layer

Create `packages/runtime/src/utils/occt-modules.ts` with typed wrappers:

```typescript
export function exportShapeToGlb(oc: OcInstance, shape: TopoDS_Shape, options: MeshOptions): Uint8Array;
export function exportShapeToStep(oc: OcInstance, shape: TopoDS_Shape, schema?: number): string;
export function inspectTopology(oc: OcInstance, shape: TopoDS_Shape): TopologyInfo;
export function measureShape(oc: OcInstance, shape: TopoDS_Shape): MeasurementData;
export function trackEvolution(oc: OcInstance, builder: BRepBuilderAPI_MakeShape, input: TopoDS_Shape): EvolutionData;
```

Both `replicad.kernel.ts` and `opencascade.kernel.ts` consume these shared utilities instead of reimplementing export logic.

## Missing Bindings Analysis

### Replicad Build: Symbols to Add

| Symbol                                 | Required By  | Impact                   |
| -------------------------------------- | ------------ | ------------------------ |
| `RWGltf_CafWriter`                     | GltfExporter | Core GLTF writer         |
| `RWMesh_CoordinateSystemConverter`     | GltfExporter | Axis/unit conversion     |
| `RWMesh_CoordinateSystem`              | GltfExporter | Coordinate system enum   |
| `TColStd_IndexedDataMapOfStringString` | GltfExporter | File info metadata       |
| `TCollection_AsciiString`              | GltfExporter | Writer path string       |
| `Quantity_TypeOfColor`                 | GltfExporter | sRGB color specification |

### OpenCascade Full Build: No Changes Needed

The `opencascade_full.wasm` already includes all required symbols. The custom C++ classes would be added to its YML config.

### Symbols Already Available for Topology/Measurement

Both builds already include: `TopExp_Explorer`, `BRepGProp`, `GProp_GProps`, `BRep_Tool`, `BRepAdaptor_Surface`, `BRepAdaptor_Curve`, `GeomAbs_SurfaceType`, `GeomAbs_CurveType`, `BRepBndLib`, `TopTools_ShapeMapHasher` (via `OCJS_ShapeHasher`), `BRepBuilderAPI_MakeShape` (and all subclasses).

## Build System Integration

### File Organization

```
repos/opencascade.js/
  build-configs/
    tau-modules/
      gltf-exporter.cpp      # TauGltfExporter class
      step-exporter.cpp       # TauStepExporter class
      topology-inspector.cpp  # TauTopologyInspector + TauMeasurement
      evolution-tracker.cpp   # TauEvolutionTracker
      modules.yml             # Combined symbol requirements

repos/replicad/
  packages/replicad-opencascadejs/
    build-config/
      custom_build_single.yml  # + new symbols + additionalCppCode
```

### YML Composition Pattern

Use `additionalCppFiles` (supported by opencascade.js schema) to keep modules as separate C++ files that are concatenated into the build:

```yaml
additionalCppCode: |
  // Existing replicad wrappers
  class OCJS_ShapeHasher { ... };
  class BRepToolsWrapper { ... };
  class GeomToolsWrapper { ... };

additionalCppFiles:
  - ../tau-modules/gltf-exporter.cpp
  - ../tau-modules/step-exporter.cpp
  - ../tau-modules/topology-inspector.cpp
  - ../tau-modules/evolution-tracker.cpp
```

This keeps modules maintainable while producing a single WASM binary.

## Recommendations

| #   | Action                                                           | Priority | Effort | Impact                                                  |
| --- | ---------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------- |
| R1  | Add `RWGltf_CafWriter` + 5 symbols to replicad-opencascadejs YML | P0       | Low    | Unblocks native GLTF export for replicad kernel         |
| R2  | Implement `TauGltfExporter` C++ class in `additionalCppCode`     | P0       | Medium | Replaces JS-side GLTF construction, single WASM call    |
| R3  | Replace `replicad-to-gltf.ts` with `TauGltfExporter` in kernel   | P0       | Medium | Eliminates 3-file JS pipeline, improves spec compliance |
| R4  | Implement `TauStepExporter` with stream I/O                      | P1       | Low    | Eliminates temp files for STEP export                   |
| R5  | Implement `TauTopologyInspector` + `TauMeasurement`              | P1       | Medium | Enables face/edge inspection for UI panels              |
| R6  | Implement `TauEvolutionTracker`                                  | P1       | Medium | Critical for code↔geometry correlation                  |
| R7  | Create shared `occt-modules.ts` TypeScript layer                 | P1       | Low    | Consistent API across kernels                           |
| R8  | Rebuild replicad WASM with new modules                           | P2       | Medium | Requires Docker build + npm pack + tarball update       |
| R9  | Add face group metadata to GLTF export (GLTF extras)             | P2       | Medium | Preserves face indices through GLTF for UI selection    |
| R10 | Evaluate WASM multi-threading for mesh + export                  | P3       | High   | Performance gains via `-pthread` + `SharedArrayBuffer`  |

## Trade-offs

### Single WASM vs Multiple WASM Modules

| Approach                      | Pros                                                                                | Cons                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Single WASM** (recommended) | Shared memory — no serialization between modules; simpler deployment; one load time | Larger binary; all-or-nothing inclusion                                                                         |
| **Multiple WASM**             | Lazy loading; smaller initial payload                                               | Cannot share `TopoDS_Shape` pointers across modules; requires BRep serialization round-trips; complex lifecycle |

**Verdict**: Single WASM with `additionalCppCode` is the only viable approach. WASM modules are memory-isolated — a `TopoDS_Shape` pointer from one module is meaningless in another. Serialization via `BRepToolsWrapper::Write/Read` would negate any performance gains.

### Custom C++ in YML vs Separate Files

| Approach                 | Pros                                                           | Cons                                                                          |
| ------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Inline in YML**        | Single source of truth; visible in build config diff           | Hard to test independently; YAML string escaping pain; large YML files        |
| **`additionalCppFiles`** | Proper `.cpp` files with IDE support; testable; manageable PRs | Requires file path coordination; not supported by all opencascade.js versions |

**Verdict**: Start inline in YML (proven by brepjs at 1800 lines), extract to `additionalCppFiles` once module count exceeds 3.

### Native GLTF vs JS-Side GLTF

| Approach                                    | Pros                                                                                                          | Cons                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Native `RWGltf_CafWriter`** (recommended) | Spec-compliant; handles coordinate transforms; supports Draco, PBR, parallel meshing; all computation in WASM | Adds ~200-400 KB to WASM binary; requires XCAF document boilerplate                                                 |
| **JS-side `glb-writer.js`** (current)       | No WASM changes needed; full control over output format                                                       | Manual vertex extraction; no Draco; no native coordinate transforms; slower; custom GLTF implementation to maintain |

**Verdict**: Native GLTF export. The OpenCascade kernel already uses it successfully. The WASM size increase is minor relative to the current ~14 MB binary.

## References

- `repos/brepjs/packages/brepjs-opencascade/build-config/brepjs.yml` — Complete 1812-line YML with batch extractors
- `repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single.yml` — Replicad's 282-line minimal build
- `repos/zalo-opencascade.js/builds/cascadestudio.yml` — CascadeStudio OCCT 8 build config
- `repos/opencascade.js/src/customBuildSchema.py` — Authoritative YML schema (Cerberus)
- `repos/OCCT/src/DataExchange/TKDEGLTF/RWGltf/RWGltf_CafWriter.hxx` — GLTF writer header
- `repos/OCCT/src/DataExchange/TKDESTEP/STEPControl/STEPControl_Writer.hxx` — STEP writer header
- `packages/runtime/src/kernels/opencascade/opencascade-mesh.ts` — Existing native GLTF export in OpenCascade kernel
- `packages/runtime/src/kernels/replicad/utils/replicad-to-gltf.ts` — Current JS-side GLTF construction
- Related: `docs/research/code-geometry-correlation.md` — Architecture for bidirectional code↔geometry mapping

## Appendix: OCCT Surface Type Enum Reference

Values returned by `TauTopologyInspector::classifyFace()` (from `GeomAbs_SurfaceType`):

| Value | Type                          | Description           |
| ----- | ----------------------------- | --------------------- |
| 0     | `GeomAbs_Plane`               | Flat face             |
| 1     | `GeomAbs_Cylinder`            | Cylindrical surface   |
| 2     | `GeomAbs_Cone`                | Conical surface       |
| 3     | `GeomAbs_Sphere`              | Spherical surface     |
| 4     | `GeomAbs_Torus`               | Toroidal surface      |
| 5     | `GeomAbs_BezierSurface`       | Bezier surface        |
| 6     | `GeomAbs_BSplineSurface`      | B-Spline surface      |
| 7     | `GeomAbs_SurfaceOfRevolution` | Surface of revolution |
| 8     | `GeomAbs_SurfaceOfExtrusion`  | Surface of extrusion  |
| 9     | `GeomAbs_OffsetSurface`       | Offset surface        |
| 10    | `GeomAbs_OtherSurface`        | Other                 |

## Appendix: Curve Type Enum Reference

Values returned by `TauTopologyInspector::classifyEdge()` (from `GeomAbs_CurveType`):

| Value | Type                   | Description    |
| ----- | ---------------------- | -------------- |
| 0     | `GeomAbs_Line`         | Straight line  |
| 1     | `GeomAbs_Circle`       | Circular arc   |
| 2     | `GeomAbs_Ellipse`      | Elliptical arc |
| 3     | `GeomAbs_Hyperbola`    | Hyperbola      |
| 4     | `GeomAbs_Parabola`     | Parabola       |
| 5     | `GeomAbs_BezierCurve`  | Bezier curve   |
| 6     | `GeomAbs_BSplineCurve` | B-Spline curve |
| 7     | `GeomAbs_OffsetCurve`  | Offset curve   |
| 8     | `GeomAbs_OtherCurve`   | Other          |
