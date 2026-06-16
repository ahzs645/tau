# Root Playground Project Uptake

## Status

**Reference** -- documents how the root playground and gallery discover project examples from
`apps/ui/app/routes/_index/projects/`.

---

## Purpose

Root playground projects are build-time assets. Adding a new project should not require editing a
central TypeScript registry. The source of truth is the project folder itself.

## Folder Contract

Each public project lives in its own directory:

```text
apps/ui/app/routes/_index/projects/<project-id>/
  project.json
  main.scad
  optional-extra-file.txt
```

`<project-id>` becomes the stable URL id used by `/?model=<project-id>`. Use kebab-case and do not
rename an existing project folder unless you are intentionally breaking existing links.

## `project.json`

Required fields:

```json
{
  "title": "Project Name",
  "entry": "main.scad",
  "description": "Short gallery and playground description."
}
```

Supported optional fields:

```json
{
  "mainFile": "main.ts",
  "kernel": "OpenSCAD",
  "engine": "openscad",
  "language": "scad",
  "exportFormats": ["glb", "stl", "3mf", "obj"],
  "initialParameters": {},
  "presets": [{ "name": "Preset name", "parameters": {} }],
  "hidden": false
}
```

Use `kernel` for the displayed and executed kernel when it is not OpenSCAD. Accepted values are
`OpenSCAD`, `Replicad`, and `OpenCascade`. `engine` is accepted for imported OpenSCAD Playground
metadata and maps `replicad`, `opencascade`, or `occt` to the corresponding kernel.

`mainFile` is only for compatibility aliases. For example, `pet-bottle-opener` stores TypeScript as
`main.txt` so Vite treats it as raw text, then exposes it to the runtime as `main.ts`.

## Source Files

The loader includes raw text files under the project folder with these extensions:

```text
.js, .json, .scad, .svg, .txt
```

Binary assets such as `.stl` and `.glb` are not loaded into the code editor by this path. If a
project needs binary runtime assets, add an explicit runtime asset plan before adding the project.

## Hidden Projects

`"hidden": true` means the project is not exported from the root playground project list. It will not
appear in the gallery or the root playground selector. Use this for incomplete local source that
should stay in the tree but not ship as a selectable example.

## Generated Manifests

Do not maintain `projects.ts`, `index.json`, or `manifest.json` registries for this directory. Vite's
eager `import.meta.glob` inventory in `projects.ts` is the registry.

## Empty Folders

Empty folders are not valid project inputs. They are not tracked by Git and should be removed rather
than treated as project placeholders.

## Code Editor Toggle

The root playground Code button is controlled by the `disableCodeEditor` feature flag. Set
`TAU_DISABLE_CODE_EDITOR=1` or `TAU_DISABLE_CODE_EDITOR=true` for kiosk or viewer-only deployments.
The default remains editable for local development and normal playground use.
