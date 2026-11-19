# Gallery verification

The catalogue is shared by the browser loader, static route builder, source archives and this Node harness. It contains 20 public examples, 30 executable model variants and one static scene; the preserved Wham project remains hidden. Binary assets are loaded as bytes, and shared BOSL2 sources are mounted at their original relative paths.

From the workspace root, run the complete geometry and export matrix:

```sh
pnpm nx run gallery:verify-models -- --all-exports --regressions --write-glb
```

Where Nx cannot create its local plugin socket, the equivalent standalone command is:

```sh
node --import tsx apps/gallery/scripts/verify-models.ts --all-exports --regressions --write-glb --report=out/reports/gallery/verification.json
```

Each executable variant runs in a separate process. An external watchdog covers startup, description, synchronous native rendering, export, analysis and disposal; it can terminate a blocked WASM/native operation. The controller does not load the runtime graph. The parent writes a checkpoint after every variant and the child after every scenario. A process killed by the environment is a failed case, never a pass.

For a smaller run, select `--project=stamp --variant=openscad`. Both `--name=value` and `--name value` are accepted. `--all-exports` tests every declared export for every selected parameter scenario. Without it, every rendered case still checks that GLB export is nonempty and matches the preview bounds.

## Share a bounded verification slot

Use the same report path to run and resume a batch:

```sh
node --import tsx apps/gallery/scripts/verify-models.ts --all-exports --regressions --max-variants=3 --report=out/reports/gallery/verification.json
node --import tsx apps/gallery/scripts/verify-models.ts --all-exports --regressions --max-variants=3 --resume --report=out/reports/gallery/verification.json
```

`--max-variants` stops after whole variant processes. Sending `SIGUSR1` to the controller requests the same checkpoint boundary after its current child finishes. A paused report has `complete: false` and `passed: false`; completed successful cases can be reused. A successful pause returns exit code 0, while any failed check returns nonzero. A complete passing run requires `complete: true` and `passed: true`.

`--variant-timeout=120000` adds an absolute two-minute cap for each child across all its operations. An outer host deadline can also bound the controller, for example `timeout --kill-after=5s 300s node --import tsx ...`. Each cap fails unfinished work; it never turns a timeout into completed evidence.

Resume fingerprints the exact model/library bytes, relevant runtime/plugin sources, harness sources, dependency lockfile, Node version and selected checks. It refuses stale evidence when those inputs change. Completed successful variants are reused; failed or incomplete variants are rerun. Start a new report after a source fix. The optional `--baseline=path/to/report.json` compares matching scenario envelopes against an independently produced report.

## What the evidence establishes

The geometry reader traverses scene instances with their full world transforms. It counts triangle primitives only and checks finite vertices, nonempty surfaces, bounds, surface area and signed volume. Generated previews and GLB exports use Y-up metres; report bounds are Y-up millimetres. Cross-kernel comparisons use a 0.5 mm envelope tolerance, with documented intentional differences in model metadata. Bounds establish an envelope comparison, not identical internal topology.

Regression cases preserve the stamp/handle choice with an independent physical size oracle from the original binary STL, every PET opener preset, and bottle separator arrangements, fit changes, modular bed sizes and invalid input rejection. Bottle printability adds compiled GeoSpec claims for watertight surfaces and the original connected-component count at 0.001 mm tolerance. GeoSpec 0.6 cannot admit Y-up scenes, so the analysis boundary explicitly wraps the original scene roots with a rotation to Z-up, preserving all binary chunks and extensions. The report records the source and admitted coordinate systems and SHA-256 hashes. The exact canonical claims, plans and results are retained, and failed or refused analysis fails the case. These topology requirements apply only to the bottle scenarios that historically promised printable closed parts.

Static previews preserve the old gallery scale and explicitly rotate inherited Z-up scenes to Y-up. The atmospheric sampler has no trustworthy authored physical-unit metadata; its inherited dimensions remain ambiguous, as recorded in the model's `COORDINATES.md`.
