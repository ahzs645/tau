---
title: 'OpenCascade Kernel STEP Export Empty Geometry'
description: 'Root cause of opencascade kernel STEP exports containing only XCAF metadata — recurrence of the empty-string multi-file-mode trap previously fixed in replicad'
status: active
created: '2026-05-03'
updated: '2026-05-03'
category: investigation
related:
  - docs/research/step-export-multifile-regression.md
  - docs/policy/testing-policy.md
---

# OpenCascade Kernel STEP Export Empty Geometry

Investigation into why the `opencascade` kernel's STEP export pipeline produces files containing only XCAF/PDM scaffolding and zero `MANIFOLD_SOLID_BREP` / `ADVANCED_FACE` geometry.

## Executive Summary

`opencascade.kernel.ts` calls `STEPCAFControl_Writer.Transfer(doc, AsIs, '', progress)` followed by a separate `writer.Write(filePath)`. The empty-string third argument is forwarded to OCCT as a non-`nullptr` `const char* const`, which **OCCT interprets as multi-file export mode**. In that mode, geometry is written to discarded external `.stp` files and the main file receives only the assembly skeleton — exactly the pattern observed in the supplied repro `~/Downloads/test.step`. This is the **same bug** previously diagnosed and fixed in the replicad assembly exporter (see `docs/research/step-export-multifile-regression.md`) — independently reintroduced into the new opencascade kernel STEP path during the PBR-material work in commit `edb3ebf1c` (April 2026). The fix is to call `writer.Perform(doc, fileName, progress)`, which OCCT internally dispatches with a true `nullptr`. The reason this regression escaped CI is that the existing test only asserts `bytes instanceof Uint8Array` and a positive byte length; the empty STEP output is ~2.5 KB of valid PDM scaffolding so byte-length checks pass.

## Problem Statement

Reproducer: a simple `BRepPrimAPI_MakeBox(10,20,30).Shape()` returned from a kernel `main()` is exported via `worker.exportGeometry('step')`. The resulting `test.step` file contains:

| Section                                                          | Status                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `HEADER` / `FILE_SCHEMA`                                         | Present (`AP242_MANAGED_MODEL_BASED_3D_…`)                               |
| `APPLICATION_PROTOCOL_…`                                         | Present                                                                  |
| `PRODUCT` / `PRODUCT_DEFINITION_*`                               | Present (PDM document plumbing)                                          |
| `SHAPE_REPRESENTATION`                                           | Present, but only the world-origin `AXIS2_PLACEMENT_3D` — no shape items |
| `ADVANCED_BREP_SHAPE_REPRESENTATION`                             | **Missing**                                                              |
| `MANIFOLD_SOLID_BREP`                                            | **Missing**                                                              |
| `CLOSED_SHELL` / `ADVANCED_FACE` / `EDGE_CURVE` / `VERTEX_POINT` | **Missing**                                                              |

Total: 45 entities of XCAF/document boilerplate, zero geometry entities. Cross-checked with:

- `~/Downloads/test.stl` (same kernel, same file) — full triangulated geometry. Confirms `createGeometry` produced a valid `TopoDS_Shape`; the export pipeline is the only suspect.
- `~/Downloads/Hollow Box (Remixed) (1).step` (replicad kernel) — opens with `#10 = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#11,#15),#1315);` → `#15 = MANIFOLD_SOLID_BREP('',#16);` → full B-rep tree. Confirms replicad's STEP path works.

## Methodology

1. Diff the failing `test.step` byte-stream against the working replicad `Hollow Box.step` to confirm the missing entity classes.
2. Walk the `case 'step':` branch of `packages/runtime/src/kernels/opencascade/opencascade.kernel.ts` line-by-line.
3. Compare against the working `repos/replicad/packages/replicad/src/export/assemblyExporter.ts` (verified-good reference).
4. Cross-reference `repos/OCCT/src/DataExchange/TKDESTEP/STEPCAFControl/STEPCAFControl_Writer.cxx` to confirm `theIsMulti` semantics.
5. Inspect `packages/runtime/src/kernels/opencascade/wasm/opencascade_full.d.ts` for the embind-generated signature.
6. Check `git log` on `opencascade.kernel.ts` to confirm when the bug was introduced.
7. Re-read the prior `docs/research/step-export-multifile-regression.md` to validate this is the same root cause class.

## Findings

### Finding 1: The Empty-String Argument Activates Multi-File Mode

The `case 'step':` branch in `opencascade.kernel.ts` (lines 449–453):

```450:453:packages/runtime/src/kernels/opencascade/opencascade.kernel.ts
        const progress = new oc.Message_ProgressRange();
        writer.Transfer(document, oc.STEPControl_StepModelType.STEPControl_AsIs, '', progress);

        const filePath = `/tmp/export_${Date.now()}.step`;
        writer.Write(filePath);
```

OCCT's `STEPCAFControl_Writer::Transfer` (`repos/OCCT/src/DataExchange/TKDESTEP/STEPCAFControl/STEPCAFControl_Writer.cxx:387`) takes `theIsMulti` as `const char* const` and dispatches the per-label loop based on **pointer truthiness, not string content** (line 633):

```cpp
if (!theIsMulti)
{
  // single-file: write geometry into the main model
  theWriter.Transfer(aCurShape, theMode, aModel->InternalParameters, false, aRange);
}
else
{
  // multi-file: emit external STEP files; main file gets only the skeleton
  TopoDS_Shape aSass = transferExternFiles(aCurL, theMode, aSubLabels, …);
  theWriter.Transfer(aSass, STEPControl_AsIs, …, true, …);
}
```

Lines 738, 742, 746, 749 (`writeColors`, `writeLayers`, `writeNames`, `writeSHUOs`) are **also gated by `!theIsMulti`** — colors, names and materials are silently skipped for the main model in multi-file mode, even if `SetColorMode(true)` / `SetNameMode(true)` were called.

The opencascade.js binding (auto-generated `.d.ts` line 166077) declares `theIsMulti: string` — the JS string `''` is marshaled to a `std::string` and forwarded to C++ via `strdup(theIsMulti.c_str())`, which always returns a non-null pointer. **There is no way to express `nullptr` through this binding path**, which is why `Perform()` (which always passes `nullptr`) is the only correct entry point from JS.

The TS comment in the binding even spells out the trap explicitly:

> If multi is not null pointer, it switches to multifile mode (with external refs), and string pointed by `<multi>` gives prefix for names of extern files **(can be empty string)**.

"Can be empty string" here means the **prefix** can be empty, not that empty-string disables multi-file mode.

### Finding 2: Replicad's STEP Path Avoids the Trap via `Perform()`

`repos/replicad/packages/replicad/src/export/assemblyExporter.ts:127`:

```typescript
const success = writer.Perform(doc.wrapped, filename, progress);
```

OCCT's `STEPCAFControl_Writer::Perform` (`STEPCAFControl_Writer.cxx:494`) is a thin wrapper that passes `nullptr` correctly:

```cpp
bool STEPCAFControl_Writer::Perform(const occ::handle<TDocStd_Document>& theDoc,
                                    const char* const                    theFileName,
                                    const Message_ProgressRange&         theProgress)
{
  if (!Transfer(theDoc, STEPControl_AsIs, nullptr, theProgress))
    return false;
  return Write(theFileName) == IFSelect_RetDone;
}
```

`Perform` is exposed in the opencascade kernel's bindings (`opencascade_full.d.ts:166112-166120`) and accepts a plain JS string for the filename. Switching to it eliminates the ambiguity entirely — no other call-site change is required.

### Finding 3: This Is a Direct Recurrence of a Previously Fixed Bug

`docs/research/step-export-multifile-regression.md` (created 2026-04-10, status `active`) documents the exact same bug pattern in `repos/replicad/packages/replicad/src/export/assemblyExporter.ts`. That investigation found:

- `null → ""` parameter migration during the OCCT V8 suffix-free overload migration
- Same multi-file-mode activation symptom
- Fix: switch from `Transfer + Write` to `Perform`
- Tests: assert `CLOSED_SHELL` and `ADVANCED_BREP_SHAPE_REPRESENTATION` substrings

The opencascade kernel's `case 'step':` branch was added later, in `edb3ebf1c` (2026-04-16, "feat(runtime): opencascade kernel - add PBR material support for STEP export with metalness and roughness"), six days **after** the replicad regression doc was published. The PR introduced a fresh implementation of the same `Transfer('') + Write` pattern instead of the `Perform` pattern that had just been ratified — the prior research and fix were not propagated to the new kernel surface. This is a process gap, not a bindings change.

The previous-version commit (visible in `git show edb3ebf1c`) used the simpler single-shape `STEPControl_Writer.Transfer(entry.shape, …)` API per shape, which has different semantics (no `theIsMulti` parameter) and worked correctly. The XCAF/PBR rewrite swapped that for the higher-level XCAF assembly path without applying the multi-file-mode workaround.

### Finding 4: The Existing Test Cannot Detect This

`packages/runtime/src/kernels/opencascade/opencascade.kernel.test.ts:253-263`:

```typescript
it('should export to STEP format', async () => {
  const geometryFile = createGeometryFile('box.ts');
  const createResult = await worker.createGeometry({ file: geometryFile, parameters: {} });
  assertSuccess(createResult, 'createGeometry for STEP export');

  const exportResult = await worker.exportGeometry('step');
  assertSuccess(exportResult, 'STEP export');
  expect(exportResult.data.length).toBeGreaterThan(0);
  expect(exportResult.data[0]?.bytes).toBeInstanceOf(Uint8Array);
  expect(exportResult.data[0]?.mimeType).toBe('application/step');
});
```

All three byte-level assertions pass on the failing output:

| Assertion                         | Pass on empty STEP? | Why                                                    |
| --------------------------------- | ------------------- | ------------------------------------------------------ |
| `data.length > 0`                 | ✅                  | Returns one `ExportFile`                               |
| `bytes instanceof Uint8Array`     | ✅                  | The 2.5 KB PDM scaffolding is a real `Uint8Array`      |
| `mimeType === 'application/step'` | ✅                  | Set unconditionally in `createExportFile('step', ...)` |

The replicad kernel test (`replicad.kernel.test.ts:2091`) already moved past this anti-pattern by asserting `stepContent.toContain('CLOSED_SHELL')` — but that assertion was never copied across to the opencascade kernel test.

## Recommendations

| #   | Action                                                                                                   | Priority | Effort | Impact |
| --- | -------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Replace `Transfer(...,'') + Write(...)` with `Perform(doc, filePath, progress)`                          | P0       | Low    | High   |
| R2  | Add geometry-content assertions to the opencascade kernel STEP export tests                              | P0       | Low    | High   |
| R3  | Add a STEP round-trip test (export → `STEPControl_Reader` import → assert non-empty `TopoDS_Shape`)      | P1       | Medium | High   |
| R4  | Add a workspace lint/grep guard against `STEPCAFControl_Writer.*Transfer\(.*, *''.*\)`                   | P2       | Low    | Medium |
| R5  | Generalise R4 into the `bindings.py` CString-sentinel handling described in R3 of the prior research doc | P3       | Medium | Medium |

### R1: Switch to `Perform`

The minimal correct fix replaces the two-call sequence with `Perform`, mirroring replicad's pattern. Sketch:

```typescript
const filePath = `/tmp/export_${Date.now()}.step`;
const progress = new oc.Message_ProgressRange();
const ok = writer.Perform(document, filePath, progress);
if (!ok) {
  progress.delete();
  // …writer/session/document cleanup…
  return createKernelError([{ message: 'STEP write failed', code: 'RUNTIME', type: 'runtime', severity: 'error' }]);
}
const rawData = oc.FS.readFile(filePath) as Uint8Array<ArrayBuffer>;
const data = new Uint8Array(rawData);
oc.FS.unlink(filePath);
progress.delete();
```

All writer configuration that precedes the call (`SetColorMode(true)`, `SetNameMode(true)`, `SetMaterialMode(true)`, `Interface_Static.SetIVal('write.surfacecurve.mode'/'write.step.assembly'/'write.step.schema', …)`) is preserved — those are stored on the writer/static-interface and remain in effect for `Perform`.

### R2: Geometry-Content Assertions

The opencascade STEP test must assert that the bytes contain real B-rep content, identical to the replicad pattern. Apply to **both** the single-shape (`'box.ts'`) and assembly (`'assembly.ts'`) cases:

```typescript
const stepContent = new TextDecoder().decode(exportResult.data[0]!.bytes);
expect(stepContent).toContain('CLOSED_SHELL');
expect(stepContent).toContain('ADVANCED_BREP_SHAPE_REPRESENTATION');
expect(stepContent).toContain('MANIFOLD_SOLID_BREP');
// Assembly case: shape names should appear
expect(stepContent).toContain('SmallBox');
expect(stepContent).toContain('LargeBox');
```

These are the exact entity types that distinguish a real B-rep export from the empty PDM scaffolding produced by multi-file mode. Three assertions provide redundant signal — any one of them flips on the regression.

### R3: Round-Trip Geometry Test

Stronger than substring assertions: round-trip the bytes back through OCCT and verify a non-null shape with non-zero volume. This guards against syntactic-but-degenerate output (e.g., empty `CLOSED_SHELL` records). Pattern:

```typescript
const reader = new oc.STEPControl_Reader();
oc.FS.writeFile('/tmp/roundtrip.step', stepBytes);
const status = reader.ReadFile('/tmp/roundtrip.step');
expect(status).toBe(oc.IFSelect_ReturnStatus.IFSelect_RetDone);
reader.TransferRoots(new oc.Message_ProgressRange());
const importedShape = reader.OneShape();
expect(importedShape.IsNull()).toBe(false);

const props = new oc.GProp_GProps();
oc.BRepGProp.VolumeProperties_1(importedShape, props, false, false);
expect(props.Mass()).toBeGreaterThan(5000); // 10×20×30 box → 6000 mm³
```

Mirrors `replicad.kernel.test.ts:2095` ("should round-trip STEP export/import preserving geometry"). The assembly path should also assert `>= 2` free shapes after `XCAFDoc_DocumentTool::ShapeTool(...)->GetFreeShapes(...)` to confirm assembly structure survived.

### R4: Workspace Guard

A custom oxlint or grep-based pre-commit check can flag the dangerous pattern at authoring time:

```regexp
STEPCAFControl_Writer[^\n]*\.Transfer\([^)]*,\s*['"][^'"]*['"]\s*,
```

Should match the broken call in `opencascade.kernel.ts:451` and **not** match `Perform(doc, filename, progress)` calls. Place under `libs/oxlint/src/rules/no-step-cafwriter-multifile.ts` with an autofix that suggests `Perform`. This prevents future authors from independently re-introducing the bug into a third kernel.

### R5: Bindings Generator Improvement (deferred)

The previous research doc deferred this work; it remains deferred here. `bindings.py` currently wraps `const char*` parameters in `std::string`, losing null-pointer semantics. A future change could detect `const char* const` parameters whose docstrings mention "null pointer" semantics and emit an `emscripten::val`-based wrapper that preserves `null` / `undefined` → `nullptr`. The opencascade kernel and replicad both consume the same OCJS WASM, so a single bindings-level fix would close the issue at the source. Until then, R1 + R4 are sufficient.

## Trade-offs

| Approach                          | Pros                                            | Cons                                                                                         |
| --------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Perform` (recommended)           | Matches replicad; no binding work; one-line fix | Slightly less control (no separate transfer/write phases)                                    |
| Pass `null` through `Transfer`    | Closer match to original C++ surface            | Embind binding doesn't accept null for `string` parameter — would need bindings change first |
| Hand-write `nullptr` adapter shim | Surgical                                        | Adds a per-kernel patch surface; bindings.py is the right layer                              |

`Perform` is unambiguously the correct fix at this layer.

## Code Examples

### Failing call site (current)

```450:467:packages/runtime/src/kernels/opencascade/opencascade.kernel.ts
        const progress = new oc.Message_ProgressRange();
        writer.Transfer(document, oc.STEPControl_StepModelType.STEPControl_AsIs, '', progress);

        const filePath = `/tmp/export_${Date.now()}.step`;
        writer.Write(filePath);
        const rawData = oc.FS.readFile(filePath) as Uint8Array<ArrayBuffer>;
        const data = new Uint8Array(rawData);
        oc.FS.unlink(filePath);

        progress.delete();
        writer.delete();
        session.delete();
        colorTool.delete();
        shapeTool.delete();
        mainLabel.delete();
        documentName.delete();
        document.delete();

        return createKernelSuccess([createExportFile('step', 'assembly', data)]);
```

### Working reference (replicad)

```122:137:repos/replicad/packages/replicad/src/export/assemblyExporter.ts
  oc.Interface_Static.SetIVal('write.step.assembly', 2);
  oc.Interface_Static.SetIVal('write.step.schema', 5);

  const filename = 'export.step';
  const progress = r(new oc.Message_ProgressRange());
  const success = writer.Perform(doc.wrapped, filename, progress);

  if (success) {
    const file = oc.FS.readFile('/' + filename);
    oc.FS.unlink('/' + filename);
    const blob = new Blob([file as BlobPart], { type: 'application/STEP' });
    return blob;
  } else {
    throw new Error('WRITE STEP FILE FAILED.');
  }
```

## Diagrams

```
opencascade.kernel.ts (broken)               Recommended fix
─────────────────────────────                ────────────────

   Transfer(doc, AsIs, '', progress)            Perform(doc, fileName, progress)
        │                                            │
        │ '' →  std::string("") →                    │ → Transfer(doc, AsIs, nullptr, progress)
        │       strdup("") → non-null *              │       (internal, OCCT-controlled)
        ▼                                            ▼
   if (!theIsMulti) is FALSE                    if (!theIsMulti) is TRUE
        │                                            │
        ▼                                            ▼
   transferExternFiles(...)                     theWriter.Transfer(shape, AsIs, ...)
        │   • writes part1.stp,                      │   • writes geometry into main model
        │     part2.stp into                         │   • writeColors / writeNames /
        │     /tmp (discarded by                     │     writeMaterials all execute
        │     readFile of main file)                 │
        ▼                                            ▼
   main.stp = PDM skeleton +                    main.stp = full B-rep:
              SHAPE_REPRESENTATION                       ADVANCED_BREP_SHAPE_REPRESENTATION
              (origin only)                              + MANIFOLD_SOLID_BREP
              45 entities, 0 geometry                    + CLOSED_SHELL + ADVANCED_FACE
                                                         + colors, names, materials
```

## References

- Prior identical investigation (replicad): `docs/research/step-export-multifile-regression.md`
- OCCT writer source: `repos/OCCT/src/DataExchange/TKDESTEP/STEPCAFControl/STEPCAFControl_Writer.cxx:387-501` (`Transfer` overloads), lines 598-790 (`transfer` worker), lines 494-524 (`Perform` overloads)
- Embind signature: `packages/runtime/src/kernels/opencascade/wasm/opencascade_full.d.ts:166055-166225` (`STEPCAFControl_Writer`)
- Failing call site: `packages/runtime/src/kernels/opencascade/opencascade.kernel.ts:368-468` (`case 'step':`)
- Working reference: `repos/replicad/packages/replicad/src/export/assemblyExporter.ts:97-137` (`exportSTEP`)
- Existing replicad test (template for R2/R3): `packages/runtime/src/kernels/replicad/replicad.kernel.test.ts:2066-2238`
- Bug-introducing commit: `edb3ebf1c` — "feat(runtime): opencascade kernel - add PBR material support for STEP export with metalness and roughness" (2026-04-16)
- Reproducers attached to this investigation: `~/Downloads/test.step` (failing), `~/Downloads/test.stl` (working same pipeline), `~/Downloads/Hollow Box (Remixed) (1).step` (working replicad export)
