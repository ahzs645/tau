# Root Playground Engine Strategy

The root playground should build on Tau's existing runtime stack rather than carrying the older custom `occt-wasm` runner forward.

## Engine Roles

- OpenSCAD: use Tau's OpenSCAD kernel for SCAD models, BOSL-style examples, and compatibility with existing OpenSCAD gallery files.
- Replicad: use Tau's Replicad kernel as the main ergonomic OpenCascade modeling layer for new TypeScript examples and helpers.
- OpenCascade direct: keep direct `opencascade.js` examples for low-level kernel access, debugging, and cases where Replicad does not expose the needed primitive or topology operation.

This replaces the old `openscad-playgroundrack` custom OCCT runtime direction. The root UI should call Tau preview/export APIs and avoid a second CAD worker or a separate `occt-wasm` package path.

## Root Playground Scope

- The root page is a real CAD workspace: editor, live preview, parameters, and export.
- Export buttons should call the active Tau kernel runtime and download generated artifacts. Only expose formats that are valid for that example/kernel path; current OpenSCAD root examples expose `GLB`, while Replicad and direct OpenCascade examples cover `STEP`, `STL`, and `GLB`.
- Parameter controls should come from Tau's `useCadPreview()` state (`defaultParameters`, `jsonSchema`, `setParameters`) so OpenSCAD, Replicad, and OpenCascade examples behave consistently.
- Gallery ports should prefer self-contained models first. Models that depend on BOSL2, external SVG/STL assets, or old custom OCCT helpers should be ported after the dependency/runtime path is explicit.

## Old Gallery Port Map

Self-contained or low-risk first:

- Parametric Gel Comb: ported into the root examples as `gel-comb-scad`.
- Networking rack: ported into the root examples as `networking-rack-scad`.
- 3D Rack SCAD: good next OpenSCAD candidate, but it is larger and should be checked for render/export time.
- Vane Trap: useful, but currently BOSL2/threading-based; keep OpenSCAD-first until BOSL2 availability is confirmed.

Needs dependency or helper decisions:

- Pre-Chamber Nozzle Insert: depends on thread helpers; best port target once Replicad thread helpers are available.
- Tray, Wham: current SCAD entry files include missing `Untitled-1.scad`; inspect source assets before porting.
- Stamp, Keyguard: external asset driven; port after file gallery/import handling is in place.
- Old `(OCCT)` examples: rewrite to Replicad or Tau direct OpenCascade instead of importing the custom `ctx.solid` helper runtime.
