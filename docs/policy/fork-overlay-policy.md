---
title: 'Fork Overlay Policy'
description: 'How this fork of taucad/tau stays rebasable: which paths are the fork overlay, which are upstream core, and what has to happen before a core file is edited.'
status: draft
created: '2026-07-24'
updated: '2026-07-24'
related:
  - docs/policy/commit-policy.md
  - docs/architecture/root-playground-projects.md
  - docs/research/replicad-vs-raw-occt-ports.md
---

# Fork Overlay Policy

This repository is a fork of `taucad/tau` that adds a playground gallery of parametric projects.
Its history begins with a squashed import of the upstream tree (3,724 files), so every commit since
is fork work layered on an upstream base that keeps moving.

That only stays workable if the fork's own code is separable from upstream's. This policy defines
the split and what it costs to cross it.

## Rationale

Fork changes fall into two kinds, and they have opposite economics.

**Overlay changes** — the gallery, its projects, its preview surface — are ours. Upstream will never
touch most of these files, so they rebase cleanly forever and there is nothing to coordinate.

**Core changes** — edits inside `packages/`, `kernels/`, `libs/`, `tools/` — sit on files upstream
is actively changing. Every one of them is a conflict waiting for the next sync, and a fix that
stays local is a fix we re-apply by hand every time. Most of the core edits this fork has made are
not fork-specific at all: BRep edge detection, the geometry cache middleware, OpenCascade kernel
work, converter fixtures. Those belong upstream, where they get maintained by more people than us.

The rule is therefore not "never touch core". It is: touching core is a decision with a follow-up,
and the follow-up is an upstream PR.

## Rules

### 1. Overlay paths — edit freely

- `apps/ui/app/routes/playground/**` — the gallery route, its preview surface, and every project.
- `docs/research/**`, `docs/policy/**` — our own investigations and policies.
- `.github/workflows/**` — this fork's CI and Pages deployment.
- Fork-only config: `repos.yaml`, the Pages build settings in `apps/ui`.

No ceremony. These are the fork's reason to exist.

### 2. Core paths — edit only under one of three headings

`packages/**`, `kernels/**`, `libs/**`, `tools/**`, and the shared `apps/ui` surface outside the
playground route are upstream's. Before editing, decide which of these the change is:

1. **Upstreamable fix or feature** — generic, useful to anyone running Tau. Land it here to unblock
   yourself, then open the upstream PR and record the link in the commit body. Examples from this
   fork's history: the `@taucad/openscad/parameters` subpath export, BRep edge detection, the
   geometry-cache middleware, native-edge GLTF export.
2. **Fork-specific deviation** — genuinely only makes sense for this deployment (Pages build target,
   gallery-specific defaults). Keep the diff as small as possible and add a `FORK:` comment naming
   the reason, so the next rebase can tell deviation from drift.
3. **Neither** — then it is overlay work in the wrong place. Move it into the overlay.

### 3. Prefer extension points to edits

If the overlay needs something core does not expose, add the _smallest_ general extension point and
use it from the overlay — a new export, an option, a plugin hook. A subpath export that upstream
would also accept is worth more than a local patch, because it survives the next sync and can be
contributed back. `@taucad/openscad/parameters` is the shape to copy: the parser was already pure;
only the package's `exports` map needed a line.

### 4. Keep the upstream remote configured

```bash
git remote add upstream https://github.com/taucad/tau.git   # once
git fetch upstream
git log --oneline HEAD..upstream/main -- packages kernels libs   # what moved under us
```

Sync on a schedule rather than on demand: a fork that syncs monthly resolves a handful of conflicts
each time, and a fork that syncs yearly resolves all of them at once, under pressure.

### 5. Every sync ends with the parity harness

After a sync, run the variant renderer before trusting the gallery:

```bash
pnpm nx run-many -t copy-assets
cd packages/testing && npx tsx scripts/render-variants.ts
```

It renders every declared variant of every project and reports bounding box, triangle count and
time, so a kernel change upstream that silently moves geometry shows up as a parity delta rather
than as a wrong-looking model in production.

## Current core deltas to upstream

Taken from this fork's commits against core paths. Each is a candidate PR, not a permanent local
patch:

| Area               | Files                                                                                      | Why it is upstreamable                                        |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| OpenCascade kernel | `packages/runtime/src/kernels/opencascade/**`                                              | Kernel fixes and export-format coverage, not gallery-specific |
| Edge detection     | `packages/runtime/src/{utils/edge-detection,middleware/gltf-edge-detection.middleware}.ts` | Native BRep edges in GLTF benefits every consumer             |
| Geometry cache     | `packages/runtime/src/middleware/geometry-cache.middleware.ts`                             | Transfer-tier buffer fix is a correctness fix                 |
| OpenSCAD kernel    | `kernels/openscad/**`                                                                      | BOSL2 bundling and the `parameters` subpath export            |
| Converter fixtures | `packages/converter/src/fixtures/**`                                                       | Format coverage improvements                                  |

## Known upstream-facing defects found in this fork

These were reproduced here and should travel upstream with a repro rather than being worked around
locally forever:

- **A second OpenCascade kernel client in one process fails.** Reproduce by creating two
  `createRuntimeClient({ kernels: [opencascade()] })` clients sequentially: the second export fails
  with `Expected null or instance of TopoDS_Shape, got an instance of TopoDS_Shape`.
- **Kernel selection sticks to the first file in a client.** In one client holding both kernels,
  exporting a `.scad` file and then a `.ts` file feeds the TypeScript to OpenSCAD (`syntax error`).
- **Kernels disagree on glTF axis convention.** `opencascade` honours `coordinateSystem` and emits
  Z-up by default; `replicad` (and `jscad`) always apply the Z-up→Y-up vertex transform, so
  `coordinateSystem: 'z-up'` is ignored and `'y-up'` rotates twice.
- **Two option-spec customizer parameters separated by a group header break OpenSCAD rendering.**
  Minimal repro:

  ```scad
  RoundedBottom = "EW"; // [N:None, EW:East-West, NS:North-South]
  /* [Walls] */
  NorthWallOpen = 0; // [0:Closed, 1:Open]
  cube(1);
  ```

  This is why `projects/periodic-table` and `projects/keyguard-with-raised-tabs` do not render.

## Enforcement

`scripts/src/check-overlay-boundary.mts` reports which files in a diff touch core paths. It is
advisory by design — it prints the list and the three headings above, and does not fail the build.
The point is that core edits are _noticed_ at review time, not that they are forbidden.
