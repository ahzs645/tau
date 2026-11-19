# Gallery integration and maintenance

## Application charter

This private, deployable application owns the parametric model gallery at
`https://3dd.ahmadjalil.com`. It composes public Tau runtime, CAD plugin, parameter,
UI and viewer packages. Its output is ordinary static files: browsing, parameter
changes, model rendering, source downloads and mesh exports run in the browser.

The gallery owns its catalogue, routes, share payloads, file uploads, presentation
and Pages deployment. It has no account, API server, database, billing, Electron,
or private Tau infrastructure dependency. It uses the current upstream runtime,
viewer and CAD packages, with an explicitly selected compatibility adapter for
the gallery's original OpenSCAD engine. Fork-specific integration stays here.

Upstream's `create-package` guidance classifies this as an application under
`apps/`, not a publishable package. The upstream research/handbook symlinks point
to the optional private Tau Brain checkout, which this fork does not have. This
file is the fork's application charter and deployment runbook; no build requires
that private checkout or replaces those symlinks.

## History and rollback

The integration preserves both Git parents. It incorporates upstream main at
`c63defc4de87d95c425b5cbc644e481949e7c3b0`, starting from fork main at
`996774cc25a147c085fbdcc47a4a89cc0dfe701f`. A local backup branch,
`backup/pre-upstream-20261119`, records the original fork revision. The old gallery
and its source history remain accessible at that exact commit.

The implementation takes upstream's current application and package tree, then
ports the fork's gallery into this application. The existing shared ancestry is
real and retained; this is a merge integration, not a new unrelated import or a
force push. The Pages workflow changes its build owner from `ui` to `gallery`.

Before publishing the migration, build and verify the integration branch locally.
The PR does not deploy. Adopt this PR with **Create a merge commit** so main
retains the imported upstream ancestry. Squashing or rebasing the whole PR would
discard that merge relationship and cause future syncs to revisit upstream's
already integrated history. Merging into `main` runs the fork's Pages workflow.
To roll back an adopted migration, revert the PR merge commit with its first
parent as mainline and deploy that reviewed rollback commit. Do not reset or
force-push shared main.

## Compatibility contract

- Preserve public project IDs, original variant IDs, curated examples, presets,
  binary inputs, local helpers, posters and third-party attribution.
- Accept `/<model>`, `/playground?model=<model>`, `?example=<model>`, and old
  `/tau/` routes. Preserve `1.raw.<base64url>` parameter payloads and variant
  selection. Emit real per-model `index.html` files for GitHub Pages.
- Keep actual interactive CAD rendering. A static model is explicitly marked as
  static; cached pictures never stand in for a failed CAD model.
- Use dedicated browser workers and the public runtime document lifecycle.
  Recreate sessions when uploaded files change. Dispose sessions on navigation.
  Parameter reset means the model defaults plus current overrides; removed
  overrides must not linger in a worker or an export.
- Use the public viewer's artifact/hash contract, controls, measurement and
  section tools. Preview dimensions are reported in millimetres. Browser proofs
  run without cross-origin-isolation headers, as on GitHub Pages.
- Honour explicit model `jsonSchema` exports for OpenCASCADE and Replicad so
  authored ranges, choices and units survive the runtime upgrade.
- Keep source downloads complete, including binary dependencies and attribution.
  Shared URLs encode parameters; local uploaded files remain local.
- Preserve upstream `LICENSE` and `NOTICE` and the licences of bundled models
  and libraries. The private application does not publish an npm package.

## Toolchain and local checks

Use Node 24 and the repository's pinned package manager through Corepack. Never
regenerate the lockfile with another pnpm major or use a non-frozen install in CI.

```sh
corepack enable
ELECTRON_SKIP_BINARY_DOWNLOAD=1 corepack pnpm install --frozen-lockfile
corepack pnpm nx run-many -p gallery -t lint,typecheck,test,build --parallel=1
corepack pnpm nx run gallery:verify-runtime
corepack pnpm nx run gallery:verify-models --all-exports --regressions --write-glb --variant-timeout=120000
corepack pnpm nx run scripts:validate-fork-workflows
corepack pnpm exec playwright install chromium
corepack pnpm nx run gallery:verify-browser
```

Run installs sequentially. When checks run in parallel, set
`pnpm_config_verify_deps_before_run=error` to avoid concurrent implicit installs.
Nx Cloud remains disabled. Test output belongs under `out/reports/gallery` and
`out/test-results/gallery`.

On memory-constrained machines, set `PNPM_MAX_WORKERS=1` for installation. This
limits pnpm's package extraction workers separately from `--child-concurrency`,
which controls dependency build scripts. Existing upstream lockfile entries are
preserved. The gallery importer adds workspace dependencies, reuses the locked
`saxes` version, and pins the original `openscad-wasm-prebuilt@1.2.0` package with
the exact integrity from the old fork.

The model verifier must parse exported geometry, distinguish triangles from
lines, apply node transforms, convert metres to millimetres, check finite bounds
and fail on unexpected model or parity errors. Inventory checks alone do not
prove the models work. Browser checks serve the built files from a plain static
server and exercise the real WASM workers, links and downloads.

The verifier runs each executable variant in a separate process, with both an
operation deadline and an absolute parent watchdog. Reports distinguish a paused
or incomplete run from a successful run. Use `--resume` to continue a report whose
source and toolchain fingerprint still matches; use `--retry-failures` explicitly
to rerun recorded failures. `--max-variants=N` bounds a local batch. Export checks
continue after an individual format fails so the report describes every attempted
format. The GLB and STL checks verify transformed geometry and signed axis
correspondence; OBJ, 3MF and STEP checks also inspect each format's actual data
structures. Structural export checks do not by themselves prove solid validity.

## OpenSCAD and export compatibility

The preserved SCAD catalogue explicitly selects `runtimeKernel: "openscad"`.
This runs the original pinned engine through the current public kernel, document
and worker APIs. `openrscad` remains a separate explicit choice; an error never
silently changes the engine. An unchanged rack support was a valid closed solid
under the old engine, while OpenRSCAD skipped its failed Boolean operations. A
successful runtime response containing an error diagnostic is therefore rejected
instead of displaying or exporting a partial result.

The compatibility adapter mounts the actual source closure and binary inputs in
a fresh engine instance. It retains the exact original Geist Regular and Bold
font files because the newer workspace font package contains different bytes.
See `src/runtime/classic/NOTICE.md` for source, package integrity, font hashes and
component licenses. The production output includes those notices and the engine
and font license files, linked from the gallery footer.

Native OFF supplies colored preview geometry and native STL preserves Z-up
millimetres. The GLB representation uses Y-up metres; the public viewer reports
dimensions in its Z-up world. These coordinate frames must not be confused when
comparing dimensions. The pinned engine's native 3MF command traps even for a
plain cube, so 3MF uses the public strict Assimp transcoder. OBJ and faceted STEP
also use that transcoder. SCAD's **STEP (faceted)** export preserves mesh surfaces;
OpenCascade and Replicad retain their native exact STEP export paths.

OpenCascade emits individual face primitives within a part. For noncanonical
GLB-to-3MF input, the Assimp adapter consolidates compatible primitives within
each original node before the existing strict manifold checks. It preserves node
placement and material boundaries and does not weld unrelated parts or repair
invalid geometry. Inputs that declare canonical manifold topology retain their
existing conversion path. Native regression fixtures must prove both successful
closed-part conversion and continued rejection of an open part.

## Workflows

`github-pages.yml` builds and deploys this gallery only for `ahzs645/tau` main.
`gallery-checks.yml` runs one bounded validation job on every PR targeting main,
including strict types and lint for the gallery and changed compatibility
packages, unit tests, the production build, focused native
kernel compatibility tests, the complete geometry/export matrix with regression
assertions, and the static production browser suite. Manual dispatch can select
the geometry and browser suites independently. Geometry artifacts and verification
reports are retained for 14 days with the workflow run.
`upstream-drift.yml` fetches real upstream main and reports actual ahead/behind
counts; it does not confuse an affected-project check with an upstream sync.

The upstream workflow files remain in place. Their jobs are guarded with
`github.repository == 'taucad/tau'`, keeping release, staging, package publishing,
desktop runners and upstream schedules from executing in this fork. Every future
sync must retain those guards and cover newly added upstream jobs. The
`scripts:validate-fork-workflows` check rejects missing guards and conditions that
could escape the repository restriction. Gallery validation and Pages builds run
that check explicitly. This fork does not need upstream deployment credentials.

## Future upstream updates

1. Fetch origin and upstream, create an integration branch from origin main and
   record both input SHAs. Check `git rev-list --left-right --count
origin/main...upstream/main`; do not guess the distance from calendar age.
2. Merge upstream main, keeping its core implementation and adapting this
   application through public APIs. Review any local kernel changes explicitly.
   Apply the fork workflow guards to new upstream jobs and run their validator.
3. Update the lockfile once with the pinned package manager, then require a
   frozen install. Run the local gates above. Inspect the static output, desktop
   and mobile screenshots, model changes and exports.
4. Open a reviewed integration PR with pinned revisions and concrete results.
   Publish through the fork Pages workflow after the PR is approved and merged.

## Validation record

The integration remains a draft until the current commit passes every gate. The
initial hosted run is [Actions run 44629360588](https://github.com/ahzs645/tau/actions/runs/44629360588)
on the first review commit, `6026eaebd85f6071fec940e6414655f931272127`:

- The complete frozen install, 49 gallery unit/helper tests, nine focused kernel
  tests and the static production build passed.
- Six of seven real Chromium browser scenarios passed, including routing, SCAD
  parameter edits and downloads, native OpenCascade and Replicad STEP downloads,
  and mobile controls. The remaining assertion confused the exported GLB's Y-up
  dimension order with the viewer's Z-up labels; its geometry assertions passed.
- Full application typechecking found one indexed-property access error. Typed
  lint also found actionable diagnostics. These were corrected in the review
  branch; a later green run must establish their final status.
- Screenshot review found a desktop navigation visibility issue and a shrinking
  parameter form that could overlap attribution. Both were corrected, and the
  browser suite now asserts those layout boundaries.

Further local investigation established that the original unchanged rack support
is a closed solid in the original engine: 96 vertices, 192 triangles, no boundary
or over-incident edges, and 14.3 × 222.4 × 249 mm Z-up bounds. The classic adapter's
native integration tests exercise the public document lifecycle, parameter edits
and reset, all five export formats, per-face color/alpha, binary SVG replacement,
and missing-include rejection. All four real session integrations pass. Both the
full rack assembly and its individually colored support export native STL and
strict 3MF without error issues. Before/after canonical-topology checks establish
exact equality of triangle counts, dimensions, signed volume and surface area.
Closed multi-color bodies carry canonical topology only when the original OFF
vertex identities, winding, vertex links and serialized Float32 areas pass the
explicit validation; open or invalid bodies receive no canonical claim.

Independent native BRep validation of the preserved OpenCascade rack found five
valid solids, no open or non-manifold edges, no free bounds, and a maximum stored
tolerance of 1e-7 mm. The original 3MF failure was traced to the converter testing
individual face fragments separately. This evidence supports a conversion-path
fix; it does not justify accepting invalid geometry or weakening strict checks.
The corrected native 3MF route passes for that saved rack, retaining all five
parts and every triangle on re-import, with the largest coordinate change below
0.00002 mm. Native regressions also retain strict rejection of open and malformed
inputs and preserve the existing canonical topology/material provenance route.

Local checks cannot replace the hosted gates. The workspace cannot start
Chromium because its process socket is denied, and connected browsers cannot
reach its static server. The full application compiler can also exceed the local
native-memory ceiling. The PR workflow supplies a normal runner for those checks,
the new classic-engine production worker, and all 30 executable catalogue
variants. Reports from an interrupted, paused or failed matrix are not a pass.

The atmospheric static asset retains its original bytes and documented ambiguous
source units; no speculative rescaling is applied. See the model's
`COORDINATES.md`. A successful build or inventory check alone does not establish
model or export compatibility.
