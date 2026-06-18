# AGENTS.md

## Root Playground Project Intake

This directory is the source of truth for root playground and gallery projects. Do not maintain a
manual project registry when adding examples.

## How Discovery Works

- `../projects.ts` uses Vite eager `import.meta.glob` to discover `*/project.json`.
- Each discovered folder becomes one playground example unless its metadata has `"hidden": true`.
- The folder name is the stable model id used by `/?model=<project-id>`.
- Do not add or regenerate `index.json` or `manifest.json`; they are obsolete for this app.
- Do not edit `projects.ts` just to add another project. Only edit it when changing the loader
  contract itself.

## Add A Project

Create a kebab-case folder:

```text
apps/ui/app/routes/_index/projects/<project-id>/
  project.json
  main.scad
```

Minimum `project.json`:

```json
{
  "title": "Project Name",
  "entry": "main.scad",
  "description": "Short gallery and playground description."
}
```

Optional fields include:

```json
{
  "mainFile": "main.ts",
  "libSource": "pet-bottle-opener",
  "kernel": "OpenSCAD",
  "engine": "openscad",
  "language": "scad",
  "exportFormats": ["glb", "stl", "3mf", "obj"],
  "initialParameters": {},
  "presets": [{ "name": "Preset name", "parameters": {} }],
  "hidden": false
}
```

Accepted `kernel` values are `OpenSCAD`, `Replicad`, and `OpenCascade`. Imported OpenSCAD Playground
metadata may use `engine`: `openscad`, `replicad`, `opencascade`, or `occt`.

## Source Files

The loader imports raw text source files with these extensions:

```text
.js, .ts, .json, .scad, .svg, .txt
```

TypeScript projects store their source directly as `main.ts` (no `.txt` alias needed) — the loader
raw-imports it and the runtime executes it. These project sources are **excluded from the app's
linter** (`.oxlintrc.json` + `eslint.config.mjs` ignore `routes/playground/projects/*/**`) because
they are illustrative kernel example assets, not app code; they are still type-checked by the app
`tsconfig`. Use `mainFile` only for compatibility aliases (e.g. exposing a differently-named entry to
the runtime).

### Pulling code from `@taucad/tau-examples`

A project may optionally pull its code from the shared `@taucad/tau-examples` library by setting
`"libSource": "<example-folder-name>"` in `project.json` (keeping only `project.json` + optional
`presets.json` here); the loader then resolves the code from `replicadExampleCode` in the library.
The dependency only points one way — apps import the library, never the reverse.

As of now **no project uses `libSource`** and `replicadExampleCode` is empty: every project owns its
own source under `projects/<id>/` (this folder is the single home for project code). `pet-bottle-opener`
was migrated here as a local `main.ts`. The `libSource` mechanism remains available should a future
project want to reuse a library-owned example verbatim.

Binary files (`.stl`, `.glb`, `.usdz`, etc.) are not loaded into the editor by this path. If a
project needs binary runtime assets, design that asset path explicitly before adding the project.

## Hidden Projects

`"hidden": true` means the project is kept in the tree but not exported to the root playground or
gallery. Use it for incomplete source. Do not rely on empty folders as placeholders; Git does not
track them and the loader ignores them.

## Verification

After changing this directory or `../projects.ts`, run:

```bash
pnpm nx test ui --watch=false app/routes/_index/projects.test.ts
pnpm nx lint ui --files=app/routes/_index/projects.ts
pnpm nx lint ui --files=app/routes/_index/projects.test.ts
pnpm nx typecheck ui
```

Full details live in `docs/architecture/root-playground-projects.md`.
