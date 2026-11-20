# Component selection contract

The stamp's geometry, SVG artwork and binary STL templates retain their original source and bytes. The only OpenSCAD declaration change moves `component_selection` from `[Hidden]` into a `[Model]` dropdown, with the same default `stamp` and values `stamp` / `handle`.

The public runtime derives its admitted parameter contract from declared customizer inputs. A hidden variable was absent from that contract, so the old flat `component_selection: "handle"` override initially returned the unchanged stamp. The gallery's runtime maps the legacy flat key to the declared `Model` group, while the UI retains its dedicated Component selector. `svg_file` stays hidden because uploads replace the fixed artwork file instead of selecting another path.

The semantic regression uses the preserved handle STL, which has extents 20 × 23.094011306762695 × 50 mm in the source's Z-up coordinates. The handle result must therefore measure 20 × 50 × 23.094011306762695 mm in canonical Y-up coordinates. This assertion catches both an ignored component change and a unit/axis error; nonempty output alone is insufficient.

Run `pnpm nx run gallery:verify-models --project=stamp --variant=openscad --regressions` to render both components and compare GLB export bounds with the preview. The original OCCT variant intentionally contains only the plate and SVG strokes, as documented in its source; the handle selector is scoped to OpenSCAD.
