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
.js, .json, .scad, .svg, .txt
```

Use `mainFile` only for compatibility aliases. For example, TypeScript examples may store source as
`main.txt` to force raw loading, while exposing it to the runtime as `main.ts`.

### Pulling code from `@taucad/tau-examples`

If a project's code is also a canonical example in the shared `@taucad/tau-examples` library, do
**not** copy the source into this folder. Instead set `"libSource": "<example-folder-name>"` in
`project.json` and keep only `project.json` (+ optional `presets.json`) here. The loader resolves the
code from `replicadExampleCode` in the library, so there is a single source of truth: the library's
`main.ts` (type-checked, linted, and render-tested). The dependency only points one way — apps import
the library, never the reverse — so the library, not this folder, owns the code. Add new entries to
`libs/tau-examples/src/playground-sources.ts`. `pet-bottle-opener` uses this.

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
