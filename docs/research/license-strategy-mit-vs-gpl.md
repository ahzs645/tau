---
title: 'Licensing Strategy — MIT-First with GPL-Bundled OpenSCAD'
description: "Audit Tau's dual-license framing, the GPL-2.0 obligations from openscad-wasm-prebuilt, and recommend a simpler MIT-first presentation that still complies with copyleft requirements."
status: active
created: '2026-04-22'
updated: '2026-04-22'
category: comparison
related:
  - docs/research/netlify-ui-deployment-strategy.md
---

# Licensing Strategy — MIT-First with GPL-Bundled OpenSCAD

Audit of Tau's "dual-licensed (MIT / GPL-2.0-or-later)" framing in `readme.md`, `license`, `license-deps`, and `apps/ui/app/routes/legal.terms/terms-of-service.txt`. Goal: keep MIT front-and-centre for simplicity while staying compliant with the GPL-2.0-or-later obligations that ride along with the bundled OpenSCAD WASM kernel.

## Executive Summary

Tau's source code is, and can remain, **MIT-licensed**. The "dual-licensed" framing in the README, `license-deps`, and Terms of Service overstates Tau's own license posture and conflates two distinct things: (1) the license **we** grant on **our** source code (MIT), and (2) the **GPL-2.0-or-later obligations attached to the bundled `openscad-wasm-prebuilt` package** when the OpenSCAD kernel is part of a distribution. MIT and GPL-2.0-or-later are one-way compatible — MIT source can satisfy GPL combined-work requirements without changing its own license. We can drop the "dual-licensed" headline and replace it with a **single MIT statement plus a clearly-scoped GPL notice** for the OpenSCAD kernel bundle. This change requires zero code changes and zero refactor; only documentation and the license-deps generator script need updating. Three findings (F1–F3) and six recommendations (R1–R6) below.

## Table of Contents

- Problem Statement
- Methodology
- Findings
  - F1: OpenSCAD kernel is a separate, dynamically-loaded ESM module
  - F2: `openscad-wasm-prebuilt` is plain GPL-2.0-or-later (no linking exception)
  - F3: GPL viral reach is limited to the combined work that includes openscad-wasm
- Comparison: Current vs Proposed Framing
- Trade-offs
- Recommendations
- Appendix A: Doc-by-doc edit map
- Appendix B: Other copyleft dependencies
- References

## Problem Statement

The repository currently presents Tau as "dual-licensed (MIT / GPL-2.0-or-later)" across four user-facing surfaces:

| Surface                                                     | Where       | Current language                                                                          |
| ----------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `readme.md` § License                                       | repo home   | "Tau is dual-licensed: MIT … GPL-2.0-or-later when using the OpenSCAD kernel."            |
| `license-deps` § Licensing Overview                         | npm + repo  | "Tau is dual-licensed: MIT … GPL-2.0-or-later when using the OpenSCAD kernel."            |
| `scripts/src/update-license-deps.mts`                       | generator   | Hard-codes the same dual-license header into regenerated `license-deps`.                  |
| `apps/ui/app/routes/legal.terms/terms-of-service.txt` § 6.2 | tau.new ToS | "TauCAD is dual-licensed: MIT … GPL-2.0-or-later applies when using the OpenSCAD kernel." |

This framing is technically defensible but **rhetorically misleading**: it implies Tau's own copyright owners issue two licenses for the same work, which is not what is happening. What is actually happening is:

- TauCAD Limited grants the Tau source code under **MIT** (the only license on Tau-authored files).
- A bundled third-party dependency (`openscad-wasm-prebuilt` v1.2.0) is **GPL-2.0-or-later** and propagates obligations to any "combined work" that includes it.

The user's goal is to simplify the public-facing licensing message to **"Tau is MIT-licensed"** while still complying with `openscad-wasm-prebuilt`'s GPL obligations. This research determines whether that simplification is legally and architecturally viable.

## Methodology

1. **Codebase audit** — Read `packages/runtime/src/kernels/openscad/openscad.{kernel,plugin}.ts`, `kernel-runtime-worker.ts` (dynamic-import worker host), `packages/runtime/package.json` (npm exports), root `package.json`, `pnpm-workspace.yaml`, and the four documented surfaces (`readme.md`, `license`, `license-deps`, `terms-of-service.txt`).
2. **Linkage trace** — Followed how the OpenSCAD kernel is loaded by the runtime worker via `await import(/* @vite-ignore */ config.moduleUrl)`. Determined which Tau modules statically import `openscad-wasm-prebuilt` vs. which never touch it.
3. **License verification** — Confirmed `openscad-wasm-prebuilt` v1.2.0 is **GPL-2.0-or-later** with **no linking exception** (npm registry, jsDelivr metadata, upstream `openscad/openscad-wasm` LICENSE).
4. **Web research** — FSF GPL-2.0 FAQ (combined work vs mere aggregation), libgit2 WASM precedent (linking-exception case), `openscad-playground` LICENSE.md (the inspiration project's reasoning), opensource.stackexchange precedents.
5. **SPDX guidance** — npm `package.json` license-field documentation (`SPDX expression OR list third-party in separate file`).

## Findings

### F1: OpenSCAD kernel is a separate, dynamically-loaded ESM module

The OpenSCAD kernel is **architecturally isolated** from the rest of the runtime:

```16:23:packages/runtime/src/kernels/openscad/openscad.plugin.ts
export const openscad = createKernelPlugin({
  id: 'openscad',
  moduleUrl: new URL('openscad.kernel.js', import.meta.url).href,
  extensions: ['scad'],
  renderSchema: openscadRenderSchema,
  exportSchemas: openscadExportSchemas,
});
```

The runtime worker resolves and loads kernel modules **on demand** via dynamic `import()`:

```290:294:packages/runtime/src/framework/kernel-runtime-worker.ts
this.logger.debug(`Loading kernel module: ${config.id} from ${config.moduleUrl}`);
const module = (await import(/* @vite-ignore */ config.moduleUrl)) as {
  default: KernelDefinition;
};
```

`openscad-wasm-prebuilt` is statically imported **only inside `openscad.kernel.ts`**. No other kernel, no transcoder, no middleware, no UI module, and no API module imports it:

| File group                                                           | Imports `openscad-wasm-prebuilt`? |
| -------------------------------------------------------------------- | --------------------------------- |
| `packages/runtime/src/kernels/openscad/openscad.kernel.ts`           | Yes (static `import`)             |
| All other kernels (replicad, jscad, manifold, zoo, opencascade, tau) | No                                |
| `packages/runtime/src/framework/*` (worker, dispatcher)              | No                                |
| `apps/ui/**`, `apps/api/**`                                          | No                                |

`packages/runtime/package.json` exports each kernel as a **separate subpath**:

```44:51:packages/runtime/package.json
"./kernels/replicad": "./src/kernels/replicad/replicad.kernel.ts",
"./kernels/jscad":    "./src/kernels/jscad/jscad.kernel.ts",
"./kernels/manifold": "./src/kernels/manifold/manifold.kernel.ts",
"./kernels/openscad": "./src/kernels/openscad/openscad.kernel.ts",
"./kernels/opencascade": "./src/kernels/opencascade/opencascade.kernel.ts",
"./kernels/zoo":      "./src/kernels/zoo/zoo.kernel.ts",
"./kernels/tau":      "./src/kernels/tau/tau.kernel.ts",
```

A consumer of `@taucad/runtime` who never imports `@taucad/runtime/kernels/openscad` (e.g. a Replicad-only application) **never loads `openscad-wasm-prebuilt`** and never touches GPL code. Vite's bundling of dynamic `import()` produces a separate chunk for the OpenSCAD kernel, so the same separation holds in built distributions.

**Implication**: At the architectural level, Tau already supports a **mere-aggregation** posture for npm consumption — only the OpenSCAD kernel module + its WASM dependency form the GPL-licensed unit; the rest of `@taucad/runtime` is independent.

### F2: `openscad-wasm-prebuilt` is plain GPL-2.0-or-later (no linking exception)

Verified against three sources:

| Source                                                                                                    | License                                                                                        |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [npm registry](https://registry.npmjs.org/openscad-wasm-prebuilt)                                         | `GPL-2.0-or-later`                                                                             |
| [jsDelivr metadata](https://www.jsdelivr.com/package/npm/openscad-wasm-prebuilt)                          | `GPL-2.0-or-later`                                                                             |
| Upstream [`openscad/openscad-wasm`](https://github.com/openscad/openscad-wasm)                            | `GNU GPL v2.0`                                                                                 |
| OpenSCAD itself ([`openscad/openscad/COPYING`](https://github.com/openscad/openscad/blob/master/COPYING)) | GPL-2.0-or-later **with a CGAL-only linking exception** (does not extend to JS/WASM consumers) |

Comparison with closer-to-LGPL precedent: `wasm-git` / `libgit2` use **GPL-2.0 with an explicit linking exception** that grants "unlimited permission to link the compiled version of this library into combinations with other programs". `openscad-wasm-prebuilt` carries **no such exception**. The CGAL exception in upstream OpenSCAD applies only to linking with CGAL, not to general JS/WASM embedding.

**Implication**: Standard GPL-2.0-or-later combined-work obligations apply when `openscad-wasm-prebuilt` is shipped as part of a Tau distribution.

### F3: GPL viral reach is limited to the combined work that includes openscad-wasm

The FSF's GPL-2.0 FAQ position is that "[l]inking ABC statically or dynamically with other modules is making a combined work based on ABC. Thus, the terms and conditions of the GNU General Public License cover the whole combination." However, the same FAQ defines **"mere aggregation"** as the inverse: separate programs distributed together on the same medium do **not** form a combined work.

Combining F1 and F2 produces three **distinct distribution scenarios** with three **distinct GPL implications**:

| Distribution scenario                                                                  | Combined-work analysis                                                                                                                    | GPL obligation                                                                                                                                        |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. `@taucad/runtime` npm package (consumer chooses kernels at import time)             | Each kernel is a separate subpath export; OpenSCAD kernel only loads when consumer imports it. **Mere aggregation** at the package level. | Package-level: MIT. OpenSCAD-kernel subpath consumers pull `openscad-wasm-prebuilt` and incur GPL on the combined work they ship.                     |
| B. `tau.new` hosted SPA (Vite-bundled, OpenSCAD chunk lazy-loaded on kernel selection) | The combined chunk graph delivered to a user who selects OpenSCAD includes the OpenSCAD kernel + WASM. **Combined work**.                 | The combined deployment served when OpenSCAD is selected must satisfy GPL-2.0-or-later (source available, GPL text shipped, no further restrictions). |
| C. Self-hosted Tau install with OpenSCAD enabled                                       | Same combined-work analysis as B; user is the distributor.                                                                                | Same as B.                                                                                                                                            |

**Important clarification**: GPL-2.0-or-later compatibility with MIT is **one-way**. MIT-licensed code can be combined with GPL code, and the combination is distributable under GPL. This does **not** retroactively change the license of the MIT code itself — the original Tau source files remain MIT-licensed and can be re-extracted, re-used, and re-distributed under MIT terms by anyone. What is GPL is the **specific built combination** that includes `openscad-wasm-prebuilt`.

**Implication**: We can — and should — declare Tau's own source as **MIT-only**. The GPL obligation rides on the bundled OpenSCAD WASM, not on Tau's source.

## Comparison: Current vs Proposed Framing

| Aspect                                 | Current ("dual-licensed")                                                                                             | Proposed ("MIT, with GPL-bundled OpenSCAD")                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| What Tau (the copyright holder) grants | "Two licenses, take your pick"                                                                                        | "One license: MIT"                                                         |
| Where GPL appears                      | At the top, alongside MIT                                                                                             | In a scoped notice for the OpenSCAD kernel bundle                          |
| Reader's first impression              | "This project is half-GPL"                                                                                            | "This project is MIT; one optional kernel inherits a GPL dependency"       |
| Legal accuracy                         | Misstates the copyright holder's grant; correct on combined-work effect                                               | Accurate on both grant **and** combined-work effect                        |
| `package.json` `"license"` field       | Already `"MIT"` — inconsistent with "dual-licensed" framing                                                           | `"MIT"` — consistent                                                       |
| SPDX-validator friendliness            | Mixed (would push some validators toward `(MIT OR GPL-2.0-or-later)`, which means user can pick one — also incorrect) | Clean MIT; per-package GPL notices in `license-deps` are standard practice |
| Marketing simplicity                   | Buries the MIT message                                                                                                | "MIT-licensed, open-source CAD" as the headline                            |
| Compliance burden                      | Same                                                                                                                  | Same                                                                       |

## Trade-offs

| Option                                                                                 | Pros                                                                                                                                 | Cons                                                                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Status quo** — keep "dual-licensed"                                               | Conservative; flags GPL prominently                                                                                                  | Misstates Tau's own grant; buries MIT message; inconsistent with `package.json` `"license": "MIT"`; sounds intimidating to MIT-friendly users |
| **B. Recommended — MIT-first with scoped GPL notice**                                  | Accurate; simple headline ("MIT-licensed"); consistent with `package.json`; still discloses GPL obligation where it actually applies | Requires editing four surfaces and the generator script (~30 minutes of doc work)                                                             |
| **C. Extract OpenSCAD kernel into a separate npm package** (`@taucad/openscad-kernel`) | `@taucad/runtime` becomes 100% MIT with zero GPL transitive deps; the GPL surface is a clearly-named, separately-installable package | Requires a small package extraction (~half day); doesn't change the hosted `tau.new` calculus (the SPA still bundles the kernel by default)   |
| **D. Drop OpenSCAD entirely**                                                          | No GPL anywhere                                                                                                                      | Loses the most popular code-CAD ecosystem; not desirable                                                                                      |
| **E. Replace `openscad-wasm-prebuilt` with a permissive equivalent**                   | If feasible, removes GPL                                                                                                             | No permissive OpenSCAD WASM exists; OpenSCAD is fundamentally GPL                                                                             |

**Verdict**: Option B is the right immediate move. Option C is a sensible follow-up if and when the runtime is hardened for external consumption — it makes the MIT story unambiguous at the npm-package level and is the same packaging pattern OpenSCAD Playground and similar GPL-bundling apps follow when they want to keep an MIT/Apache "core" separate from a GPL "addon".

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                            | Priority | Effort | Impact |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | **Reframe `readme.md` § License** as "Tau is MIT-licensed. Optional bundled components carry additional copyleft obligations on the combined work — see [`license-deps`](license-deps)." Drop the "dual-licensed" headline and the GPL bullet at the top.                                                                         | P0       | Low    | High   |
| R2  | **Reframe `license-deps` § Licensing Overview** the same way. Replace "Tau is dual-licensed" with "Tau source: MIT. Bundled copyleft dependencies (and the obligations they impose on combined distributions) listed below." Update `scripts/src/update-license-deps.mts` so the generator emits the new wording on regeneration. | P0       | Low    | High   |
| R3  | **Update `apps/ui/app/routes/legal.terms/terms-of-service.txt` § 6.2** to match. Same MIT-first framing; preserve the scoped GPL notice for OpenSCAD bundling. Coordinate with legal/Terms-of-Service review process before publishing.                                                                                           | P1       | Low    | Medium |
| R4  | **Keep `license` file as MIT** (no change). It already correctly identifies Tau's own grant.                                                                                                                                                                                                                                      | P0       | None   | High   |
| R5  | **Keep all `package.json` `"license": "MIT"` declarations** (no change). They are SPDX-correct: the field declares **the package author's grant**, not the union of transitive-dependency licenses. Bundled GPL deps are surfaced via `license-deps`, which is the npm-ecosystem convention.                                      | P0       | None   | High   |
| R6  | **(Implemented)** Extracted `@taucad/openscad` into a separately-published package under `kernels/openscad/` with its own `"license": "GPL-2.0-or-later"` declaration. `@taucad/runtime` is now pure MIT with no GPL transitive deps; consumers opt into GPL by installing `@taucad/openscad` explicitly.                         | P2       | Medium | Medium |

## Appendix A: Doc-by-doc edit map

For each surface, the recommended replacement text:

### `readme.md` § License (replace lines 93–102)

```markdown
## License

Tau is **[MIT-licensed](license)**. The Tau source code is, and remains, MIT.

One optional bundled component — the OpenSCAD kernel — pulls in
[`openscad-wasm-prebuilt`](https://www.npmjs.com/package/openscad-wasm-prebuilt),
which is **GPL-2.0-or-later**. When you build, install, or deploy a Tau
distribution that includes the OpenSCAD kernel, the resulting **combined
distribution** must satisfy the GPL-2.0-or-later terms (notably, source
availability — already satisfied by this public repository — and shipping the
GPL license text alongside the OpenSCAD WASM).

If you build, install, or deploy a Tau distribution **without** the OpenSCAD
kernel (for example, only Replicad, JSCAD, Manifold, OpenCascade, or Zoo),
no GPL obligation attaches to your distribution.

Full third-party license inventory: [`license-deps`](license-deps).
```

### `license-deps` § Licensing Overview (replace lines 5–18)

```markdown
## Licensing Overview

Tau source is **[MIT-licensed](./license)**. The MIT license applies to all
files authored by the Tau project.

Some third-party dependencies impose additional obligations on **combined
distributions** that include them:

- **`openscad-wasm-prebuilt` (GPL-2.0-or-later)** — Bundled by the OpenSCAD
  kernel module (`@taucad/runtime/kernels/openscad`). A distribution that
  includes the OpenSCAD kernel is a GPL-2.0-or-later combined work; source
  must be available (it is, at https://github.com/taucad/tau) and the GPL
  license text must accompany the OpenSCAD WASM.
- **LGPL-2.1 / LGPL-3.0 libraries** (see sections below) — Library-style
  copyleft; satisfied by attribution and source availability.

Distributions that exclude the OpenSCAD kernel carry no GPL obligation.

By using Tau, you agree to comply with the license terms of all included
dependencies. The full inventory follows.
```

### `scripts/src/update-license-deps.mts` (replace lines 317–328)

Update the hard-coded header in `generateMarkdown` to emit the new wording, so future regenerations stay in sync.

### `apps/ui/app/routes/legal.terms/terms-of-service.txt` § 6.2 (replace lines 103–108)

```markdown
TauCAD source is **MIT-licensed**. The MIT license governs all source code
authored by TauCAD Limited and contributors.

The OpenSCAD kernel bundles `openscad-wasm-prebuilt`, which is licensed
under GPL-2.0-or-later. A distribution that includes the OpenSCAD kernel is
a GPL-2.0-or-later combined work. This does not change the MIT license on
TauCAD's own source code.

Nothing in these Terms restricts your rights under the applicable open-source
licenses.
```

## Appendix B: Other copyleft dependencies

For completeness — these do **not** trigger viral GPL behavior but should be acknowledged:

| Package                                                        | License           | Reach                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@taucad/opencascade.js` (fork of `donalffons/opencascade.js`) | LGPL-2.1-only     | LGPL is library-copyleft. Linking does **not** infect the consumer; obligation is to (a) preserve attribution, (b) make the LGPL'd component source available, and (c) allow users to substitute their own build. All satisfied by current setup.                                              |
| `@zenfs/core`, `@zenfs/dom`                                    | LGPL-3.0-or-later | Same library-copyleft model as LGPL-2.1. Obligations satisfied by attribution + source availability. **Note**: AGENTS.md says "ZenFS dependency removed"; the package.json entries at root are stale and should be removed in a separate cleanup PR — not part of this license-framing change. |

Neither of these requires Tau's own source to be relicensed.

## References

- [GPL v2.0 FAQ — Free Software Foundation](https://www.gnu.org/licenses/old-licenses/gpl-2.0-faq.en.html) (combined-work definition, mere-aggregation clause)
- [`openscad-wasm-prebuilt` on npm](https://www.npmjs.com/package/openscad-wasm-prebuilt) — confirms GPL-2.0-or-later, no linking exception
- [Upstream `openscad/openscad-wasm` on GitHub](https://github.com/openscad/openscad-wasm) — confirms GPL-2.0
- [Upstream `openscad/openscad/COPYING`](https://github.com/openscad/openscad/blob/master/COPYING) — confirms GPL-2.0-or-later with CGAL-only linking exception
- [`openscad/openscad-playground/LICENSE.md`](https://github.com/openscad/openscad-playground/blob/main/LICENSE.md) — precedent for an entire app being GPL because OpenSCAD is bundled (Playground has no MIT "core" to separate; Tau does)
- [npm `package.json` license-field documentation](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#license) — SPDX guidance: declare your own grant, surface third-party in a separate file
- [opensource.stackexchange — GPL v2 cloud-app distribution](https://opensource.stackexchange.com/questions/9765/gpl-v2-what-does-distribution-mean-in-terms-of-cloud-apps) — analogous wasm-git case (with linking exception); contrasts with `openscad-wasm-prebuilt`'s lack of an exception
- [opensource.stackexchange — GPL component without disclosing site sources](https://opensource.stackexchange.com/questions/6132/can-i-use-a-gpl-component-in-my-site-without-having-to-disclose-the-sources-of-m) — distribution test for browser-delivered GPL JS/WASM
