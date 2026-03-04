# Replicad OCCT Symbol Usage Audit

**Date**: 2026-03-03
**Purpose**: Cross-reference all symbols bound in the opencascade.js YAML build config against actual runtime usage in replicad source code to identify (1) missing symbols causing runtime failures and (2) unused symbols inflating WASM binary size.

---

## Methodology

1. Extracted all 231 `- symbol:` entries from `custom_build_single_v8.yml` (now 216 after Tier 1 removals)
2. Searched every `.ts` file in `repos/replicad/packages/replicad/src/` for `oc.<ClassName>` patterns (runtime OpenCASCADE API calls)
3. Cross-referenced to classify each symbol as: **used**, **required** (base class / return type / parameter type), or **unused**
4. Verified gaps by reading the replicad source files that trigger "unbound types" errors

### Source files analyzed (22 files with `oc.` usage)

| File                               | OCCT API surface                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `shapes.ts`                        | TopExp, BRepBndLib, BRepMesh, BRep_Tool, TopLoc, OCJS_ShapeHasher, ShapeUpgrade, BRepTools |
| `shapeHelpers.ts`                  | BRepPrimAPI, BRepBuilderAPI, BRepOffsetAPI, BRepFeat, BRepAlgoAPI, ShapeFix                |
| `geom.ts`                          | gp\_\* (Pnt, Vec, Dir, Ax1, Ax2, Ax3, Trsf, GTrsf, etc.)                                   |
| `curves.ts`                        | GC_MakeArcOfCircle, BRepAdaptor, BRepBuilderAPI, GeomAbs                                   |
| `Sketcher2d.ts`                    | gp*2d types, BRepBuilderAPI, GCE2d*\_, Geom2dAPI\_\_                                       |
| `addThickness.ts`                  | BRepOffsetAPI_MakeThickSolid                                                               |
| `measureShape.ts`                  | BRepGProp, GProp_GProps, BRepExtrema                                                       |
| `definitionMaps.ts`                | TopAbs, TopExp, BRepAdaptor, GeomAbs, Geom types                                           |
| `lib2d/*.ts`                       | Geom2d*\*, Geom2dAPI*\*, BndLib_Add2dCurve, Bnd_Box2d, gp_2d                               |
| `export/assemblyExporter.ts`       | XCAF (TDocStd, XCAFDoc, TDataStd), STEPCAFControl, Interface_Static, Message_ProgressRange |
| `importers.ts`                     | STEPControl_Reader, StlAPI_Reader, Message_ProgressRange                                   |
| `projection/makeProjectedEdges.ts` | **HLRBRep_Algo, HLRAlgo_Projector, HLRBRep_HLRToShape, Handle_HLRBRep_Algo**               |
| `utils/ProgressRange.ts`           | Message_ProgressRange                                                                      |
| `sketches/CompoundSketch.ts`       | TopoDS_Builder, TopoDS_Compound                                                            |
| `blueprints/Blueprint.ts`          | Various 2D geometry                                                                        |

---

## Critical Gaps — Missing Symbols

These symbols are called at runtime by replicad but **not present** in the YAML build config. Any code path that uses these will crash with "unbound types" errors.

### HLR (Hidden Line Removal) — 2D Projection

**Impact**: `makeProjectedEdges()` was completely broken. This is replicad's 2D projection/SVG export feature.

| Symbol                 | Usage                                             | File                                  |
| ---------------------- | ------------------------------------------------- | ------------------------------------- |
| `HLRBRep_Algo`         | `new oc.HLRBRep_Algo_1()`                         | `projection/makeProjectedEdges.ts:22` |
| `HLRBRep_InternalAlgo` | Base class of `HLRBRep_Algo`                      | (required by embind hierarchy)        |
| `HLRAlgo_Projector`    | `new oc.HLRAlgo_Projector_2(camera.wrapped)`      | `projection/makeProjectedEdges.ts:25` |
| `HLRBRep_HLRToShape`   | `new oc.HLRBRep_HLRToShape(...)`                  | `projection/makeProjectedEdges.ts:31` |
| `Handle_HLRBRep_Algo`  | `new oc.Handle_HLRBRep_Algo_2(hiddenLineRemoval)` | `projection/makeProjectedEdges.ts:32` |

**Status**: Fixed 2026-03-03. Required three types of changes:

1. **YAML bindings** — added 5 symbols + 1 Handle typedef to both `custom_build_single_v8.yml` and `custom_build_with_exceptions_v8.yml`
2. **Package filter** — un-excluded `TKHLR`, `HLRTopoBRep`, `HLRBRep`, `HLRAlgo`, `HLRAppli`, `Intrv`, and `Contap` from `filterPackages.py`
3. **wasm-opt** — fixed `buildFromYaml.py` to always pass `--enable-exception-handling` to wasm-opt (HLR code uses C++ exceptions internally)

### Previously Fixed (this session)

| Symbol                       | Usage                                           | Status                    |
| ---------------------------- | ----------------------------------------------- | ------------------------- |
| `Handle_Law_Function`        | `Law_BSpFunc.Trim()` return type                | **Fixed** — added to YAML |
| `Handle_Geom2d_BSplineCurve` | `Geom2dAPI_PointsToBSpline.Curve()` return type | **Fixed** — added to YAML |

---

## Tier 1 Removal Results (2026-03-03)

Attempted removal of all 16 Tier 1 symbols at once, then added back only those that caused test failures.

### Successfully Removed (15 symbols)

| Symbol                                    | Confirmed unused |
| ----------------------------------------- | ---------------- |
| `Bnd_OBB`                                 | No test failures |
| `GeomAPI_Interpolate`                     | No test failures |
| `GeomAPI_PointsToBSplineSurface`          | No test failures |
| `GC_MakeArcOfEllipse`                     | No test failures |
| `BRepPrimAPI_MakeTorus`                   | No test failures |
| `BRepPrimAPI_MakeRevolution`              | No test failures |
| `BRepOffsetAPI_MakePipe`                  | No test failures |
| `StlAPI_Writer`                           | No test failures |
| `STEPControl_Writer`                      | No test failures |
| `StlAPI`                                  | No test failures |
| `BRepCheck_Analyzer`                      | No test failures |
| `ShapeFix_EdgeConnect`                    | No test failures |
| `Geom2dConvert_ApproxCurve`               | No test failures |
| `Geom2dConvert_BSplineCurveToBezierCurve` | No test failures |
| `Geom_ConicalSurface`                     | No test failures |

### Had to Restore (1 symbol)

| Symbol                           | Failure                                                                                         | Root cause                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GeomAdaptor_TransformedSurface` | `Cannot construct BRepAdaptor_Surface_2 due to unbound types: 30GeomAdaptor_TransformedSurface` | Required base class of `BRepAdaptor_Surface` — should be reclassified to Tier 3 |

**Net result**: 15 of 16 Tier 1 symbols removed. Binding count reduced from 231 → 216 (single) / 218 (with_exceptions).

---

## Unused Symbols — Removal Candidates

### Tier 1: High-Confidence Removals — COMPLETED

All 15 confirmed-removable symbols have been removed from both YAML configs. See "Tier 1 Removal Results" above.

~~**Total Tier 1**: 16 symbols~~ → **15 removed**, 1 reclassified to Tier 3 (`GeomAdaptor_TransformedSurface`)

### Tier 2: Medium-Confidence Removals

These are NOT directly called by replicad but may be needed as embind base class registrations for classes that ARE used. Removing these requires testing the link step.

| Symbol                         | Why it might be needed                         | Why it might not                                                                |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `TColgp_Array1OfDir`           | Parameter type for some BSpline constructors   | Replicad never constructs direction arrays                                      |
| `TColgp_Array2OfPnt`           | Parameter for `GeomAPI_PointsToBSplineSurface` | That class is unused (Tier 1 removal)                                           |
| `TColgp_Array1OfVec`           | Parameter for some BSpline constructors        | Replicad never constructs vector arrays                                         |
| `TColStd_Array1OfBoolean`      | Parameter for some BSpline constructors        | Replicad never uses boolean arrays                                              |
| `TColStd_Array1OfInteger`      | Knot multiplicity arrays for BSpline           | Only needed if `GeomAPI_Interpolate` overloads are called (they aren't)         |
| `Poly_Array1OfTriangle`        | Triangulation access                           | Not directly constructed; triangles accessed via `Poly_Triangulation` methods   |
| `gp_Cylinder`                  | Enum-like type                                 | Not constructed directly; cylinder shape created via `BRepPrimAPI_MakeCylinder` |
| `gp_Ax22d`                     | 2D axis                                        | Not used by replicad; `gp_Ax2d` IS used                                         |
| `Convert_ParameterisationType` | Enum for `Geom2dConvert`                       | Only needed if `Geom2dConvert` methods are called (they aren't)                 |
| `XCAFDoc_LengthUnit`           | XCAF document                                  | Not directly used but may be needed by XCAF document initialization             |
| `CDM_Document`                 | Base of `TDocStd_Document`                     | Required if embind needs the base class registered                              |
| `Geom2dConvert`                | Static conversion class                        | Not used by replicad                                                            |
| `GeomConvert`                  | Static conversion class                        | Not used by replicad                                                            |

**Total Tier 2**: 13 symbols

### Tier 3: Base Classes — Required for Type Hierarchy

These are NOT directly called by replicad but are base classes of used classes. Embind requires base class registration for proper type casting. **Do not remove.**

| Symbol                           | Derived classes used by replicad                                                 |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `Standard_Transient`             | Base of all handle-managed OCCT objects                                          |
| `BRepBuilderAPI_Command`         | Base of `BRepBuilderAPI_MakeEdge`, `MakeWire`, `MakeFace`, etc.                  |
| `BRepBuilderAPI_MakeShape`       | Base of all BRepBuilderAPI make classes                                          |
| `BRepBuilderAPI_ModifyShape`     | Base of `BRepBuilderAPI_Transform`                                               |
| `BRepAlgoAPI_Algo`               | Base of `BRepAlgoAPI_BuilderAlgo`                                                |
| `BRepAlgoAPI_BuilderAlgo`        | Base of `BRepAlgoAPI_BooleanOperation`                                           |
| `BRepAlgoAPI_BooleanOperation`   | Base of `Cut`, `Fuse`, `Common`                                                  |
| `BRepPrimAPI_MakeOneAxis`        | Base of `MakeCylinder`, `MakeSphere`                                             |
| `BRepPrimAPI_MakeSweep`          | Base of `MakePrism`, `MakeRevol`                                                 |
| `BRepFilletAPI_LocalOperation`   | Base of `MakeFillet`, `MakeChamfer`                                              |
| `BRepFeat_Form`                  | Base of `BRepFeat_MakeDPrism`                                                    |
| `BOPAlgo_Options`                | Base of `BRepAlgoAPI_Algo`                                                       |
| `GCE2d_Root`                     | Base of all `GCE2d_Make*` classes                                                |
| `GC_Root`                        | Base of `GC_MakeArcOfCircle`                                                     |
| `Geom_Geometry`                  | Base of `Geom_Curve`, `Geom_Surface`                                             |
| `Geom_Curve`                     | Base of `Geom_BezierCurve`, etc.                                                 |
| `Geom_Surface`                   | Base of `Geom_ElementarySurface`, etc.                                           |
| `Geom_BoundedCurve`              | Base of `Geom_BezierCurve`, `Geom_BSplineCurve`                                  |
| `Geom_BoundedSurface`            | Base of `Geom_BSplineSurface`                                                    |
| `Geom_ElementarySurface`         | Base of `Geom_CylindricalSurface`, `Geom_SphericalSurface`                       |
| `Geom_TrimmedCurve`              | Returned by `GC_MakeArcOfCircle.Value()`                                         |
| `Geom_BSplineCurve`              | Returned by `GeomAPI_PointsToBSpline.Curve()`                                    |
| `Geom_BSplineSurface`            | Returned by surface construction methods                                         |
| `Geom2d_Geometry`                | Base of all Geom2d classes                                                       |
| `Geom2d_Curve`                   | Base of all Geom2d curve classes                                                 |
| `Geom2d_BoundedCurve`            | Base of `Geom2d_BezierCurve`, `Geom2d_BSplineCurve`                              |
| `Geom2d_Conic`                   | Base of `Geom2d_Circle`, `Geom2d_Ellipse`                                        |
| `Geom2d_Ellipse`                 | Type returned by `GCE2d_MakeEllipse.Value()`                                     |
| `Adaptor3d_Curve`                | Base of `BRepAdaptor_Curve`                                                      |
| `Adaptor3d_Surface`              | Base of `BRepAdaptor_Surface`                                                    |
| `GeomAdaptor_TransformedSurface` | Base of `BRepAdaptor_Surface` (required for `BRepAdaptor_Surface_2` constructor) |
| `Adaptor2d_Curve2d`              | Base of `BRepAdaptor_Curve2d`, `Geom2dAdaptor_Curve`                             |
| `ShapeFix_Root`                  | Base of `ShapeFix_Wire`, `ShapeFix_Face`, `ShapeFix_Solid`                       |
| `TDF_Attribute`                  | Base of XCAF attribute classes                                                   |
| `TDataStd_GenericEmpty`          | Base of `TDataStd_Name` hierarchy                                                |
| `TDataStd_GenericExtString`      | Base in name hierarchy                                                           |
| `NCollection_BaseList`           | Base of `TopTools_ListOfShape`                                                   |
| `Precision`                      | Static utility class used internally by OCCT algorithms                          |
| `GeomLib`                        | Static utility class used by `Geom2dAdaptor_Curve`                               |
| `GeomTools`                      | Used by `GeomToolsWrapper` (custom wrapper)                                      |
| `MoniTool_TypedValue`            | Base of `Interface_Static` hierarchy (via `Interface_TypedValue`)                |
| `Interface_TypedValue`           | Base of `Interface_Static`                                                       |

### Return Type / Parameter Type Dependencies

These are not directly instantiated but appear as return types or parameter types of methods on used classes.

| Symbol                                                        | Why needed                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| `Poly_Triangulation`                                          | Return type of `BRep_Tool.Triangulation()`                  |
| `Poly_PolygonOnTriangulation`                                 | Return type of `BRep_Tool.PolygonOnTriangulation_1()`       |
| `Poly_Triangle`                                               | Accessed via `Poly_Triangulation.Triangle()`                |
| `TopTools_ListOfShape`                                        | Return type of `BRepAlgoAPI_*.Modified()`, `.Generated()`   |
| `TopLoc_Location`                                             | Parameter/return type for triangulation extraction          |
| `IFSelect_ReturnStatus`                                       | Return type of `STEPCAFControl_Writer.Write()`              |
| `Message_ProgressRange`                                       | Parameter of STEP/STL read/write operations                 |
| `TColgp_Array1OfPnt`                                          | Parameter for `GeomAPI_PointsToBSpline` constructors        |
| `TColgp_Array1OfPnt2d`                                        | Parameter for `Geom2dAPI_PointsToBSpline` constructors      |
| `TColStd_Array1OfReal`                                        | Parameter for BSpline knot arrays                           |
| `TCollection_ExtendedString`                                  | Used in XCAF name/doc construction                          |
| `Quantity_Color`                                              | Base of `Quantity_ColorRGBA`; used in XCAF color operations |
| `Quantity_ColorRGBA`                                          | Used in `assemblyExporter.ts` for color assignment          |
| `IFSelect_WorkSession`                                        | Base of `XSControl_WorkSession`                             |
| `XSControl_Reader`                                            | Base of `STEPControl_Reader`                                |
| `BRepAdaptor_Curve2d`                                         | Used via adaptor hierarchy for curve analysis               |
| `Geom2dAdaptor_Curve`                                         | Used for 2D curve adaptation                                |
| `TopoDS_Edge/Face/Wire/Shell/Vertex/Solid/Compound/CompSolid` | Shape subtypes used as param/return types throughout        |
| `TopoDS_Builder`                                              | Used in `CompoundSketch.ts`                                 |
| `TopAbs_Orientation`                                          | Return type of `TopoDS_Shape.Orientation()`                 |
| `GeomAbs_CurveType/SurfaceType/Shape`                         | Enum return types from adaptor queries                      |
| `BOPAlgo_GlueEnum`                                            | Parameter for boolean algorithm configuration               |
| `ChFi3d_FilletShape`                                          | Parameter for `BRepFilletAPI_MakeFillet.SetFilletShape()`   |
| `ChFiDS_ChamfMode`                                            | Parameter for `BRepFilletAPI_MakeChamfer`                   |
| `BRepBuilderAPI_TransitionMode`                               | Parameter for `BRepOffsetAPI_MakePipeShell`                 |
| `BRepBuilderAPI_WireError`                                    | Return type of `BRepBuilderAPI_MakeWire.Error()`            |
| `BRepOffset_Mode`                                             | Parameter for `BRepOffsetAPI_MakeOffsetShape`               |
| `BRepFill_TypeOfContact`                                      | Parameter for `BRepOffsetAPI_MakePipeShell`                 |
| `Extrema_ExtAlgo`                                             | Parameter for `BRepExtrema_DistShapeShape`                  |
| `GeomAbs_JoinType`                                            | Parameter for `BRepOffsetAPI_MakeOffset`                    |
| `STEPControl_StepModelType`                                   | Parameter for `STEPCAFControl_Writer.Transfer()`            |
| `XCAFDoc_ColorType`                                           | Enum for color assignment in XCAF                           |
| `BRepGProp_Face`                                              | Used for face property computation                          |

---

## Summary

| Category                                    | Count | Action                                | Status   |
| ------------------------------------------- | ----- | ------------------------------------- | -------- |
| **Critical gaps** (missing, caused crashes) | 7     | Added to YAML                         | Done     |
| **Previously fixed** (this session)         | 2     | Added to YAML                         | Done     |
| **Tier 1 removals** (high confidence)       | 15    | Removed from YAML                     | **Done** |
| **Tier 1 reclassified** (actually Tier 3)   | 1     | `GeomAdaptor_TransformedSurface` kept | Done     |
| **Tier 2 removals** (medium confidence)     | 13    | Remove one-by-one, test               | Pending  |
| **Required base classes**                   | ~41   | Keep                                  | —        |
| **Return/param type deps**                  | ~33   | Keep                                  | —        |
| **Directly used**                           | ~120  | Keep                                  | —        |

### Final Binding Count

| Variant         | Before | After | Reduction |
| --------------- | ------ | ----- | --------- |
| Single          | 231    | 216   | -15       |
| With Exceptions | 233    | 218   | -15       |

### Next Steps

1. **Tier 2 removals** — 13 symbols that may or may not be needed as base class registrations. Must be tested individually.
2. **Production rebuild** — current builds use `-O0`. A production build with `-O2` and LTO will yield the final size numbers.
3. **Focus optimization effort on** `filterPackages.py` and `wasm-opt` flags for meaningful size reductions.

---

## Appendix: Complete Symbol Cross-Reference

### Directly Used (120 symbols)

Symbols where replicad calls `oc.<ClassName>` at runtime:

```
BndLib_Add2dCurve          BRepAdaptor_CompCurve      BRepAdaptor_Curve
BRepAdaptor_Surface        BRepAlgoAPI_Common          BRepAlgoAPI_Cut
BRepAlgoAPI_Fuse           BRepAlgoAPI_Section         BRepBndLib
BRepBuilderAPI_MakeEdge    BRepBuilderAPI_MakeFace     BRepBuilderAPI_MakeShell
BRepBuilderAPI_MakeSolid   BRepBuilderAPI_MakeVertex   BRepBuilderAPI_MakeWire
BRepBuilderAPI_Sewing      BRepBuilderAPI_Transform    BRepExtrema_DistShapeShape
BRepFeat_MakeDPrism        BRepFilletAPI_MakeChamfer   BRepFilletAPI_MakeFillet
BRepGProp                  BRepGProp_Face              BRepLib
BRepMesh_IncrementalMeshWrapper  BRepOffsetAPI_MakeFilling  BRepOffsetAPI_MakeOffset
BRepOffsetAPI_MakeOffsetShape    BRepOffsetAPI_MakePipeShell  BRepOffsetAPI_MakeThickSolid
BRepOffsetAPI_ThruSections       BRepPrimAPI_MakeBox    BRepPrimAPI_MakeCylinder
BRepPrimAPI_MakePrism      BRepPrimAPI_MakeRevol       BRepPrimAPI_MakeSphere
BRepToolsWrapper           BRep_Tool                   BRepTools
Bnd_Box                    Bnd_Box2d                   BOPAlgo_GlueEnum
BRepBuilderAPI_TransitionMode  BRepBuilderAPI_WireError  BRepFill_TypeOfContact
BRepOffset_Mode            ChFi3d_FilletShape          Extrema_ExtAlgo
GC_MakeArcOfCircle         GCE2d_MakeArcOfCircle       GCE2d_MakeArcOfEllipse
GCE2d_MakeCircle           GCE2d_MakeEllipse           GCE2d_MakeSegment
GCPnts_TangentialDeflection  Geom2dAPI_ExtremaCurveCurve  Geom2dAPI_InterCurveCurve
Geom2dAPI_PointsToBSpline  Geom2dAPI_ProjectPointOnCurve  Geom2dAdaptor_Curve
Geom2d_BSplineCurve        Geom2d_BezierCurve          Geom2d_Circle
Geom2d_Line                Geom2d_OffsetCurve          Geom2d_TrimmedCurve
GeomAPI_PointsToBSpline    GeomAPI_ProjectPointOnSurf  GeomAbs_CurveType
GeomAbs_JoinType           GeomAbs_Shape               GeomAbs_SurfaceType
GeomConvert                GeomLib                     GeomToolsWrapper
Geom_BezierCurve           Geom_CylindricalSurface     Geom_SphericalSurface
GProp_GProps               gp_Ax1                      gp_Ax2
gp_Ax2d                    gp_Ax3                      gp_Circ
gp_Circ2d                  gp_Dir                      gp_Dir2d
gp_Elips                   gp_Elips2d                  gp_GTrsf
gp_GTrsf2d                 gp_Pnt                      gp_Pnt2d
gp_Sphere                  gp_Trsf                     gp_Trsf2d
gp_Vec                     gp_Vec2d                    gp_XY
Handle_Geom2d_Curve        Handle_Geom_Curve           Handle_Geom_Surface
Handle_TDocStd_Document    Handle_XSControl_WorkSession
HLRAlgo_Projector*         HLRBRep_Algo*               HLRBRep_HLRToShape*
Handle_HLRBRep_Algo*       IFSelect_ReturnStatus       Interface_Static
Law_Linear                 Law_S                       Message_ProgressRange
OCJS_ShapeHasher           Quantity_ColorRGBA          STEPCAFControl_Writer
STEPControl_Reader         STEPControl_StepModelType   ShapeFix_Face
ShapeFix_Solid             ShapeFix_Wire               ShapeUpgrade_UnifySameDomain
StlAPI_Reader              TColgp_Array1OfPnt          TColgp_Array1OfPnt2d
TCollection_ExtendedString TDataStd_Name               TDocStd_Document
TopAbs_Orientation         TopAbs_ShapeEnum            TopExp_Explorer
TopLoc_Location            TopTools_ListOfShape        TopoDS_Builder
TopoDS_Cast                TopoDS_Compound             TopoDS_Shell
XCAFDoc_ColorType          XCAFDoc_DocumentTool        XCAFDoc_ShapeTool
XSControl_WorkSession
```

\* = Added to YAML 2026-03-03 (were missing, caused runtime crashes)

### Not Directly Used but Required (~74 symbols)

Base classes, return types, and parameter type dependencies. See tables above (includes `GeomAdaptor_TransformedSurface` reclassified from Tier 1).

### Unused — Successfully Removed (15 symbols)

Tier 1 removals completed 2026-03-03. See "Tier 1 Removal Results" section above.

### Unused — Removal Candidates Remaining (13 symbols)

See Tier 2 table above.
