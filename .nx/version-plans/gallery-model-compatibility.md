---
opencascade: patch
openrscad: patch
replicad: patch
---

Preserve authored model parameters and imported assets when opening existing
parametric projects through the current runtime.

OpenCascade and Replicad honour an exported `jsonSchema`, preserving authored
ranges, choices, descriptions and units. Models without a schema retain inferred
parameters, and invalid declarations return a structured failure.

OpenRSCAD mounts project assets selected by expression-based `import()` and
`surface()` paths and includes their bytes in dependency invalidation. Replacing
an uploaded SVG or STL therefore changes the next evaluation. Boolean customizer
dropdowns retain boolean values, labels and restrictions instead of emitting a
string schema around a boolean default.
