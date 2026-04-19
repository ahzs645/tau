---
title: 'opencascade.js: Upstream v7.6.2 vs TauCAD V8 Fork — Binding Diff'
description: 'Comparison of filter classes, packages, methods, and bindings between upstream opencascade.js v7.6.2 and TauCAD OCCT V8 fork.'
status: active
created: '2026-03-07'
updated: '2026-03-07'
category: comparison
---

# opencascade.js: Upstream v7.6.2 vs TauCAD V8 Fork — Binding Diff

Comparison of the upstream opencascade.js (v7.6.2 era, `repos/opencascade.js-upstream`)
and the TauCAD fork (OCCT V8, `repos/opencascade.js`).

## 1. filterClasses.py — Class Filter Taxonomy

Full taxonomy is in [`v76-vs-v8-filter-taxonomy.json`](./v76-vs-v8-filter-taxonomy.json).

### Summary

| Metric                                | Count   |
| ------------------------------------- | ------- |
| Total distinct class exclusions       | 236     |
| Excluded in both upstream and fork    | 127     |
| V8-only exclusions (new in fork)      | **109** |
| V76-only exclusions (removed in fork) | 0       |

Every class excluded in upstream is also excluded in the fork — the fork is a strict superset.

### V8-Only Exclusion Categories

The 109 new exclusions fall into three categories:

#### A. Non-const lvalue enum ref params / nested types / std::function mismatches (94 classes)

OCCT V8 changed many method signatures to use non-const enum output parameters,
nested enum types, and `std::function` signatures that Embind cannot handle. These
classes had working bindings in v7.6.2 but break in V8.

Representative examples:

- **GccAna/Geom2dGcc families** (25 classes) — geometry constraint solvers now use `GccEnt_Position&` output params
- **TopOpeBRep\* families** (9 classes) — boolean operation internals with `TopAbs_State&` outputs
- **DE_Provider/DESTEP_Provider/DESTL_Provider** (5 classes) — new V8 data exchange plugin framework
- **BRepClass/BRepOffset/BRepFill** (7 classes) — core BRep operations
- **Visualization classes** (Graphic3d_Layer, Graphic3d_MaterialAspect, Select3D_SensitiveCircle, etc.)
- **Message/Message_Messenger/Message_ProgressScope** — messaging API changes
- **HLRBRep_Data, HLRBRep_TheCSFunctionOfInterCSurf** — hidden line removal
- **HelixGeom_BuilderApproxCurve** — new V8 helix package
- **XCAFDimTolObjects_DatumObject/DimensionObject** — GD&T objects
- **StepData_StepReaderData, StepToTopoDS_TranslateFace** — STEP reader
- **TopAbs, V3d, PrsDim, OSD_Protection** — utility classes

#### B. Deleted/non-default constructors or deep binding issues (13 classes)

OCCT V8 deleted copy/move constructors or changed constructor signatures:

- `BRepMesh_IncrementalMesh`, `BRepMesh_Delaun`, `BRepMesh_Triangle` — meshing (deleted copy ctors)
- `BSplCLib`, `BSplCLib_CacheParams` — B-spline cache (new internal types)
- `HLRAlgo_Coincidence`, `HLRAlgo_PolyInternalData` — HLR algorithm internals
- `Handle_math_NotSquare`, `Handle_math_SingularMatrix` — deprecated handle typedefs
- `LDOM_XmlReader` — XML parser
- `Poly_MakeLoops2D`, `Poly_MakeLoops3D` — polygon loop builder
- `TDF_DerivedAttribute` — OCAF framework

#### C. New V8 API classes with deleted constructors (2 prefix patterns)

- `GeomGridEval_*` / `Geom2dGridEval_*` — New EvalD\* API in V8 with deleted default constructors

---

## 2. filterPackages.py — Package Filter Diff

### Summary

| Metric                          | Count   |
| ------------------------------- | ------- |
| Upstream excluded packages      | 59      |
| Fork excluded packages          | **193** |
| Newly excluded in fork          | **134** |
| Upstream-only (removed in fork) | 0       |

The upstream only excludes Draw-related and a few Visualization packages (MeshVS, IVtk, Cocoa, D3DHost).
Notably, upstream **includes** most Visualization (AIS, Prs3d, V3d, Graphic3d, OpenGl, etc.) and all
data exchange formats.

### Newly excluded package groups in V8 fork

#### Full Visualization module (33 packages)

The fork excludes the entire Visualization module (rendering done in Three.js):

| Toolkit               | Packages                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------- |
| TKD3DHost             | D3DHost                                                                                       |
| TKIVtk                | IVtk, IVtkOCC, IVtkTools, IVtkVTK                                                             |
| TKMeshVS              | MeshVS                                                                                        |
| TKOpenGl / TKOpenGles | OpenGl                                                                                        |
| TKService             | Aspect, Cocoa, Font, Graphic3d, Image, Media, WNT, Wasm, Xw, Shaders                          |
| TKV3d                 | AIS, DsgPrs, Prs3d, PrsDim, PrsMgr, Select3D, SelectBasics, SelectMgr, StdPrs, StdSelect, V3d |
| TKVCAF                | TPrsStd                                                                                       |

#### Data exchange formats (50+ packages)

All non-STEP/STL data exchange formats are excluded:

- **IGES** (20 packages): TKDEIGES, IGESCAFControl, IGESData, IGESFile, IGESBasic, IGESGraph, IGESGeom, IGESDimen, IGESDraw, IGESSolid, IGESDefs, IGESAppli, IGESConvGeom, IGESSelect, IGESToBRep, GeomToIGES, Geom2dToIGES, BRepToIGES, BRepToIGESBRep, IGESControl, DEIGES
- **VRML** (5 packages): TKDEVRML, VrmlConverter, VrmlAPI, Vrml, VrmlData, DEVRML
- **GLTF** (3 packages): TKDEGLTF, RWGltf, DEGLTF
- **OBJ** (3 packages): TKDEOBJ, RWObj, DEOBJ
- **PLY** (3 packages): TKDEPLY, RWPly, DEPLY
- **Cascade native** (5 packages): TKDECascade, DEBRepCascade, DEXCAFCascade, DEBREP, DEXCAF
- **RWMesh** (2 packages): TKRWMesh, RWMesh

#### Persistence/serialization (30+ packages)

All Bin/Xml/Std persistence drivers excluded (not needed in WASM):

- TKBin*, TKXml*, TKStd\*, TKBinXCAF, TKXmlXCAF, etc.
- TKTObj, TObj

#### HLR toolkit packages (commented but not excluded)

The fork comments indicate HLR (TKHLR, HLRTopoBRep, HLRBRep, HLRAlgo, HLRAppli, Intrv, Contap)
are **included** for 2D projection (makeProjectedEdges), though individual classes within may be filtered.

#### Expression parser and Helix (4 packages)

- TKExpress: Expr, ExprIntrp
- TKHelix: HelixBRep, HelixGeom

#### DE plugin framework (3 packages)

TKDE, DE, DEBRep — plugin framework without transitive deps from bound code.
Note: DESTEP is NOT filtered — STEPCAFControl uses DESTEP_Parameters at runtime.

#### Draw module toolkit names (20+ packages)

Fork adds toolkit-level exclusions (TKDraw, TKTopTest, TKViewerTest, TKQADraw, etc.)
that upstream only excluded at the package level.

---

## 3. filterMethodOrProperties.py — Method Filter Diff

### Summary

| Metric    | v7.6 upstream | V8 fork        |
| --------- | ------------- | -------------- |
| File size | 310 lines     | 495 lines      |
| New lines | —             | **+185 lines** |

### Shared rules (both versions)

Both versions share identical rules for:

- `AppDef_MultiLine::SetParameter` (undefined symbol)
- `BSplCLib::DN` (no implementation)
- `BlendFunc::Knots/Mults` (no implementation)
- `AppDef_*::Error` (no implementation)
- `BinTools_Curve2dSet::Dump` (no implementation)
- `BinObjMgt_Persistent::Read` / `BinTools::Get*` (deleted istream ctor)
- `MeshVS_DataSource::GetGeom/GetGeomType` (std::function mismatch)
- Private constructor access rules (VrmlData_Node, Font_FTFont, LDOMString, etc.)
- Non-const lvalue reference rules (Resource_Unicode, NCollection_DataMap, etc.)
- Graphic3d_GraduatedTrihedron::CubicAxesCallback (raw pointer)
- MeshVS_TwoColors / Graphic3d_CStructure bit-fields
- Using declaration suppression
- AIS_ViewController/Aspect_WindowInputListener::Keys (deleted copy ctor)
- BRepClass3d_SolidExplorer::GetTree (private copy ctor)
- NCollection_Lerp::Interpolate (template specialization)
- NCollection_Sequence/List::Iterator (memory growth)
- Geom2d*/Geom* instantiation errors
- GeomAPI_ExtremaCurveSurface/CurveCurve::Extrema
- Select3D_SensitiveTriangulation::LastDetectedTriangle
- IntTools_Context::FClass2d/ProjPS/SolidClassifier
- Message_AttributeStream::Stream
- OpenGl_Context/GlFunctions/GraphicDriver/ShaderProgram/View
- NCollection_Vec2/3/4::cwiseAbs
- XCAFDoc_GeomTolerance copy constructor

### New generic rules in V8 fork

#### 1. Stream/IO type filtering (comprehensive expansion)

Upstream only filters `Standard_OStream` result types and `std::ifstream` type spellings.

The fork adds **comprehensive stream filtering** across both result types and method types:

```
Standard_OStream, std::ostream, Standard_IStream, std::istream,
std::ifstream, std::ofstream, std::stringstream, std::ostringstream,
std::istringstream, void *, void *
```

Checks both `result_type` and `type_spelling` for all stream types.

#### 2. NCollection container nested type filtering (new generic rule)

Two-tier system for unresolvable nested container types:

**Unbindable types** (always filtered):
`iterator`, `const_iterator`, `Iterator`, `size_type`, `difference_type`,
`pointer`, `const_pointer`, `allocator_type`, `ItemsView`, `ConstItemsView`

**Resolvable types** (filtered only if canonical type still contains them):
`value_type`, `reference`, `const_reference`, `Array1Type`, `Array2Type`, `SequenceType`

For resolvable types, the fork checks the canonical (fully-resolved) type — if the nested
name disappears in canonical form, the type is concrete and the method CAN be bound.

#### 3. Non-const enum output parameter filtering (generic rule + specific)

New **generic rule** that filters ANY method with a non-const enum lvalue reference parameter:

```python
if methodOrProperty.kind == clang.cindex.CursorKind.CXX_METHOD:
    for arg in methodOrProperty.get_arguments():
        if arg.type.kind == clang.cindex.TypeKind.LVALUEREFERENCE:
            pointee = arg.type.get_pointee()
            if pointee.kind == clang.cindex.TypeKind.ENUM and not pointee.is_const_qualified():
                return False
```

Plus specific per-class rules for classes where the generic rule is insufficient:

- `BSplCLib` (duplicate of generic, explicit)
- `Bnd_Box/Bnd_Box2d::Get/GetGap`
- `CSLib::Normal/DNNormal`
- `BlendFunc::GetShape`
- `ChFi3d::ConcaveSide/NextSide/SameSide`
- `GeomFill::GetShape`
- `PrsDim/PrsDim_EqualDistanceRelation::ComputeGeometry`
- `Quantity_Color::Values/ColorFromName`
- `TopAbs::Compose/Reverse`
- `V3d::GetProjAxis`
- `Graphic3d_MaterialAspect::MaterialName`
- `Font_FontMgr::FindFont`
- `OSD_Protection::User/System/Group/World`
- `Message::MetricFromString`, `Message_Messenger::GetTraceLevel/ChangePrinters`
- `StepData_StepReaderData::ReadEnumParam/ReadTypedParam`
- `STEPCAFControl_GDTProperty` (entire class)

#### 4. Deleted copy/move constructor filtering for specific V8 classes

```python
if theClass.spelling in ["BRepAlgoAPI_BuilderAlgo", "BRepMesh_IncrementalMesh",
    "BRepMesh_Delaun", "BRepMesh_Triangle", "CSLib_Class2d"]:
    if methodOrProperty.kind == clang.cindex.CursorKind.CONSTRUCTOR:
        for arg in methodOrProperty.get_arguments():
            if theClass.spelling in arg.type.spelling and "&" in arg.type.spelling:
                return False
```

#### 5. V8 deprecated/removed API filters

- `Limits` property — removed (deprecated math globals)
- `ReadStreamList` — removed
- `TColStd_PackedMapOfInteger::GetPackedMap` — requires template args now
- `NCollection_ItemsView` iterator access

#### 6. Nested type name method filters

Methods returning nested enum types that need class-qualified access:

- `gp_Dir::D`, `gp_Dir2d::D`
- `SelectMgr_SelectableObjectSet::BVHSubset`
- `AIS_Manipulator::OptionsForAttach`
- `Graphic3d_ShaderObject::ShaderVariableList`
- `Message_ProgressScope::NullString`
- `PCDM_ReaderFilter::AppendMode`
- `BRepGProp_MeshProps::BRepGProp_MeshObjType`
- `ShapeProcess::OperationsFlags`
- `XSAlgo_ShapeProcessor::ParameterMap`

#### 7. Message_Gravity enum class change

`Message_Messenger::GetTraceLevel` — `Message_Gravity` is now an enum class in V8.

---

## 4. bindings.py — Code Changes

### Summary

| Metric        | v7.6 upstream | V8 fork        |
| ------------- | ------------- | -------------- |
| File size     | 608 lines     | 737 lines      |
| Net new lines | —             | **+129 lines** |

### Structural changes

#### A. Bindings class constructor — `TuInfo` refactor

**Upstream** passes raw data:

```python
class Bindings:
    def __init__(self, typedefs, templateTypedefs, translationUnit):
        self.templateTypedefs = templateTypedefs
        self.translationUnit = translationUnit
        self.typedefs = typedefs
```

**Fork** uses a `TuInfo` object (pre-computed dictionaries):

```python
class Bindings:
    def __init__(self, tuInfo):
        self.tuInfo = tuInfo
```

The fork pre-computes `typedefUnderlyingDict` and `templateTypedefUnderlyingDict` as
dicts keyed by type spelling, replacing the linear-scan approach in upstream.

#### B. `isAbstractClass` signature change

**Upstream**: `isAbstractClass(theClass, self.translationUnit)` (takes translation unit)
**Fork**: `isAbstractClass(theClass, self.tuInfo.classDict)` (takes pre-built class dict)

#### C. Import change

**Upstream**: `from Common import occtBasePath`
**Fork**: Removed — `occtBasePath` no longer needed in bindings.py

#### D. Typedef resolution — `resolveWithCanonicalFallback` (new)

Fork adds a new method on `Bindings`:

```python
def resolveWithCanonicalFallback(self, spelling, clangType, templateDecl=None, templateArgs=None):
```

This resolves member typedefs (value_type, const_reference, Array1Type, etc.) by:

1. First attempting `getTypedefedTemplateTypeAsString` (same as upstream)
2. If result still contains a member typedef name, falling back to the canonical type
3. If canonical type contains `type-parameter-N-M`, mapping through templateArgs

This fixes incorrect type resolution for template specializations like
`NCollection_Array1<gp_Pnt>::value_type` → `gp_Pnt`.

#### E. `getTypedefedTemplateTypeAsString` — dict lookup vs linear scan

**Upstream** (O(n) scan):

```python
typedefType = next((x for x in self.typedefs if x.location.file.name.startswith(occtBasePath)
    and x.underlying_typedef_type.spelling == theTypeSpelling), None)
```

**Fork** (O(1) dict lookup):

```python
tud = self.tuInfo.typedefUnderlyingDict
if theTypeSpelling in tud:
    typedefType = tud[theTypeSpelling].spelling
```

Fork also adds `occ::` namespace normalization for V8 (which uses `occ::` alias for `opencascade::`).

#### F. EmbindBindings.processClass — base class filtering

**Upstream**: Always uses `baseSpec[0].type.spelling` for base class binding, even if it
contains `:` or `<`.

**Fork**: Skips base class binding if the type spelling contains `:` or `<`:

```python
if any(x in baseType for x in [":", "<"]):
    baseClassBinding = ""
else:
    baseClassBinding = ", base<" + baseType + ">"
```

#### G. EmbindBindings — nested enum binding (new)

Fork adds nested enum binding inside `processClass`:

```python
for child in theClass.get_children():
    if child.kind == clang.cindex.CursorKind.ENUM_DECL and child.access_specifier == ...:
        enumName = className + "_" + child.spelling
        isScoped = child.is_scoped_enum()
        # Emit enum_<ClassName::EnumName>("ClassName_EnumName")
```

This exposes nested enum types (e.g., `gp_Dir::D`, `AIS_Manipulator::BehaviorOnTransform`)
that V8 introduces as class-scoped enums.

#### H. TypescriptBindings — `_findBoundAncestor` (new)

Fork adds a method to walk the inheritance chain and find the nearest bound ancestor:

```python
def _findBoundAncestor(self, theClass):
```

When an intermediate class isn't in the build config, this finds the next ancestor that
IS included, so TypeScript `extends` references a declared class.

#### I. TypescriptBindings — nested enum TypeScript types and enum-aware arg/return resolution

Fork adds nested enum type declarations in TypeScript output and resolves enum types in
`getTypescriptDefFromResultType` and `getTypescriptDefFromArg` by checking if the
declaration is an `ENUM_DECL` with a class parent.

### The 3 Bugs — Status

#### Bug 1: `processSimpleConstructor` — single-constructor detection

**Both versions** have the same logic:

```python
constructors = list(filter(lambda x: x.kind == clang.cindex.CursorKind.CONSTRUCTOR, children))
if len(constructors) == 0:
    output += "    .constructor<>()\n"
    return output
publicConstructors = list(filter(...)...)
if len(publicConstructors) == 0 or len(publicConstructors) > 1:
    return output
```

This counts ALL constructors (including implicit copy/move) not just explicit ones. If a
class has one explicit public constructor plus an implicit copy constructor, `len(publicConstructors) > 1`
triggers and no simple constructor is emitted. **Both versions are affected.** The fork does
not fix this.

#### Bug 2: `select_overload` — method signature

Both versions filter `Select3D_SensitiveTriangulation::LastDetectedTriangle` in
filterMethodOrProperties because it triggers `select_overload` errors. The underlying
`select_overload` usage in `processMethodOrProperty` uses `needsWrapper` logic that
generates wrapper lambdas.

**Upstream's `needsWrapper`**: Checks for lvalue ref to builtin, enum, pointer, or
template type parameter — generates a wrapper with `emscripten::val` arguments.

**Fork's `needsWrapper`**: Same logic, identical implementation.

The fork adds `resolveWithCanonicalFallback` for return type resolution in
`getTypescriptDefFromResultType`, which handles some cases where `select_overload` would
previously fail by providing better type info. But the core `select_overload` mechanics
are unchanged. **Both versions are affected** by the fundamental issue.

#### Bug 3: Handle resolution — typedef lookup

**Upstream**: Linear scan through all typedefs looking for `underlying_typedef_type.spelling`
match. This can fail or return wrong results for ambiguous typedef spellings.

**Fork**: Dict-based lookup with `occ::` / `opencascade::` normalization. This is more
robust but still has the same fundamental limitation: it resolves typedefs by string
matching on type spellings, which can lose information for complex template types.

**Status**: Fork partially improves this with `resolveWithCanonicalFallback`, but the
underlying approach is the same. The `occ::` normalization is V8-specific and necessary
because OCCT V8 uses the `occ::` namespace alias alongside `opencascade::`.

---

## 5. generateBindings.py — Diff

### Summary

| Metric       | v7.6 upstream              | V8 fork             |
| ------------ | -------------------------- | ------------------- |
| File size    | 267 lines                  | 225 lines           |
| Architecture | multiprocessing + re-parse | Single TuInfo parse |

### Key differences

#### A. Architecture — TuInfo vs re-parsing

**Upstream** uses `multiprocessing.Pool` with a `parse()` function that re-creates the
clang translation unit in each worker process. Each worker batch calls `parse()` again,
recreating typedefs and template typedefs from scratch.

**Fork** uses a single `TuInfo` object created once, then passed to all process functions.
No multiprocessing — sequential processing with pre-computed data structures.

```python
# Upstream
def processChildBatch(customCode, generator, buildType, extension, filterFunction,
    processFunction, typedefGenerator, templateTypedefGenerator, preamble, customBuild, batch):
    tu = parse(customCode)  # Re-parse in each worker!
    ...

# Fork
def processChildren(tuInfo: TuInfo, children, extension, filterFunction,
    processFunction, preamble, customBuild):
    for child in children:
        ...  # Uses pre-parsed tuInfo
```

#### B. Function signatures — all generation functions

**Upstream**: `embindGenerationFuncClasses(tu, preamble, child, typedefs, templateTypedefs)`
(passes raw translation unit + typedef generators)

**Fork**: `embindGenerationFuncClasses(tuInfo: TuInfo, preamble, child)` (passes TuInfo object)

#### C. Path constants

**Upstream**: Hard-coded Docker paths (`/opencascade.js/build/`, `/occt/src/`)
**Fork**: Uses `OCJS_ROOT` and `OCCT_ROOT` from Common module

#### D. Include statements

**Upstream**: Generates `ocIncludeStatements` inline from `ocIncludeFiles`
**Fork**: Imports `ocIncludeStatements` from Common

#### E. Template typedef filtering

**Fork** adds `_FILTERED_TEMPLATE_TYPEDEFS` frozenset to skip specific problematic typedefs:

```python
_FILTERED_TEMPLATE_TYPEDEFS = frozenset({
    "Handle_math_NotSquare",
    "Handle_math_SingularMatrix",
    "TColStd_PackedMapOfInteger",
    "TColStd_SequenceOfAddress",
    "TopTools_IndexedDataMapOfShapeAddress",
})
```

#### F. Null safety

Fork adds null checks on `child.location.file`:

```python
# Fork
child.location.file is not None and child.location.file.name == "myMain.h"
# Upstream
child.location.file.name == "myMain.h"  # Can NPE
```

#### G. Empty/invalid spelling filter

Fork adds `child.spelling.startswith("(")` check to filter anonymous types.

#### H. `parse()` function removed

Fork removes the inline `parse()` function entirely — parsing is handled by the `TuInfo`
class. The upstream `parse()` creates the clang index, translation unit, and prints
diagnostics inline.

---

## 6. Cross-Cutting Observations

### Fork design philosophy

1. **Aggressive package filtering**: The fork excludes ~3x more packages than upstream,
   removing all visualization (Three.js handles rendering), all non-STEP/STL data exchange,
   all persistence drivers, and all Draw/test packages. This dramatically reduces WASM size.

2. **Generic V8 compatibility rules**: Rather than adding per-class filters for every V8
   API change, the fork adds generic rules (non-const enum refs, NCollection nested types,
   stream types) that handle entire categories of breaking changes.

3. **Performance**: The fork replaces multiprocessing + re-parsing with pre-computed
   dictionaries (TuInfo), trading parallelism for simplicity and correctness.

4. **Nested enums**: V8 introduces more scoped enum types inside classes. The fork adds
   both C++ Embind bindings and TypeScript declarations for these.

5. **Dead code note**: The fork includes an important comment in filterPackages.py noting
   that with non-LTO builds, `wasm-ld --gc-sections` performs effective function-level
   dead code elimination, making aggressive manual filtering less necessary but still
   valuable for build speed and binary size.
