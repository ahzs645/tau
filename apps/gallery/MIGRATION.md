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
`787e47d2a4cefa5d28c7488ef447253332679310`, starting from fork main at
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
  Parameter reset restores source defaults plus the project's declared initial
  parameters on its default variant, or source defaults alone on other variants.
  Other overrides must not linger in a worker or an export.
- Expose the admitted parameter description independently of successful geometry.
  A saved link whose first CAD render fails still has fields for correcting that
  render. Form edits normalize legacy flat keys before applying grouped changes;
  downloads remain unavailable while the current render is pending or failed.
- Cancel an in-flight export when its parameters, source assets, variant or
  session change, or when the page closes. A superseded operation must not
  download the old geometry, report an obsolete error or clear a newer export's
  busy state. Parameter editing remains available during exports.
- Use the public viewer's artifact/hash contract, controls, measurement and
  section tools. Preview dimensions are reported in millimetres. Browser proofs
  run without cross-origin-isolation headers, as on GitHub Pages.
- Honour explicit model `jsonSchema` exports for OpenCASCADE and Replicad so
  authored ranges, choices and units survive the runtime upgrade.
- Preserve every authored preset. Apply its values over source defaults on the
  declared default variant, including legacy `$fn`, `$fa` and `$fs` overrides.
  Reset removes those overrides rather than inventing a resolution default.
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
corepack pnpm nx run gallery:verify-models --all-exports --regressions --write-glb --variant-timeout=1200000
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
operation deadline and an absolute parent watchdog. Native export and structural
validation have separate operation deadlines. The hosted whole-variant cap is
twenty minutes because it includes every preset, export and validation: the SCAD
lamp alone has four dense cases and twenty format requests. Its fourth hosted
run spent 417 seconds on those cases before STEP validation encountered the
single-string limit. Incremental parsing needs additional time to inspect all
returned bytes, with measured local faceted STEP throughput of about 12–14 MiB/s.
The bounded headroom changes no native-operation limit, source resolution,
export coverage or validation requirement. Reports distinguish a paused
or incomplete run from a successful run. Use `--resume` to continue a report whose
source and toolchain fingerprint still matches; use `--retry-failures` explicitly
to rerun recorded failures. `--max-variants=N` bounds a local batch. Export checks
continue after an individual format fails so the report describes every attempted
format. The GLB and STL checks verify transformed geometry and signed axis
correspondence; OBJ, 3MF and STEP checks also inspect each format's actual data
structures. Structural export checks do not by themselves prove solid validity.
The complete regression selection covers all 50 authored public presets: 93
case rows and 378 format requests when every positive case succeeds. Three rows
require specific input rejections, including the inherited contradictory keyguard
frame preset. See
`scripts/README.md` for the exact coverage and acceptance requirements.

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

The private gallery bundle uses a narrowly scoped workspace patch for
`@cfworker/json-schema@4.1.1`. That version's decimal `multipleOf` check handles a
positive remainder close to the step but rejects the corresponding negative
remainder. As a result, the original pendant lamp's `pleat_offset = -1` fails
execution validation against its authored `0.1` step. The patch takes the absolute
remainder before the existing tolerance checks in the source and both shipped
JavaScript builds. It does not relax the schema, alter parameters, suppress
validation errors, or replace the validator's reference/combinator behavior.
Gallery-owned tests exercise both signs, invalid values between steps, nested
schemas, the real preserved lamp presets, and the public document lifecycle.

This patch is a compatibility measure for this private application build, not a
fix distributed by a published Tau package. No independently published package
may rely on it: workspace patches do not reach npm consumers. Remove it when the
pinned validator includes the sign correction, retaining the gallery regressions
and requiring a frozen install plus the full lamp matrix. An upstream dependency
fix should be contributed separately through its normal review process.

The original native OFF writer rounds coordinates to six significant digits,
which can collapse very small edges in otherwise distinct native triangles.
The compatibility adapter requests OFF and ASCII STL together, then checks every
face corner and shared OFF vertex identity before recovering the higher-precision
coordinates. It preserves the OFF faces and colors and rejects mismatched paired
outputs. Matching-resolution STL exports reuse a copy of that exact native ASCII
output instead of evaluating the source again. This does not make a canonical
topology claim when the coordinates subsequently collapse in GLB Float32 storage.

Native STL preserves Z-up millimetres. The GLB representation uses Y-up metres;
the public viewer reports dimensions in its Z-up world. These coordinate frames
must not be confused when comparing dimensions. OBJ and faceted STEP use the
public Assimp transcoder. SCAD's **STEP (faceted)** export preserves mesh surfaces;
OpenCascade and Replicad retain their native exact STEP export paths.

The classic adapter declares a direct 3MF export from the validated native mesh.
The pinned engine's own 3MF command traps even for a plain cube. Passing through
GLB also loses very small native edges in Float32 storage, and the pinned generic
converter validates different material surfaces separately. For the original
stamp, those surfaces are individually open even though the native solid is
closed. The gallery serializer implements 3MF Core directly with decimal Float64
coordinates in Z-up millimetres, preserving the existing owner partition, every
indexed face, and its original byte RGBA palette. Core display colors preserve
appearance; they do not assign printer materials or promise a printed color.

Direct 3MF validation requires finite coordinates, nonzero face area, exact
paired opposite edges, connected vertex links and positive volume for each
existing owner. It rejects invalid surfaces without welding, dropping faces,
flipping winding, or selecting another exporter after failure. A separate inward
cavity component is explicitly rejected: interpreting it as a hole in another
owner would require a different ownership contract. The GLB Float32 canonical
guard remains unchanged; valid native 3MF geometry does not grant a topology
claim to a lower-precision GLB.

OpenCascade emits individual face primitives within a part. For noncanonical
GLB-to-3MF input, the Assimp adapter consolidates compatible primitives within
each original node before the existing strict manifold checks. It preserves node
placement and material boundaries and does not weld unrelated parts or repair
invalid geometry. Inputs that declare canonical manifold topology retain their
existing conversion path. Native regression fixtures must prove both successful
closed-part conversion and continued rejection of an open part.

OpenCascade can also emit a free native vertex as a GLB POINTS primitive. For a
noncanonical 3MF surface conversion that contains both triangle surfaces and
points or lines, the adapter uses Assimp's supported primitive filter to exclude
those nonsurface primitives before strict validation. Pure point-cloud input
keeps its existing route. The saved pre-chamber export independently demonstrates
why this is necessary: its native BRep is valid, and the filtered strict round
trip retains all 49,860 exported surface triangles and the original part.

The precision bridge preserves the original indexed faces before GLB storage;
this is a different guarantee from the downstream generic mesh converter's
output. Before the direct classic 3MF path, the investigated keyguard preset
retained 4,258 native faces but produced 3,738 triangles through the strict
noncanonical converter after Float32 serialization. Those historical results
were not identical triangulation. Current direct classic 3MF tests must compare
native coordinates, face incidence, colors and owners independently. Matching
bounds alone never establish a universal printability guarantee.

The keyguard's `include_screenshot` option referenced a user-created
`screenshot.svg` that was never included in this fork. Its author documents this
as an alignment overlay to hide before rendering or printing. The source now
guards only that helper with `$preview`, leaving all preset values and printable
CSG expressions intact. See the model's `SOURCE.md` for provenance and the exact
one-line change. Missing assets required by actual geometry still fail.

Two inherited keyguard presets also need an explicit distinction. `New set 1`
has zero case-opening dimensions and produces the original raised mounting tabs
without a keyguard plate. Its native geometry remains a positive test case; the
gallery does not invent replacement dimensions. `New set 2` requests a keyguard
frame while setting `have_a_keyguard_frame` to `no`. The unchanged original source
and preset reproduce an empty top-level native object. A conditional source
assertion now explains the required frame settings instead of reporting only a
native exit status. Its preserved preset is tested as this specific rejection;
enabling the frame is an explicit parameter edit, not a rewritten saved preset.
The model's `SOURCE.md` records both findings and the original-engine baseline.

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
counts, with manual dispatch and a weekly Monday 07:23 UTC schedule after adoption
on main. Its read-only job records both revisions and adds a workflow warning when
upstream has commits to integrate. Use that report to start the reviewed update
procedure below.

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

Current hosted results are attached to the
[integration PR](https://github.com/ahzs645/tau/pull/28/checks). Acceptance requires
the current commit to pass every gate and the complete model report to meet the
coverage contract in `scripts/README.md`. A draft checkpoint, a historical green
subset, or a successful build alone does not meet that requirement.

The first hosted run,
[44629360588](https://github.com/ahzs645/tau/actions/runs/44629360588),
on `6026eaebd85f6071fec940e6414655f931272127`, established the production path and
found the first compiler and browser issues:

- The complete frozen install, 49 gallery unit/helper tests, nine focused kernel
  tests and the static production build passed.
- Six of seven real Chromium browser scenarios passed, including routing, SCAD
  parameter edits and downloads, native OpenCascade and Replicad STEP downloads,
  and mobile controls. The remaining assertion confused the exported GLB's Y-up
  dimension order with the viewer's Z-up labels. This run predated strict rejection
  of success responses containing error diagnostics; its stamp envelope check is
  not evidence of faithful Boolean geometry.
- Full application typechecking found one indexed-property access error. Typed
  lint also found actionable diagnostics. These were corrected in the review
  branch; a later green run must establish their final status.
- Screenshot review found a desktop navigation visibility issue and a shrinking
  parameter form that could overlap attribution. Both were corrected, and the
  browser suite now asserts those layout boundaries.

The second hosted run,
[44639701892](https://github.com/ahzs645/tau/actions/runs/44639701892),
on `d82c011e253387c90a0fbf729d85dbf44ada0b09`, ran the pinned classic engine:

- The frozen install, workflow guards, 107 unit/helper tests, production build and
  17 native compatibility tests passed. Six of seven real Chromium scenarios
  passed, including actual license responses and exact original font hashes.
- All 30 executable variants were attempted. The then-current 54-case matrix
  completed with 48 passing cases and six failures; it reached 195 format
  requests. It was a failed run, not complete passing export coverage.
- Failures identified numeric Customizer choices, legacy resolution overrides,
  the pre-chamber's free point in a surface conversion, and lost precision in
  classic OFF output. The stamp browser scenario stopped at rendering; its later
  3MF, STEP and artwork replacement assertions were not reached.
- Further compiler/lint findings were corrected with scoped typed lint and nine
  passing native OCCT, Replicad and OpenRSCAD compatibility tests. The expanded
  preset selection and subsequent geometry fixes require new hosted evidence.

The third hosted run,
[44647194009](https://github.com/ahzs645/tau/actions/runs/44647194009),
on `a682177e3892176a541377fbc480dd5232bd9efe`, integrated upstream
`787e47d2a4cefa5d28c7488ef447253332679310` and attempted the full preset matrix:

- The frozen install, workflow guards, all five project typechecks, all four
  changed public-package lint checks, 161 gallery tests, production build,
  21 native compatibility tests and all seven real Chromium scenarios passed.
- Gallery ESLint found remaining naming violations at authored parameter and
  file-format boundaries. These are corrected with narrow boundary annotations
  and ordinary local binding names, preserving the original external keys.
- All 93 case rows were attempted: 86 passed and seven failed. Of 358 format
  requests reached, two failed. No variant exceeded its deadline. These are
  failed-run counts, not a passing coverage claim.
- Four lamp cases were rejected by the negative-decimal validator defect. One
  keyguard preset requested a frame while disabling that frame. Two original
  stamp cases rendered and passed their other formats but failed strict 3MF
  conversion. The passing browser stamp download used replacement artwork and
  did not cover that original-artwork failure.

The fourth hosted run,
[44656896671](https://github.com/ahzs645/tau/actions/runs/44656896671),
on `dda296792543826bb488e9b2ed7c3053cdf9b972`, exercised the direct native 3MF
route, corrected decimal validation and initial-render recovery:

- The frozen install, workflow guards, all five lint targets, all four changed
  public-package typechecks, 184 gallery tests, production build and 25 native
  compatibility tests passed. Gallery typechecking found five diagnostics in
  the new recovery test: three unsupported Testing Library query options and
  two digest fixtures that needed the public `contentDigest` constructor.
- The complete matrix reached all 93 rows, all 90 measured geometry rows and
  all 378 format requests. There were 89 passing rows and four failures, all in
  the SCAD lamp's STEP validation. All 74 3MF requests passed, including the
  unchanged original stamp artwork and every valid keyguard preset. All eleven
  comparisons completed: ten passed and the documented stamp difference remained.
- The lamp produced all four STEP files successfully. The verifier then tried
  to decode each entire file into one JavaScript string and hit the engine's
  string-size limit. This was a verification-reader limitation, not a native
  export error. All four lamp cases were attempted; no variant deadline expired.
  Validation must read the actual output incrementally while retaining the same
  structural checks and all original model resolutions.
- Seven of eight real Chromium scenarios passed. The new keyguard recovery
  scenario reached the actionable error and available controls, then failed to
  locate a field outside the mounted portion of the virtualized form. Its schema
  preserves the raw `have_a_keyguard_frame` title. The scenario now uses the real
  parameter search and that exact accessible name before exercising correction,
  download, failed-preset reapplication and reset.

The follow-up STEP reader decodes at most 64 KiB at a time, tracks lexical and
section state across chunks, and preserves exact entity-ID uniqueness without
collecting full records. It passes 26 focused cases, including a logical 513 MiB
input, every split point through quoted/commented UTF-8 content and malformed
section headers. Four retained native STEP exports also pass, including the
11,719,946-byte, 234,686-entity rack. Returned filenames and byte lengths are
recorded before validation so later failures retain useful evidence. The full
local gallery suite passes 210 tests; the complete hosted matrix and Chromium
recovery scenario remain the acceptance gates for these corrections.

The fifth hosted run,
[44662411916](https://github.com/ahzs645/tau/actions/runs/44662411916),
on `6bdaab7d420b585cef3441915503fb0c6e3e5d04`, confirmed the incremental reader
and saved-preset recovery while exposing a second large-file bookkeeping limit:

- The frozen install, workflow guards, all five lint and typecheck targets,
  210 gallery tests, production build, 25 native compatibility tests and all
  eight real Chromium scenarios passed.
- All 93 case rows, 90 measured geometry rows, 378 format requests and eleven
  comparisons were reached. There were 91 passing rows and two failures, both
  STEP structural validation for the denser SCAD lamp presets. The other 376
  format requests passed; this run still failed acceptance.
- The default and first preset STEP files passed at 641,106,167 and 704,900,535
  bytes, containing 12,990,983 and 14,235,465 entities. The second and third
  preset files were produced at 942,270,551 and 1,247,634,180 bytes, then failed
  with `Set maximum size exceeded`. Their geometry and native export succeeded.
- A missing or deferred low entity ID kept all later IDs in the prefix tracker's
  single pending set. The replacement uses exact sparse pages that become compact
  bitmaps, with bounded map levels across the complete safe-integer range. It
  retains duplicate detection for unordered and sparse IDs without a collection
  entry per dense entity or an allocation up to the largest ID. Its regression
  admits more than 16.7 million descending IDs with the lowest ID deferred, then
  rejects repeated IDs at the beginning, middle and end.

The completion review also found an export lifecycle race: the runtime correctly
pins an export to its requested evaluation, but the page previously downloaded
its result after the user had changed that evaluation. Deferred-operation
regressions now cover failed edits, overlapping old and new exports, source and
variant replacement, and unmounting. The page forwards cancellation and checks
request ownership before downloading or changing export state. These corrections
keep the complete geometry, native and browser gates required on the final PR
revision; the fifth run's passing subset is not a substitute for them.

Local completion checks pass all 228 gallery unit/helper tests and the production
build. Scoped typed lint, ESLint and formatting pass for the changes; the local
ESLint invocation cannot exercise the graph-dependent boundary rule. The full
application typecheck and a selected native lamp matrix were terminated by the
local environment before producing a complete result, and Chromium still cannot
create its required process socket. Those attempts are not passing evidence;
the final hosted run owns the complete type, geometry and browser verdicts.

Further local investigation established that the original unchanged rack support
is a closed solid in the original engine: 96 vertices, 192 triangles, no boundary
or over-incident edges, and 14.3 × 222.4 × 249 mm Z-up bounds. The classic adapter's
native integration tests exercise the public document lifecycle, parameter edits
and reset, all five export formats, per-face color/alpha, binary SVG replacement,
and missing-include rejection. All four real session integrations in the
`d82c011e` checkpoint passed. Both the
full rack assembly and its individually colored support export native STL and
strict 3MF without error issues. Before/after canonical-topology checks establish
exact equality of triangle counts, dimensions, signed volume and surface area.
Closed multi-color bodies carry canonical topology only when the original OFF
vertex identities, winding, vertex links and serialized Float32 areas pass the
explicit validation; open or invalid bodies receive no canonical claim.

The paired precision conversion has independent native checks beyond its parser
fixtures. Forty-two signed midpoint, adjacent-double and decimal-boundary samples
establish the pinned OFF writer's exact nearest-even rounding. A public document
session checks those coordinates and independent copies of cached ASCII STL.
The original stamp's isolated paired operation retains all 4,360 vertices and
8,716 faces, passes the GLB/STL geometry comparison and reports no native error or
warning issues. These focused proofs do not replace the full preset matrix or
the browser artwork-replacement and download scenarios.

The direct classic 3MF regression also uses the original stamp artwork through
the public session. An independent archive reader compares every native Float64
coordinate and vertex identity, all 8,716 oriented faces, the four per-face RGBA
assignments and the single owner with the precise native mesh. Its bounds,
signed volume and surface area are unchanged, with no edge-closure or orientation
faults. The smallest retained face has an area of approximately 9.72e-12 mm².
Those tiny native faces are preserved even though some corresponding preview
positions coincide after GLB Float32 storage. A separate Three.js consumer test
checks the archive's display colors and alpha; that appearance check does not
claim that every downstream slicer preserves arbitrary coordinate precision.

Independent native BRep validation of the preserved OpenCascade rack found five
valid solids, no open or non-manifold edges, no free bounds, and a maximum stored
tolerance of 1e-7 mm. The original 3MF failure was traced to the converter testing
individual face fragments separately. This evidence supports a conversion-path
fix; it does not justify accepting invalid geometry or weakening strict checks.
The corrected Assimp 3MF conversion passes for that saved rack, retaining all five
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
