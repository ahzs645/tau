# Gallery verification

The catalogue is shared by the browser loader, static route builder, source archives and this Node harness. It contains 20 public examples, 30 executable model variants and one static scene; the preserved Wham project remains hidden. Binary assets are loaded as bytes, and shared BOSL2 sources are mounted at their original relative paths. Preserved SCAD variants explicitly select the pinned classic OpenSCAD engine using `runtimeKernel: "openscad"`; public `openscad` variant IDs stay unchanged. OpenRSCAD requires an explicit selection and is never an error fallback.

From the workspace root, run the complete geometry and export matrix:

```sh
corepack pnpm nx run gallery:verify-models --all-exports --regressions --write-artifacts --variant-timeout=600000
```

Where Nx cannot create its local plugin socket, the equivalent standalone command is:

```sh
node --import tsx apps/gallery/scripts/verify-models.ts --all-exports --regressions --write-artifacts --variant-timeout=600000 --report=out/reports/gallery/verification.json
```

Each executable variant runs in a separate process. An external watchdog covers startup, description, synchronous native rendering, export, analysis and disposal; it can terminate a blocked WASM/native operation. The controller does not load the runtime graph. The parent writes a checkpoint after every variant and the child after every scenario. A process killed by the environment is a failed case, never a pass.

For a smaller run, select `--project=stamp --variant=openscad`. Both `--name=value` and `--name value` are accepted. `--all-exports` tests every declared export for every selected parameter scenario. Without it, every rendered case still checks that GLB export is nonempty and matches the preview bounds.

Every requested format is attempted even when an earlier format fails. Per-format errors remain in the report and keep the overall case failing. `--write-glb` retains both the preview and exported GLB; `--write-artifacts` also retains every other returned export. Files are saved before validation, so a failed strict export or integrity claim cannot erase the geometry needed to diagnose it. Report entries retain preview paths, export paths and kernel diagnostics.

## Expected public coverage

With `--all-exports --regressions --write-glb --variant-timeout=600000`, no project or variant filters, and the current catalogue, an entirely passing run has these counts:

| Evidence                                    |                                            Expected count |
| ------------------------------------------- | --------------------------------------------------------: |
| Public projects                             |                                                        20 |
| Projects with executable sources            |                                                        19 |
| Executable variants                         |                30: 16 OpenSCAD, 8 OpenCASCADE, 6 Replicad |
| Static scenes                               |                                    1: atmospheric sampler |
| Default cases                               |                               31: 30 executable, 1 static |
| Additional stamp component cases            |                                                         2 |
| Additional PET opener preset cases          |                                                         7 |
| Additional presets from other projects      |                                                        39 |
| Additional bottle preset/fit combinations   |                                    8: 4 presets at 2 fits |
| Additional bottle part/bed cases            |                                                         4 |
| Expected bottle input rejections            |                                                         2 |
| Total case rows                             |                                                        93 |
| Rows with measured geometry                 |                               90: 89 executable, 1 static |
| Export-format attempts                      |                                                       378 |
| Default cross-variant comparisons           | 11: 10 passing comparisons, 1 documented stamp difference |
| Bottle printability cases / compiled claims |                                                   12 / 24 |

The 378 export attempts comprise 89 GLB, 80 STL, 80 STEP, 74 3MF and 55 OBJ conversions. These are format requests, not output-file counts: a format can return multiple part files. Explicit curated format allowlists are retained. Three cases require specific input rejections: the two bottle cases and the inherited keyguard `New set 2` preset included in the 39 other-project preset rows. Successful expected-rejection cases contain no geometry or exports. A render failure or timeout can reduce the number of reached exports and leave fewer scenario rows; neither counts as passing coverage.

The preserved Wham source remains hidden and is excluded from the public matrix, including explicit `--project=wham` requests. The command exercises every one of the 50 authored public preset definitions on its declared default variant. Each preset replaces overrides over the source defaults, matching the UI. The 4 bottle presets receive their existing two fit cases instead of duplicate ordinary preset cases; the other 46 presets, including all 7 PET opener presets, each receive one case. Keyguard `New set 2` requests a frame while explicitly disabling its frame flag. The original source and original engine produce an empty result for that exact preset; the matrix now requires the precise actionable assertion documented in its [source notes](../models/projects/keyguard-with-raised-tabs/SOURCE.md), retaining every saved value. Its separate native integration control enables only that flag and requires a real frame and STL. No other saved preset is expected to fail. Stamp artwork uses the preserved binary files; upload replacement also has dedicated runtime and browser tests.

With `--write-glb`, the 89 successful executable geometry cases retain 178 files in total: one preview and one exported GLB each. The static source is measured directly and is not duplicated into the artifact directory. Other formats are validated but their bytes are retained only with `--write-artifacts`. Artifact references in the matrix report are repository-relative.

The absolute ten-minute child cap covers the entire variant, including all its scenarios and exports; for example, the bottle variant has 15 cases and up to 65 format requests, the periodic-table variant has 14 cases and up to 70 requests, and the keyguard variant has 11 cases and up to 50 requests. The dense SCAD lamp requires four cases and twenty exports; a local default-only attempt reached geometry outputs but was killed after 117 seconds before completing its final format. That incomplete attempt does not establish hosted timing or passing coverage. These are whole-variant deadlines; an expensive preset or accumulated work can cause an explicit timeout, which must be investigated rather than counted as coverage. `complete` records whether the controller finished its selected variant attempts, so it can be true alongside failures. Acceptance requires `complete: true`, `passed: true`, all expected coverage, and exit code 0. Failed cases, exports, parity comparisons and timed-out children produce a nonzero exit code. A deliberately paused batch can exit 0 with `complete: false` and `passed: false`.

## Share a bounded verification slot

Use the same report path to run and resume a batch:

```sh
node --import tsx apps/gallery/scripts/verify-models.ts --all-exports --regressions --max-variants=3 --report=out/reports/gallery/verification.json
node --import tsx apps/gallery/scripts/verify-models.ts --all-exports --regressions --max-variants=3 --resume --report=out/reports/gallery/verification.json
```

`--max-variants` stops after whole variant processes. Sending `SIGUSR1` to the controller requests the same checkpoint boundary after its current child finishes. A paused report has `complete: false` and `passed: false`; completed attempts can be reused, and existing failures remain failures. A successful pause returns exit code 0, while any failed check returns nonzero. A complete passing run requires `complete: true` and `passed: true`.

`--variant-timeout=600000` adds an absolute ten-minute cap for each child across all its operations. An outer host deadline can also bound the controller, for example `timeout --kill-after=5s 300s node --import tsx ...` for a deliberately limited local batch. Each cap fails unfinished work; it never turns a timeout into completed evidence.

Resume fingerprints the exact model/library bytes, relevant runtime/plugin sources, harness sources, dependency lockfile, Node version/platform and selected checks. It refuses stale evidence when those inputs change. Completed variant attempts are reused, including their failures, so a small batch can advance beyond a known failure. `--retry-failures` explicitly reruns completed failed variants; interrupted attempts without a final completion marker are rerun automatically. A successful child missing a required scenario also fails coverage validation. Start a new report after a source fix. The optional `--baseline=path/to/report.json` compares matching scenario envelopes against an independently produced report.

## What the evidence establishes

The geometry reader traverses scene instances with their full world transforms. It counts triangle primitives only and checks finite vertices, nonempty surfaces, bounds, surface area and signed volume. Generated previews and GLB exports use Y-up metres; report bounds are Y-up millimetres. Cross-kernel comparisons use a 0.5 mm envelope tolerance, with documented intentional differences in model metadata. Bounds establish an envelope comparison, not identical internal topology.

STL validation decodes every returned binary or ASCII part, checks complete triangles and finite vertices, and compares their aggregate placement and bounds against the preview. The declared printable export convention is Z-up millimetres. The exact mapping `(x, y, z) → (x, z, -y)` converts STL coordinates to the report's Y-up millimetres. The asymmetric, translated two-part fixture verifies this signed mapping; sorting dimensions would miss an orientation or placement error. These are geometry checks, not a universal watertightness proof.

Other formats receive structural checks recorded explicitly as `level: "structure"`: 3MF ZIP manifests, well-formed XML, finite vertices, triangle indices and build/component references; STEP physical-file markers, header/schema/data sections, unique entity IDs and geometric surface entities; OBJ finite vertex records and valid face indices. These checks detect malformed or empty exports but do not certify exact BRep validity, printed material volume or mesh topology. Native conversion errors still fail the case, and a successful signature or structure check never overrides them.

Regression cases exercise every authored public preset and preserve the stamp/handle choice with an independent physical size oracle from the original binary STL, plus bottle separator arrangements, fit changes, modular bed sizes and invalid input rejection. Bottle printability adds compiled GeoSpec claims for watertight surfaces and the original connected-component count at 0.001 mm tolerance. GeoSpec 0.6 cannot admit Y-up scenes, so the analysis boundary explicitly wraps the original scene roots with a rotation to Z-up, preserving all binary chunks and extensions. The report records the source and admitted coordinate systems and SHA-256 hashes. The exact canonical claims, plans and results are retained, and failed or refused analysis fails the case. These topology requirements apply only to the bottle scenarios that historically promised printable closed parts.

Static previews preserve the old gallery scale and explicitly rotate inherited Z-up scenes to Y-up. The atmospheric sampler has no trustworthy authored physical-unit metadata; its inherited dimensions remain ambiguous, as recorded in the model's `COORDINATES.md`.
