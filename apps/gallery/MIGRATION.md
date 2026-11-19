# Gallery integration and maintenance

## Application charter

This private, deployable application owns the parametric model gallery at
`https://3dd.ahmadjalil.com`. It composes public Tau runtime, CAD plugin, parameter,
UI and viewer packages. Its output is ordinary static files: browsing, parameter
changes, model rendering, source downloads and mesh exports run in the browser.

The gallery owns its catalogue, routes, share payloads, file uploads, presentation
and Pages deployment. It has no account, API server, database, billing, Electron,
or private Tau infrastructure dependency. CAD execution and viewer behaviour stay
in the upstream packages; fork-specific integration stays here.

Upstream's `create-package` guidance classifies this as an application under
`apps/`, not a publishable package. The upstream research/handbook symlinks point
to the optional private Tau Brain checkout, which this fork does not have. This
file is the fork's application charter and deployment runbook; no build requires
that private checkout or replaces those symlinks.

## History and rollback

The integration preserves both Git parents. It incorporates upstream main at
`5e2048c5bb7b4b49b33ed4281cecce2ba928023a`, starting from fork main at
`996774cc25a147c085fbdcc47a4a89cc0dfe701f`. A local backup branch,
`backup/pre-upstream-20261119`, records the original fork revision. The old gallery
and its source history remain accessible at that exact commit.

The implementation takes upstream's current application and package tree, then
ports the fork's gallery into this application. The existing shared ancestry is
real and retained; this is a merge integration, not a new unrelated import or a
force push. The Pages workflow changes its build owner from `ui` to `gallery`.

Before publishing the migration, build and verify the integration branch locally.
The PR does not deploy. Merging into `main` runs the fork's Pages workflow. To
roll back an adopted migration, revert the integration merge with its first
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
corepack pnpm nx run gallery:verify-models
corepack pnpm exec playwright install chromium
corepack pnpm nx run gallery:verify-browser
```

Run installs sequentially. When checks run in parallel, set
`pnpm_config_verify_deps_before_run=error` to avoid concurrent implicit installs.
Nx Cloud remains disabled. Test output belongs under `out/reports/gallery` and
`out/test-results/gallery`.

On memory-constrained machines, set `PNPM_MAX_WORKERS=1` for installation. This
limits pnpm's package extraction workers separately from `--child-concurrency`,
which controls dependency build scripts. The gallery reuses the upstream lock's
existing dependency versions; the migration adds only its workspace importer.

The model verifier must parse exported geometry, distinguish triangles from
lines, apply node transforms, convert metres to millimetres, check finite bounds
and fail on unexpected model or parity errors. Inventory checks alone do not
prove the models work. Browser checks serve the built files from a plain static
server and exercise the real WASM workers, links and downloads.

## Workflows

`github-pages.yml` builds and deploys this gallery only for `ahzs645/tau` main.
`gallery-checks.yml` runs one bounded validation job on gallery-related PRs,
including the focused kernel compatibility suite and a static production browser
check. A manual dispatch can additionally run the full geometry and export
matrix with regression assertions, or omit the browser suite. Geometry artifacts
and verification reports are retained with the workflow run.
`upstream-drift.yml` fetches real upstream main and reports actual ahead/behind
counts; it does not confuse an affected-project check with an upstream sync.

The upstream workflow files remain in place. Their jobs are guarded with
`github.repository == 'taucad/tau'`, keeping release, staging, package publishing,
desktop runners and upstream schedules from executing in this fork. Every future
sync must retain those guards and cover newly added upstream jobs. This fork does
not need upstream deployment credentials.

## Future upstream updates

1. Fetch origin and upstream, create an integration branch from origin main and
   record both input SHAs. Check `git rev-list --left-right --count
origin/main...upstream/main`; do not guess the distance from calendar age.
2. Merge upstream main, keeping its core implementation and adapting this
   application through public APIs. Review any local kernel changes explicitly.
   Apply the fork workflow guards to new upstream jobs.
3. Update the lockfile once with the pinned package manager, then require a
   frozen install. Run the local gates above. Inspect the static output, desktop
   and mobile screenshots, model changes and exports.
4. Open a reviewed integration PR with pinned revisions and concrete results.
   Publish through the fork Pages workflow after the PR is approved and merged.

## Validation record

The integration is under active verification. The first review checkpoint has:

- A successful frozen install using the pinned pnpm, both for the gallery closure
  and for the complete workspace. Existing lockfile data is unchanged; only the
  gallery importer is added.
- 49 passing gallery unit/helper tests across 12 files, including native
  printability assertions and watchdogs that terminate synchronous work.
- Nine passing focused engine tests for authored schemas, dynamic SVG/STL
  dependencies and Boolean customizer choices.
- A successful production build with 20 public projects, real current and legacy
  route pages, seven emitted WASM files, and no unresolved runtime/worker asset
  placeholders. Independent worker bundles are serialized, and Rolldown's
  supported lazy-barrel optimization bounds unnecessary dependency compilation.
- A passing test TypeScript configuration and passing scoped native lint checks.
  Full application typechecking is still pending: the local compiler receives
  `SIGKILL` before diagnostics, including when run alone with explicit memory
  limits. No compiler coverage or strictness has been reduced.
- Real stamp and handle renders, with the handle's 20 × 50 × 23.094 mm canonical
  bounds matching the original STL. Both rack variants render and agree within
  the declared envelope tolerance.

The rack export checks currently fail: the SCAD STL path rejects a zero-area
canonical triangle, and the OpenCascade 3MF path rejects a non-manifold or
inconsistently oriented mesh. These are observed failures under the current
strict export path; an independent old-engine baseline has not established
whether their geometric cause was introduced by this integration.

Production browser checks are pending. The local runner cannot start Chromium
because its process socket is denied, and the connected browsers cannot reach
the workspace server. The focused PR job supplies a normal runner for the
browser and full application typecheck. The full model/export matrix must also
complete before this migration is marked ready to merge. A successful build or
unit suite does not substitute for those gates.
