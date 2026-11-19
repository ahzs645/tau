# Gallery model projects

## Ownership and discovery

Each folder owns its `project.json`, source, presets, helper modules, binary inputs and attribution. The folder name is the stable `?model=` and static-route ID. Do not add a manual registry, `index.json` or generated manifest.

The browser catalogue in `../../src/catalog/catalog.ts` discovers `models/*/*/project.json` through Vite. `../../scripts/catalog-node.ts` reads the same metadata for verification. A `hidden: true` project remains in source and has no public route; keep its visibility unless a product change explicitly calls for promotion.

## Model contract

- `entry` is an existing relative path; nested helpers and assets use the same project-relative namespace. Reject traversal and preserve filename case.
- Keep every required source and binary input. `.stl` and `.3mf` are bytes, never decoded as editor text. Source downloads include presets, binaries, attribution and declared libraries.
- A project can declare `libraries: ["BOSL2"]`. The catalogue mounts the pinned source under `BOSL2/` from `../libraries/BOSL2`; preserve its source version and license notices. Project geometry and helper code remain in their owning folder.
- Keep original author headers, licenses and source provenance. Recovered files record a source commit and exact Git blob hash in `SOURCE.md`. Do not relicense imported models.
- Curated examples use the sibling `../curated` collection and the same catalogue contract.

## Kernel variants

`variants` declares alternate implementations. Preserve public IDs `openscad`, `opencascade` and `replicad`; the runtime uses `openrscad` internally for the OpenSCAD variant. The entry matching project `entry` is the default.

Raw OpenCASCADE sources import `libcascade`; Replicad sources import `replicad`. Preserve each model's authored `defaultParams` and exported `jsonSchema`, including dropdowns, bounds and conditional fields. Presets and initial parameters apply only to the default variant unless compatibility is explicitly declared.

`previewTessellation` and `previewNativeEdges` are preview settings, not geometry changes. An intentional difference between variants requires source evidence and explicit `parityExclusions` metadata; do not hide a failed comparison. Static preview axes must be declared when different from canonical glTF. Never infer physical scaling from mesh dimensions alone.

## Verification

Run from the repository root:

```bash
pnpm nx test gallery --watch=false
pnpm nx typecheck gallery
pnpm nx lint gallery
pnpm nx run gallery:verify-models --project=<id> --all-exports --write-glb
```

For changes affecting shared libraries or catalogue/runtime contracts, verify all public variants. `--regressions` exercises bottle fit, modular-bed assertions and PET opener presets. The harness reads actual binary dependencies, applies scene transforms, counts triangle surfaces only, compares physical bounds and exits nonzero on failure. A successful render alone does not establish geometry parity.

Model sources are runtime assets, excluded from application lint/typecheck; the real execution harness checks them through each kernel. Application catalogue code and harnesses remain fully linted and typechecked. See `../../MIGRATION.md` for the migration's scope and evidence.
