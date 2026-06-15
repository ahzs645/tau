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

## Known issues

### `text()` renders nothing — no fonts are resolved

**Symptom.** Any model that uses OpenSCAD's `text()` produces no text geometry. The
rest of the model renders fine, the render reports `ready`, and the worker log shows:

```
WARNING: Can't get font  in file /main.scad, line N
```

A concrete example is the `3d-rack-scad` gallery project: with `enable_numbers = true`
the engraved hole numbers (and any other `text()` output) silently disappear.

**Root cause.** `mountFonts()` in [`src/openscad.kernel.ts`](./src/openscad.kernel.ts)
writes the bundled Geist `.ttf` files and a `fonts.conf` into the Emscripten FS at
`/fonts`, but `openscad-wasm-prebuilt@1.2.0` never discovers them:

- The shipped `fonts.conf` is empty (`<fontconfig></fontconfig>`) — it does not register
  `<dir>/fonts</dir>`, so even if fontconfig read it, no font directory would be scanned.
- More fundamentally, the prebuilt wasm does not honor a **runtime** font config. Its
  fontconfig default config path is baked into the wasm binary, and Emscripten freezes
  the process environment at libc init — _before_ the kernel runs — so the config can't
  be redirected after the instance is created.

**What was tried (and did _not_ work)** — recorded so it isn't repeated:

- Adding `<dir>/fonts</dir>` + a default-family alias to `fonts.conf`.
- Writing the config to both `/fonts/fonts.conf` and `/etc/fonts/fonts.conf`.
- Setting `FONTCONFIG_FILE` / `FONTCONFIG_PATH` on `Module.ENV` before `callMain`
  (verified via debug logging that `ENV` was applied and the `.ttf`s were mounted).

All combinations still produced `Can't get font`, confirming the env/config is read
before the kernel can influence it.

**Recommended fix (build-level).** One of:

1. Rebuild / swap to an `openscad-wasm` that bakes the fonts (and a prebuilt fontconfig
   cache) into the image, so `text()` resolves without runtime configuration.
2. Ship a prebuilt fontconfig cache directory alongside the registered `/fonts` dir.
3. Patch the package init to accept a `preRun`/`ENV` hook that sets `FONTCONFIG_FILE`
   _before_ the wasm runtime initializes (the current `InitOptions` only exposes
   `noInitialRun`/`print`/`printErr`).

Note: OpenSCAD/FreeType requires `.ttf`/`.otf` fonts — `.woff2` will not work, and the
correct-format Geist faces are already bundled.
