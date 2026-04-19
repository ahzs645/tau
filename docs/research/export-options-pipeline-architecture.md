---
title: 'Export Options Pipeline Architecture: Assimp Properties to Typed Transcoder Options'
description: 'Analysis of how export options flow from consumer API through the runtime, converter, and assimpjs layers, with gaps and recommendations for type-safe per-format transcoder options.'
status: active
created: '2026-04-16'
updated: '2026-04-16'
category: architecture
related:
  - docs/research/3mf-activation-status.md
  - docs/research/3mf-assimp-audit.md
  - docs/research/export-option-schema-architecture.md
  - docs/research/schema-driven-export-configuration.md
---

# Export Options Pipeline Architecture: Assimp Properties to Typed Transcoder Options

Analysis of the export options pipeline from the consumer-facing `RuntimeClient.export()` API through the kernel worker, transcoder, converter, and assimpjs layers. Assesses whether per-format transcoder options (e.g. slicer metadata for 3MF, point cloud mode for STL) can reach assimp's `ExportProperties` today, and what is required to enable this capability.

## Executive Summary

The runtime already has a well-designed options pipeline: consumers pass typed per-format options via `RuntimeClient.export(format, options)`, the kernel worker validates them against Zod schemas, and the `TranscodeInput.options` bag reaches the transcoder's `transcode()` method. The converter transcoder, however, drops `input.options` entirely — it calls `exportFromGlb(glb, format)` with no options parameter. Below that, `@taucad/converter`'s `exportFiles()` accepts no options, and assimpjs's `ConvertFileList(fileList, format)` has no options parameter in its Embind API. The assimp C++ `ExportProperties` system (string-keyed property bags for ints, floats, strings, matrices, callbacks) is fully capable but not wired through assimpjs to JavaScript. Activating per-format export options requires changes at four layers: (1) assimpjs C++ binding + Embind, (2) converter `exportFiles` API, (3) converter transcoder forwarding, and (4) per-format Zod schemas on `TranscoderEdge`. The runtime and kernel worker layers are already ready.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Layer-by-Layer Analysis](#2-layer-by-layer-analysis)
3. [Assimp ExportProperties Capability Audit](#3-assimp-exportproperties-capability-audit)
4. [Data Flow Gap Analysis](#4-data-flow-gap-analysis)
5. [Architecture Recommendation](#5-architecture-recommendation)
6. [Recommendations](#6-recommendations)

---

## 1. Problem Statement

The use case is enabling Tau runtime consumers to control how assimp exports each format. Examples:

- **3MF**: slicer version metadata, unit specification, thumbnail embedding
- **STL**: point cloud export mode (`AI_CONFIG_EXPORT_POINT_CLOUDS`)
- **FBX**: transparency factor opacity reference (`AI_CONFIG_EXPORT_FBX_TRANSPARENCY_FACTOR_REFER_TO_OPACITY`)
- **USDZ**: animation export, clearcoat materials, mobile optimization
- **glTF**: PBR specular-glossiness mode, sparse accessors, target names

These options must be:

1. **Type-safe** with per-format discriminated schemas (only show 3MF options when exporting 3MF)
2. **Optional** — missing options default to current behavior
3. **Validated** before reaching the WASM boundary
4. **Discoverable** via the capabilities manifest (for UI rendering)

---

## 2. Layer-by-Layer Analysis

### 2.1 Consumer API (RuntimeClient)

The `export()` method on `RuntimeClient` accepts typed per-format options when the client is created with typed kernel plugins:

```typescript
// Typed from kernel's exportSchemas
client.export('3mf', { slicerMetadata: true });
client.export('stl', { pointClouds: true });
```

The options are sent as `Record<string, unknown>` over the `RuntimeCommand` protocol to the worker:

```typescript
type RuntimeCommand = {
  type: 'export';
  requestId: string;
  format: FileExtension;
  options?: Record<string, unknown>;
};
```

**Status: Ready.** No changes needed.

### 2.2 Kernel Worker (Validation + Routing)

The kernel worker validates options against the active kernel's Zod schema for the target format, then routes to either native kernel export or transcoded export:

1. Looks up `kernelExportZodSchemasMap[activeKernelId][format]`
2. Runs `formatZodSchema.safeParse(options ?? {})`
3. For transcoded routes: re-validates source format options, then calls `transcoder.definition.transcode({ ..., options: input.options })`

**Critical detail:** The worker passes `input.options` (the original target-format validated options) to the transcoder, not a separate transcoder-specific options bag. The `TranscoderEdge.optionsSchema`, if present, is merged into the manifest's JSON Schema at route-building time for UI/documentation, but is not separately validated at transcode time.

**Status: Ready.** The worker already forwards `options` to transcoders. Schema merging for manifests is implemented.

### 2.3 Converter Transcoder (packages/runtime)

The converter transcoder receives `TranscodeInput` with `options` but **ignores it completely**:

```typescript
async transcode(input, runtime) {
  const glbBytes = input.files[0]!.bytes;
  const files = await exportFromGlb(glbBytes, input.to as SupportedExportFormat);
  //                                          ^^^ format only, no options
  return { success: true, data: files, issues: [] };
},
```

The `discoverEdges()` method returns edges with **no `optionsSchema`**:

```typescript
async discoverEdges() {
  return supportedExportFormats
    .filter((format) => format !== 'glb')
    .map((format) => ({
      from: 'glb',
      to: format,
      fidelity: 'mesh',
      // no optionsSchema
    }));
},
```

**Status: Gap.** Must forward `input.options` to `exportFromGlb` and declare per-format `optionsSchema` on edges.

### 2.4 Converter Package (@taucad/converter)

The public API accepts format only, no options:

```typescript
export const exportFiles = async (
  glbData: Uint8Array<ArrayBuffer>,
  format: SupportedExportFormat,
): Promise<ExportFile[]> => { ... };

export const exportFromGlb = async (
  glbData: Uint8Array<ArrayBuffer>,
  format: SupportedExportFormat,
): Promise<ExportFile[]> => { ... };
```

The `AssimpExporter.parseAsync()` signature does accept `Partial<AssimpExporterOptions>` but `AssimpExporterOptions` only has `format` and `targetExtension` — no export property bag:

```typescript
type AssimpExporterOptions = {
  format: AssimpExportFormat;
  targetExtension?: string;
};
```

**Status: Gap.** Must extend `exportFiles`/`exportFromGlb` to accept options and thread them to the exporter.

### 2.5 AssimpJS Binding Layer (WASM)

The `ConvertFileList` Embind binding accepts only `(FileList, string)`:

```cpp
emscripten::function<Result, const FileList&, const std::string&>(
  "ConvertFileList", &ConvertFileList
);
```

Internally, `ExportScene()` creates a fixed `ExportProperties` with only `JSON_SKIP_WHITESPACES = true`, then calls:

```cpp
exporter.Export(scene, assimpFormat.c_str(), fileName.c_str(), 0u, &exportProperties);
```

No mechanism exists to pass additional properties from JavaScript.

**Status: Gap.** Must extend `ConvertFileList` with an optional 3rd parameter via Embind arity-based overloading.

### 2.6 Assimp C++ ExportProperties

The assimp `ExportProperties` class (defined in `Exporter.hpp`) is a string-keyed property bag supporting five value types:

| Type                          | Setter                                   | Getter                                   |
| ----------------------------- | ---------------------------------------- | ---------------------------------------- |
| `int` (+ `bool`)              | `SetPropertyInteger` / `SetPropertyBool` | `GetPropertyInteger` / `GetPropertyBool` |
| `ai_real` (float/double)      | `SetPropertyFloat`                       | `GetPropertyFloat`                       |
| `std::string`                 | `SetPropertyString`                      | `GetPropertyString`                      |
| `aiMatrix4x4`                 | `SetPropertyMatrix`                      | `GetPropertyMatrix`                      |
| `std::function<void*(void*)>` | `SetPropertyCallback`                    | `GetPropertyCallback`                    |

Keys are hashed via `SuperFastHash` for map lookup. The class has `HasProperty*` methods for each type.

`Exporter::Export()` passes properties to each format's export function:

```cpp
aiReturn Export(const aiScene*, const char* pFormatId, const char* pPath,
  unsigned int pPreprocessing = 0u, const ExportProperties* pProperties = nullptr);
```

**Status: Fully capable.** The C++ API is generic and extensible.

---

## 3. Assimp ExportProperties Capability Audit

### 3.1 Documented Export Property Keys

From `include/assimp/config.h.in`:

| Key Macro                                                   | String Value                                        | Type   | Format            |
| ----------------------------------------------------------- | --------------------------------------------------- | ------ | ----------------- |
| `AI_CONFIG_EXPORT_XFILE_64BIT`                              | `"EXPORT_XFILE_64BIT"`                              | bool   | X                 |
| `AI_CONFIG_EXPORT_POINT_CLOUDS`                             | `"EXPORT_POINT_CLOUDS"`                             | bool   | STL               |
| `AI_CONFIG_USE_GLTF_PBR_SPECULAR_GLOSSINESS`                | `"USE_GLTF_PBR_SPECULAR_GLOSSINESS"`                | bool   | glTF2             |
| `AI_CONFIG_EXPORT_GLTF_UNLIMITED_SKINNING_BONES_PER_VERTEX` | `"USE_UNLIMITED_BONES_PER VERTEX"`                  | bool   | glTF2             |
| `AI_CONFIG_EXPORT_FBX_TRANSPARENCY_FACTOR_REFER_TO_OPACITY` | `"EXPORT_FBX_TRANSPARENCY_FACTOR_REFER_TO_OPACITY"` | bool   | FBX               |
| `AI_CONFIG_EXPORT_BLOB_NAME`                                | `"EXPORT_BLOB_NAME"`                                | string | All (blob naming) |

### 3.2 Undocumented / Ad-Hoc Property Keys

From source code analysis:

| Key String                    | Type     | Format                 | Location              |
| ----------------------------- | -------- | ---------------------- | --------------------- |
| `"JSON_SKIP_WHITESPACES"`     | bool     | ASSJSON                | `AssJsonExporter.cpp` |
| `"bJoinIdenticalVertices"`    | bool     | All (injected by core) | `Exporter.cpp`        |
| `"GLTF2_SPARSE_ACCESSOR_EXP"` | bool     | glTF2                  | `glTF2Exporter.cpp`   |
| `"GLTF2_TARGET_NORMAL_EXP"`   | bool     | glTF2                  | `glTF2Exporter.cpp`   |
| `"GLTF2_TARGETNAMES_EXP"`     | bool     | glTF2                  | `glTF2Exporter.cpp`   |
| `"extras"`                    | callback | glTF2                  | `glTF2Exporter.cpp`   |
| `"USDZ_EXPORT_ANIMATIONS"`    | bool     | USDZ                   | `USDZExporter.cpp`    |
| `"USDZ_EXPORT_CLEARCOAT"`     | bool     | USDZ                   | `USDZExporter.cpp`    |
| `"USDZ_EXPORT_MATERIALX"`     | bool     | USDZ                   | `USDZExporter.cpp`    |
| `"USDZ_EXPORT_SUBDIVISION"`   | bool     | USDZ                   | `USDZExporter.cpp`    |
| `"USDZ_EXPORT_VOLUMES"`       | bool     | USDZ                   | `USDZExporter.cpp`    |
| `"USDZ_OPTIMIZE_FOR_MOBILE"`  | bool     | USDZ                   | `USDZExporter.cpp`    |

### 3.3 Formats with No ExportProperties Usage

| Format        | Status                                                          |
| ------------- | --------------------------------------------------------------- |
| 3MF           | `pProperties` parameter is `/*pProperties*/` (commented unused) |
| STEP          | Stores pointer but has zero `GetProperty*` calls                |
| OBJ           | Only injected `bJoinIdenticalVertices`                          |
| PLY           | No property reads                                               |
| DAE (Collada) | No property reads                                               |
| 3DS           | No property reads                                               |
| X3D           | No property reads                                               |

### 3.4 Scene Metadata as Alternative Channel

Some exporters read `aiScene::mMetaData` for configuration:

- **3MF (legacy zip path)**: Writes all scene metadata as `<metadata>` elements
- **FBX**: Reads `UpAxis`, `UnitScaleFactor`, etc. from scene metadata for GlobalSettings
- **glTF2**: Reads `AI_METADATA_SOURCE_COPYRIGHT`, node extras

This is an alternative mechanism for passing data that becomes part of the output file, but it is not suited for controlling export behavior (like point cloud mode). It conflates data with configuration.

---

## 4. Data Flow Gap Analysis

```
Consumer API        Kernel Worker       Transcoder          Converter           AssimpJS         Assimp C++
─────────────       ─────────────       ──────────          ─────────           ─────────        ──────────
export(fmt, opts)
      │
      ├──► options: Record ─► Zod validate ─► TranscodeInput.options
      │    ✅ typed           ✅ validated     │
      │                                       │
      │                                       ├──► transcode(input)
      │                                       │    ❌ input.options DROPPED
      │                                       │
      │                                       │    exportFromGlb(glb, fmt)
      │                                       │    ❌ no options param
      │                                       │
      │                                       │    exportFiles(glb, fmt)
      │                                       │    ❌ no options param
      │                                       │
      │                                       │    AssimpExporter.parseAsync(glb)
      │                                       │    ❌ no export properties
      │                                       │
      │                                       │    ConvertFileList(list, fmt)
      │                                       │    ❌ no options in Embind
      │                                       │
      │                                       │    Export(scene, fmt, path, 0, &props)
      │                                       │    ✅ ExportProperties available
      │                                       │       but only JSON_SKIP_WHITESPACES set
```

Four gaps must be bridged:

| #   | Layer                   | Gap                                            | Required Change                                    |
| --- | ----------------------- | ---------------------------------------------- | -------------------------------------------------- |
| G1  | Converter transcoder    | `input.options` dropped                        | Forward to `exportFromGlb`                         |
| G2  | `@taucad/converter` API | `exportFiles`/`exportFromGlb` no options param | Add `options?` parameter                           |
| G3  | AssimpJS Embind         | `ConvertFileList` no options                   | Add 3-arg arity overload via Embind overload table |
| G4  | AssimpJS C++            | `ExportScene` hardcodes properties             | Map JS options to `ExportProperties`               |

---

## 5. Architecture Recommendation

### 5.1 Design Principles

1. **Per-format discriminated schemas** — each format defines its own Zod schema; the runtime validates the correct schema based on the target format
2. **Optional everything** — all options use Zod `.default()` so missing options fall through to current behavior
3. **Schema-at-the-edge** — Zod schemas live on `TranscoderEdge.optionsSchema` (per format), surfaced to consumers via the capabilities manifest
4. **Minimal C++ surface** — keep the assimpjs API simple; map a flat JS object to assimp `ExportProperties` keys in C++

### 5.2 Proposed Data Flow

```
Consumer                Worker              Transcoder           Converter            AssimpJS
────────                ──────              ──────────           ─────────            ─────────
export('3mf', {         validate against    transcode({          exportFiles(glb,     ConvertFileList(
  slicerMetadata: true  edge.optionsSchema    options: {           '3mf',               list, '3mf', {
})                      for '3mf'             slicerMetadata:      { slicerMetadata:      "3MF_SLICER_META":
                                              true                 true               true })
                                            }                    })                   → 3-arg overload
                                          })                                          → ExportProperties
                                                                                        .SetPropertyBool(...)
```

### 5.3 Layer-by-Layer Changes

**Layer 1: AssimpJS C++ — Arity-based `ConvertFileList` overload**

Embind supports registering multiple C++ functions under the same JS name when they differ by argument count. The runtime builds an overload table keyed on `args.length`, dispatching `ConvertFileList(list, fmt)` to the 2-arg version and `ConvertFileList(list, fmt, opts)` to the 3-arg version. This is non-breaking — existing 2-arg callers are unaffected.

Add a 3-arg Emscripten wrapper alongside the existing function:

```cpp
static bool ExportSceneWithOptions(const aiScene* scene, const std::string& format,
                                   const emscripten::val& options, Result& result)
{
  if (scene == nullptr) { result.errorCode = ErrorCode::ImportError; return false; }

  Assimp::Exporter exporter;
  exporter.SetIOHandler(new FileListIOSystemWriteAdapter(result.fileList));

  Assimp::ExportProperties exportProperties;
  exportProperties.SetPropertyBool("JSON_SKIP_WHITESPACES", true);

  if (!options.isUndefined() && !options.isNull()) {
    auto keys = emscripten::val::global("Object").call<emscripten::val>("keys", options);
    auto length = keys["length"].as<unsigned>();
    for (unsigned i = 0; i < length; i++) {
      auto key = keys[i].as<std::string>();
      auto value = options[key];
      if (value.isTrue() || value.isFalse()) {
        exportProperties.SetPropertyBool(key.c_str(), value.as<bool>());
      } else if (value.isNumber()) {
        exportProperties.SetPropertyFloat(key.c_str(), value.as<float>());
      } else if (value.isString()) {
        exportProperties.SetPropertyString(key.c_str(), value.as<std::string>());
      }
    }
  }

  std::string assimpFormat = format;
  if (format == "dae") { assimpFormat = "collada"; }
  std::string fileName = GetFileNameFromFormat(format);

  aiReturn exportResult = exporter.Export(scene, assimpFormat.c_str(), fileName.c_str(), 0u, &exportProperties);
  if (exportResult != aiReturn_SUCCESS) { result.errorCode = ErrorCode::ExportError; return false; }
  result.errorCode = ErrorCode::NoError;
  return true;
}

Result ConvertFileListWithOptionsEmscripten(const FileList& fileList, const std::string& format,
                                            const emscripten::val& options)
{
  if (fileList.FileCount() == 0) { return Result(ErrorCode::NoFilesFound); }
  Assimp::Importer importer;
  importer.SetIOHandler(new FileListIOSystemReadAdapter(fileList));
  const aiScene* scene = nullptr;
  for (size_t i = 0; i < fileList.FileCount(); i++) {
    scene = ImportFileListByMainFile(importer, fileList.GetFile(i));
    if (scene) break;
  }
  Result result;
  ExportSceneWithOptions(scene, format, options, result);
  return result;
}
```

Register both arities under the same name in Embind:

```cpp
EMSCRIPTEN_BINDINGS(assimpjs) {
  // ... File, FileList, Result bindings unchanged ...

  // 2-arg: existing behavior (backward compatible)
  emscripten::function<Result, const FileList&, const std::string&>(
    "ConvertFileList", &ConvertFileList);
  // 3-arg: with export options
  emscripten::function<Result, const FileList&, const std::string&, const emscripten::val&>(
    "ConvertFileList", &ConvertFileListWithOptionsEmscripten);
}
```

Embind dispatches by `args.length`:

- `ConvertFileList(list, "3mf")` → 2-arg (current behavior)
- `ConvertFileList(list, "3mf", { EXPORT_POINT_CLOUDS: true })` → 3-arg (options mapped to `ExportProperties`)

**Alternatives considered and rejected:**

| Approach                                                    | Why rejected                                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| C++ default argument (`const val& opts = val::undefined()`) | Embind registers full arity; calling with 2 args triggers `throwBindingError` when `ASSERTIONS=1` (enabled in assimpjs) |
| `std::optional<T>` + `register_optional`                    | Requires defining + registering a new C++ struct; heavier than `emscripten::val` which accepts any JS value directly    |
| Require `undefined` as explicit 3rd arg                     | Forces all existing callers to change; breaks backward compatibility                                                    |
| Separate function name (`ConvertFileListWithOptions`)       | Unnecessary API surface growth; arity overloading is cleaner                                                            |

**Layer 2: AssimpJS TypeScript types — Overloaded signature**

```typescript
export type AssimpJS = {
  FileList: new () => FileList;
  ConvertFileList(fileList: FileList, format: string): AssimpResult;
  ConvertFileList(fileList: FileList, format: string, options: Record<string, boolean | number | string>): AssimpResult;
  // ...
};
```

**Layer 3: Converter — Add options to export API**

Extend `AssimpExporterOptions`:

```typescript
type AssimpExporterOptions = {
  format: AssimpExportFormat;
  targetExtension?: string;
  exportProperties?: Record<string, boolean | number | string>;
};
```

In `parseAsync()`, pass the 3rd argument to `ConvertFileList` only when `exportProperties` is present. When absent, the 2-arg overload is called (identical to current behavior).

Extend `exportFiles` and `exportFromGlb`:

```typescript
export const exportFiles = async (
  glbData: Uint8Array<ArrayBuffer>,
  format: SupportedExportFormat,
  options?: Record<string, unknown>,
): Promise<ExportFile[]> => { ... };
```

**Layer 4: Converter transcoder — Forward options and declare schemas**

```typescript
async discoverEdges() {
  return supportedExportFormats
    .filter((f) => f !== 'glb')
    .map((format) => ({
      from: 'glb',
      to: format,
      fidelity: 'mesh',
      optionsSchema: transcoderOptionSchemas[format], // per-format Zod
    }));
},

async transcode(input, runtime) {
  const files = await exportFromGlb(
    input.files[0]!.bytes,
    input.to as SupportedExportFormat,
    input.options,  // forward options
  );
  return { success: true, data: files, issues: [] };
},
```

**Layer 5: Per-format Zod schemas**

Define per-format option schemas in the converter (or transcoder). All properties are optional with defaults:

```typescript
const threeMfOptionsSchema = z
  .object({
    slicerMetadata: z.boolean().default(false),
    unitScale: z.enum(['millimeter', 'centimeter', 'meter', 'inch']).default('millimeter'),
  })
  .default({});

const stlOptionsSchema = z
  .object({
    pointClouds: z.boolean().default(false),
  })
  .default({});

const usdzOptionsSchema = z
  .object({
    exportAnimations: z.boolean().default(true),
    exportClearcoat: z.boolean().default(true),
    optimizeForMobile: z.boolean().default(false),
  })
  .default({});
```

### 5.4 Scene Metadata Path (Alternative for 3MF)

For 3MF-specific metadata that should appear in the output file (slicer version strings, application name), an alternative to `ExportProperties` is writing to `aiScene::mMetaData` before export. The legacy 3MF exporter already reads scene metadata. The Lib3MFBridge could be enhanced to do the same.

This path is appropriate for **data that becomes part of the 3MF file** (like `BambuStudio:3mfVersion`), while `ExportProperties` is appropriate for **behavioral flags** (like "enable thumbnails" or "include Production Extension UUIDs").

Both paths would need the same assimpjs → converter → transcoder options pipeline since the metadata must originate from the consumer.

---

## 6. Recommendations

| #   | Action                                                                            | Priority | Effort | Impact | Layer              |
| --- | --------------------------------------------------------------------------------- | -------- | ------ | ------ | ------------------ |
| R1  | Add 3-arg `ConvertFileList` arity overload to assimpjs Embind binding             | P1       | Medium | High   | assimpjs C++       |
| R2  | Add overloaded `ConvertFileList` signature to `AssimpJS` TypeScript types         | P1       | Low    | High   | assimpjs types     |
| R3  | Add `exportProperties` to `AssimpExporterOptions`, update `parseAsync`            | P1       | Low    | High   | converter          |
| R4  | Add `options?` parameter to `exportFiles`/`exportFromGlb`                         | P1       | Low    | High   | converter API      |
| R5  | Forward `input.options` in converter transcoder's `transcode()`                   | P1       | Low    | High   | runtime transcoder |
| R6  | Define per-format Zod schemas, return on `TranscoderEdge.optionsSchema`           | P1       | Medium | High   | runtime transcoder |
| R7  | Add 3MF-specific properties to Lib3MFBridge (slicer metadata, unit, thumbnails)   | P2       | Medium | Medium | assimp C++         |
| R8  | Map Zod option keys to assimp `ExportProperties` key strings (convention doc)     | P2       | Low    | Medium | documentation      |
| R9  | Validate end-to-end: consumer passes options, 3MF output contains slicer metadata | P2       | Medium | High   | integration test   |
| R10 | Support `aiScene::mMetaData` injection for formats that read it (3MF, FBX, glTF)  | P3       | Medium | Medium | assimpjs C++       |
| R11 | Add post-processing flag support (`pPreprocessing` parameter) to assimpjs API     | P3       | Low    | Low    | assimpjs C++       |

### Implementation Order

**Phase 1 (activate the pipeline):** R1 → R2 → R3 → R4 → R5 → R6. This creates the end-to-end options flow. No format-specific options needed yet — the pipeline works but passes empty options.

**Phase 2 (activate per-format options):** R7 → R8 → R9. Add actual property reads in 3MF exporter, document the key naming convention, and test end-to-end.

**Phase 3 (advanced):** R10 → R11. Scene metadata injection and post-processing control.

---

## Appendix: Existing Architecture Reference

### ExportProperties API (Exporter.hpp)

```cpp
class ExportProperties {
public:
  bool SetPropertyInteger(const char* szName, int iValue);
  bool SetPropertyBool(const char* szName, bool value);
  bool SetPropertyFloat(const char* szName, ai_real fValue);
  bool SetPropertyString(const char* szName, const std::string& sValue);
  bool SetPropertyMatrix(const char* szName, const aiMatrix4x4& sValue);
  bool SetPropertyCallback(const char* szName, const std::function<void*(void*)>& f);

  int GetPropertyInteger(const char* szName, int iErrorReturn = 0xffffffff) const;
  bool GetPropertyBool(const char* szName, bool bErrorReturn = false) const;
  ai_real GetPropertyFloat(const char* szName, ai_real fErrorReturn = 10e10f) const;
  const std::string GetPropertyString(const char* szName, const std::string& sErrorReturn = "") const;
  const aiMatrix4x4 GetPropertyMatrix(const char* szName, const aiMatrix4x4& sErrorReturn = aiMatrix4x4()) const;
};
```

### Export Invocation Chain (Current — 2-arg)

```
ConvertFileList(FileList, "3mf")                    // Embind 2-arg overload
  → ImportFileListByMainFile(importer, file)         // aiProcess_Triangulate | GenUVCoords | JoinIdentical | SortByPType
  → ExportScene(scene, "3mf", result)
    → ExportProperties props; props.SetPropertyBool("JSON_SKIP_WHITESPACES", true)
    → exporter.Export(scene, "3mf", "result.3mf", 0u, &props)
      → ExportScene3MF(path, ioSystem, scene, /*pProperties*/)   // properties UNUSED
        → Lib3MFBridge::ExportScene(scene, path, ioSystem)        // no properties parameter
```

### Export Invocation Chain (Proposed — 3-arg)

```
ConvertFileList(FileList, "3mf", { key: value })    // Embind 3-arg overload
  → ImportFileListByMainFile(importer, file)         // same import pipeline
  → ExportSceneWithOptions(scene, "3mf", options, result)
    → ExportProperties props; props.SetPropertyBool("JSON_SKIP_WHITESPACES", true)
    → for each key in options: props.SetProperty*(key, value)   // JS → ExportProperties mapping
    → exporter.Export(scene, "3mf", "result.3mf", 0u, &props)
      → ExportScene3MF(path, ioSystem, scene, pProperties)      // properties NOW AVAILABLE
```

### Transcoder Edge Schema Merging (kernel-worker.ts)

The kernel worker builds the capabilities manifest by merging kernel `exportSchemas` with transcoder `TranscoderEdge.optionsSchema`:

1. Each kernel format export gets `{ schema, defaults }` from its Zod-to-JSON-Schema conversion
2. Each transcoder edge gets `{ schema, defaults }` from its `optionsSchema` (if any)
3. For transcoded routes (kernel format → transcoder → target format), schemas are merged via `mergeJsonSchemas()`: properties and required arrays are union-merged
4. The merged schema appears on the `ExportRoute` in the capabilities manifest

This means a consumer sees a single unified schema for "export to 3MF" that includes both kernel-level options (e.g. tessellation) and transcoder-level options (e.g. slicer metadata). The worker validates options against the kernel schema for the target format, but transcoder edge options are not separately validated at runtime — they flow through as part of `input.options`.
