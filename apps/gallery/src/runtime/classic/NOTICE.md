# Classic OpenSCAD gallery adapter

This directory preserves the gallery's original OpenSCAD execution path through Tau's current public kernel
and worker contracts. It is selected explicitly by catalogue metadata. An OpenRSCAD error never switches engines.

## Engine and source

The engine is the unchanged `openscad-wasm-prebuilt@1.2.0` npm package used by the original fork. Its package
metadata declares **GPL-2.0-or-later** and identifies the following source repository and publication commit:

- Source: <https://github.com/lorenzowritescode/openscad-wasm>
- Publication commit: `1ba53f14259ed72aeb256df1cba739de2517c8fb`
- Package: <https://www.npmjs.com/package/openscad-wasm-prebuilt/v/1.2.0>
- Package integrity:
  `sha512-JfXJlopHVHvsYiVYUKYDXkg8yOkABm8zclo8zPrSRBeeICR+fitesO6NRwBdAzSdbtOYh6Scmuz/XLyhllbzYA==`
- Embedded WASM SHA-256: `ca81ad3d2ed0490f217db335aa8106fb451ca627073502aabb686866bfed1a7b`

The Customizer compatibility code retains behavior from the fork's `kernels/openscad` adapter at
`996774cc25a147c085fbdcc47a4a89cc0dfe701f`. That directory carried the GNU General Public License, version 2;
its license text is retained here in [LICENSE](LICENSE). These notices do not change other files' licenses.

The npm package embeds its own WASM bytes. The adapter uses its public `createOpenSCAD`, `getInstance`, and
Emscripten filesystem/CLI APIs, creating a fresh instance for each operation. It does not modify the engine.

## Fonts

The original fork rendered `text()` with Geist Regular and Bold from `geist@1.7.1`. Both exact, unchanged TTF
files are retained in `fonts/` because the workspace's newer Geist package contains different bytes. Their
copyright and SIL Open Font License 1.1 are in [fonts/OFL.txt](fonts/OFL.txt).

| Original file                                         |  Bytes | SHA-256                                                            |
| ----------------------------------------------------- | -----: | ------------------------------------------------------------------ |
| `geist@1.7.1/dist/fonts/geist-sans/Geist-Regular.ttf` | 126048 | `8177983fd81e22d440b343d931c508aa87eeb7a43907223b648e4c66214a3999` |
| `geist@1.7.1/dist/fonts/geist-sans/Geist-Bold.ttf`    | 128824 | `45e6b30280949f1aa0208a4b05f47e1984719aba0b7fcc2bc993a15b9199f644` |

## Geometry and operation boundaries

Models, their binary assets, and explicitly selected BOSL2 files remain project inputs. Every input byte
participates in the source dependency closure. Saved presets may supply the explicitly validated `$fn`, `$fa`,
and `$fs` resolution overrides. Omitting these values preserves the model's own definitions and expressions;
explicit render tessellation retains its existing precedence. Other undeclared special parameters are rejected.
The engine runs its original Manifold backend. One native invocation produces paired OFF and ASCII STL outputs.
The OFF writer rounds coordinates to six significant digits; the ASCII STL retains native double precision.
The adapter verifies face/corner correspondence and shared original vertex identities before restoring those
coordinates, preserving every original indexed face and color. Inconsistent or ambiguous output is rejected.
The paired ASCII STL is cached with the exact rendered mesh and copied for export, without another evaluation.
Native STL retains Z-up millimetres; the preview and default GLB export convert once to Y-up metres. The public Assimp
transcoder provides strict 3MF, OBJ, and faceted STEP exports from that GLB. Faceted STEP retains the mesh
surface; it does not reconstruct analytic CAD surfaces. The original engine's native 3MF command is not
declared because the pinned binary traps even on a plain cube. The OFF
adapter preserves face colors and disconnected bodies, but OFF does not carry authored module names.

No geometry repair is applied. Colored closed bodies retain canonical topology from their original OFF
vertex indices only after closure, opposite winding, connected vertex links, and finite nonzero area at
serialized Float32 precision are checked. Color primitives share complete render attributes; no positions
are welded. Open, invalid, or precision-collapsed inputs receive no canonical topology claim. Overlay previews
retain their owner-local line primitives without canonical surface metadata. Native errors, missing required inputs,
nonzero exit codes, and absent output fail the operation. Warnings remain visible. Browser worker termination
and the Node verification parent enforce deadlines while synchronous native code runs; an AbortSignal alone
does not interrupt a synchronous WASM call.
