# @taucad/openscad

OpenSCAD CAD kernel for [`@taucad/runtime`](../../packages/runtime).

Wraps [`openscad-wasm-prebuilt`](https://www.npmjs.com/package/openscad-wasm-prebuilt) and exposes it as a `defineKernel` plugin so it can be loaded by the Tau runtime alongside (or instead of) any other kernel.

## License

This package is **GPL-2.0-or-later** because it bundles `openscad-wasm-prebuilt`. See [LICENSE](./LICENSE) for the full text and [`docs/research/license-strategy-mit-vs-gpl.md`](../../docs/research/license-strategy-mit-vs-gpl.md) for the licensing rationale.

The rest of `@taucad/*` (including `@taucad/runtime`) remains MIT-licensed. Distributions that do not include this package carry no GPL obligation.

## Installation

```bash
pnpm add @taucad/openscad @taucad/runtime
```

## Usage

```typescript
import { createRuntimeClient } from '@taucad/runtime';
import { replicad } from '@taucad/runtime/kernels';
import { openscad } from '@taucad/openscad';

const client = createRuntimeClient({
  kernels: [replicad(), openscad()],
});
```

The `openscad()` factory returns a standard `KernelPlugin` registration. The kernel module itself (loaded dynamically by the runtime worker) lives at `@taucad/openscad/kernel`.

## Font support

### `text()` requires a registered fontconfig directory

OpenSCAD's `text()` depends on fontconfig and FreeType. The kernel bundles Geist
`.ttf` faces and mounts them into the OpenSCAD Emscripten filesystem before invoking
`callMain()`.

The failure mode for an unregistered font directory is easy to miss: the rest of the
model renders fine, but text geometry is empty and the worker log shows:

```
WARNING: Can't get font  in file /main.scad, line N
```

A concrete example is the `3d-rack-scad` gallery project: with `enable_numbers = true`
the engraved hole numbers disappear when fontconfig cannot discover the mounted fonts.

The kernel avoids that by writing:

- `/fonts/Geist-Regular.ttf`
- `/fonts/Geist-Bold.ttf`
- `/fonts/fonts.conf`
- `/etc/fonts/fonts.conf`

and by setting `FONTCONFIG_FILE=/etc/fonts/fonts.conf` plus
`FONTCONFIG_PATH=/etc/fonts` on the Emscripten `Module.ENV` before `callMain()`.
The `fonts.conf` explicitly registers `<dir>/fonts</dir>` and prepends `Geist` as the
default family, so `text("12")` works even without a `font = ...` argument.

Note: OpenSCAD/FreeType requires `.ttf`/`.otf` fonts — `.woff2` will not work, and the
correct-format Geist faces are already bundled.
