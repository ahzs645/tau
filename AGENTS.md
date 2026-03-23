# AGENTS.md

## Commands

```bash
pnpm nx lint <project>                    # Lint (oxlint then eslint)
pnpm nx lint <project> --files=<path>     # Lint specific file(s) or glob
pnpm nx test <project> --watch=false      # Test
pnpm nx typecheck <project>              # Typecheck
pnpm nx build <project>                  # Build

pnpm infra:up / infra:down / infra:reset  # PostgreSQL + Redis (Docker)
pnpm db:generate                          # Generate Drizzle migrations
pnpm db:migrate                           # Run migrations
pnpm ci:affected                          # CI: affected tests, builds, lint, typecheck
pnpm docs:validate                        # Validate policy/research doc frontmatter
```

## Architecture

Tau is the AI-native CAD platform for the web (`tau.new`), built as an Nx monorepo with pnpm workspaces.

- **Frontend**: React Router v7, React 19, TypeScript, Tailwind CSS, Fumadocs
- **Backend**: NestJS API with Fastify, PostgreSQL (Drizzle ORM), Redis, Better Auth
- **CAD Engine**: Multi-kernel runtime (Replicad, JSCAD, Manifold, OpenSCAD, KCL)
- **AI**: LangGraph agent with tool-use (OpenAI, Anthropic, Vertex AI, Ollama, Together AI, Cerebras, SambaNova)

### Project Map

| Path                    | Description                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `apps/ui`               | React Router v7 web app (CAD editor, file manager, AI chat, docs)                    |
| `apps/api`              | NestJS API (auth, database, chat WebSocket, LangGraph agent)                         |
| `packages/runtime`      | Multi-kernel CAD runtime — consumed as source via package.json exports               |
| `packages/react`        | React hooks for `@taucad/runtime` (useRender, useGeometryExport)                     |
| `packages/converter`    | CAD file conversion (STL, STEP, IGES, DXF, glTF, USDZ)                               |
| `packages/testing`      | Geometry analysis, grading, and test utilities (`analyzeGlb`, `evaluateRequirement`) |
| `packages/telemetry`    | OTEL metric definitions, ingest schemas, observability runtime middleware            |
| `packages/json-schema`  | JSON to JSON Schema inference                                                        |
| `libs/chat`             | AI chat tool schemas, message schemas, RPC definitions                               |
| `libs/types`            | Shared TypeScript types (API, project, CAD, file, graphics)                          |
| `libs/utils`            | Shared utilities (ID generation, path, file, schema, dispose)                        |
| `libs/units`            | Units of measurement and conversions                                                 |
| `apps/ui/content/docs/` | Docs site (Fumadocs): `(runtime)/` and `(editor)/` sections                          |

## Skills

Project skills in `.cursor/skills/` provide guided workflows. Read the relevant `SKILL.md` when performing these tasks:

| Skill                   | When to use                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `create-policy`         | Writing or updating `docs/policy/*.md` documents                                           |
| `create-research`       | Writing or updating `docs/research/*.md` investigation documents                           |
| `adding-tools`          | Adding new tools to the AI chat system                                                     |
| `create-package`        | Scaffolding new `@taucad/*` packages via workspace generator                               |
| `create-vite-plugin`    | Adding a Vite plugin to `@taucad/vite`                                                     |
| `new-kernel`            | Adding a first-party CAD kernel to `@taucad/runtime`                                       |
| `package-release`       | Versioning, building, publishing `@taucad/*` packages                                      |
| `repos`                 | Investigating dependency source code; cloning, adding, or exploring repos via `repos.yaml` |
| `submit-pr`             | Submitting draft PRs to upstream dependency forks                                          |
| `pr-review-coordinator` | Fixing PR review comments from GitHub                                                      |
| `typescript-overloads`  | Resolving TS2322 overloaded function type errors                                           |
| `langgraph`             | Questions about LangGraph and agentic AI                                                   |
| `occt-wasm-build`       | Building OpenCASCADE WASM binaries                                                         |

## Conventions

- Early returns to reduce nesting
- Composition over inheritance; functional programming patterns preferred
- Const declarations over function declarations
- `cn()`/`clsx` for conditional classNames, not ternary
- Max 3 parameters per function; bundle extras into an options object
- Vitest for tests; jsdom env for UI, node env for API
- Hybrid oxlint + ESLint linting; formatting via oxfmt (`.oxfmtrc.json`), not ESLint
- PostgreSQL with Drizzle ORM; schema in `apps/api/app/database/`; auth tables via Better Auth
- Investigate dependency source via `repos/` (managed by `repos.yaml` and `pnpm repos`), not `node_modules`. Use the `repos` skill to clone, add, or explore repos.

## Learned User Preferences

- Write failing tests first (TDD), then fix to pass; preserve existing tests; make minimal, targeted changes and run typecheck before considering done
- State machines own lifecycle and state logic; UI clients send events only and never decide open/close; avoid ref/state for sync guards
- Follow policy docs when applicable: testing-policy, library-api-policy, xstate-policy, lint-policy, react-testing-policy, filesystem-policy, commit-policy, typescript-policy, agents-md-policy, context-engineering-policy, jsdoc-policy, documentation-policy
- Pin GitHub/dependency versions to exact commit hashes for reproducibility and immutability
- When behavior regressed from something that previously worked, prefer config changes over code changes — find the regression
- Use `pnpm patch` tool for dependency patches; do not manually create patch files
- Use `react-virtuoso` for virtualization, not `@tanstack/react-virtual`; follow patterns in `combobox-responsive.tsx`
- Never blow away the entire IndexedDB database — user work is stored there
- Prefer algorithmic, code-level solutions over bundler config or Vite plugins; optimize for 3rd-party consumer DX
- Avoid type assertion escape hatches (`as never`, `as unknown as`, unnecessary `as const` on returns); fix underlying type issues instead
- When asked to explore or investigate, present findings and analysis first; do not jump to code changes until implementation is explicitly requested; dig for the concrete root cause (the smoking gun) — targeted fixes only, not broad investigation plans; validate hypotheses directly in source code (e.g., read emscripten/embind internals), no assumptions allowed; assess whether issues stem from incorrect implementation or broken architecture before fixing; never band-aid — fix at source rather than post-processing; verify changes actually work (visually for UI, at runtime for logic) before claiming success; prefer the most correct architectural fix over the simplest — correctness is not negotiable; adversarially review proposed approaches before committing to implementation; question manual additions when automated code generation should handle it
- When extracting domain logic into standalone packages, invert dependencies — the domain package owns its types/schemas, consumer packages depend on it (not the reverse); derive computed values from canonical sources rather than duplicating data across schemas
- JSDoc codeblocks use explicit language tags (`typescript`/`javascript`, not `ts`/`js`); `@public` tag gates compile-checking; `@example` tags require `<caption>` per JSDoc spec (non-empty, no redundant "example" word); examples must reflect actual consumer usage patterns, not synthetic isolated calls; public JSDoc required for `libs/` and `packages/` only — apps are exempt

## Learned Workspace Facts

- Policy docs live in `docs/policy/` (testing, library-api, vision, lint, xstate, typescript, filesystem, react-testing, commit, agents-md, context-engineering, jsdoc, diagram, ui, accessibility, and more); research docs in `docs/research/` (including `rpc-best-practices.md`, `observability-architecture.md`, `grafana-observability-gaps.md`, `occt-js-v8-dx-modernization.md`, `emscripten-idiomatic-js.md`, `occt-wasm-build-comparison.md`, `replicad-occt-v8-opportunities.md`, `observability-metrics-audit.md`, `observability-implementation-status.md`, `embind-smart-pointer-stale-ptr.md`, `embind-return-strategy-benchmarks.md`, `wasm-smart-pointer-landscape.md`, `occt-v8-migration.md`); architecture docs in `docs/architecture/` (e.g., `runtime-topology.md`) serve as binding contracts for implementation
- Hybrid oxlint + ESLint linting: oxlint runs first, ESLint handles residual rules; custom Oxlint JS plugins in `libs/oxlint/`; tsgolint (typescript-go) provides type-aware JSDoc codeblock checking via `source_overrides`; rule tests use `oxlint-disable` syntax (ESLint 9 RuleTester strips `eslint-disable` from `getAllComments()`); MDX parser exported separately at `@taucad/oxlint/mdx-parser` (not a property of the ESLint plugin object); `validate-mdx-links` checks internal dead links (relative + absolute, including Fumadocs route groups); `validate-mdx-external-links` checks remote URLs via subprocess with disk cache at `node_modules/.cache/tau-lint/external-links.json`
- External repos in `repos/` managed via `repos.yaml` and `pnpm repos`; gitignored and cursorignored; add to `.oxlintrc.json` ignorePatterns; `repos/opencascade.js` is a fork (`taucad/opencascade.js` from `donalffons/opencascade.js`); `repos/emscripten` is a shallow reference clone (not a fork — no `fork:` field in `repos.yaml`); `repos/assimpjs/emsdk` is the shared Emscripten SDK installation for all WASM builds (do not install emsdk elsewhere); `repos/opencascade.js` WASM build uses `BUILTIN_ADDITIONAL_BIND_CODE` (Python layer), full builds (10-30+ min) use `nohup`; `bindings.py` has `_classify_js_type`/`_build_dispatch_tree`/`_codegen_dispatch_tree` for val-based constructor/method overload dispatch, `processEnum` uses `enum_value_type::string` (string enums); `bindings.py` `needsWrapper` only wraps builtInTypes/enums/C-string `T&` via `getReferenceValue`/`updateReferenceValue` + `emscripten::val` (`{current: value}` pattern); `Handle<T>&` output params use unified return-by-value via `emscripten::value_object` (returns properties as JS object instead of mutating `{current}` refs); OCCT convention: `const handle<T>&` = input, non-const `handle<T>&` = output (never bidirectional); `const` on method guarantees `T&` params are output-only; suffix-free symbol generation removes `_N` overload subclasses; build system uses `build-cache.py` keyed on `OCJS_EXCEPTIONS`/`OCJS_SIMD` + other env vars; when build flags change, PCH must be rebuilt (`./build-wasm.sh pch`) and stale cache entries cleared from `repos/opencascade.js/cache/`; `OCJS_EXCEPTIONS=1` enables `-fwasm-exceptions` (Node.js supports `WebAssembly.Exception` — the real constraint is all `.o` files AND the linker must consistently use `-fwasm-exceptions`, otherwise `__cpp_exception` becomes an unresolved import); `OCJS_SIMD=1` enables `-msimd128 -mrelaxed-simd`; `OCJS_BIGINT=1` enables `-sWASM_BIGINT=1`; `OCJS_EVAL_CTORS_LEVEL` controls `-sEVAL_CTORS=N`; `build-flags.json` manifest validates compile-time flag consistency across cached stages; `build-manifest.json` stores symbol validation results (compiled count, missing symbols, WASM/JS sizes); WASM experiments defined in `scripts/experiments/*.yml`, orchestrated by `scripts/wasm-experiment.sh`, artifacts stored in `tarballs/experiments/` with `provenance.json` metadata; benchmark CLI `--wasm-variant single-exceptions` maps to `replicad_with_exceptions.*`, `--wasm-variant single` maps to `replicad_single.*`; both root `package.json` and `packages/runtime/package.json` must reference consistent replicad/replicad-opencascadejs tarballs — version mismatch causes `UMin` runtime errors; NX `build` target depends on `validate` (runs `validate-build.py` → `<variant>.build-manifest.json`) and `provenance` (runs `provenance.py init` + `finalize` → `<variant>.provenance.json`); use `pnpm nx build ocjs` to get both artifacts in one pass (separate `validate`/`provenance` invocations cause NX `link` cache to restore `dist/`, wiping prior step's output); `repos/vscode` used as architectural reference for FS events, IPC, caching, and binary transfer patterns
- UI deployed to Netlify (`apps/ui/netlify.toml`); `netlify.toml` env vars are build-time only — not available in SSR functions, so derive runtime values in `environment.config.ts` preprocess; `NX_PREFER_NODE_STRIP_TYPES=true` must be inlined in build commands (Nx evaluates at module load, before `.env` files)
- `packages/runtime` is consumed as source via package.json exports, not built output; test mocks in `packages/runtime/src/testing/kernel-testing.utils.ts`; `createRuntimeClientOptions` merges options via `deepmerge` — plugin arrays match by `id` and replace, non-array fields are deeply merged; Vite plugins in `@taucad/vite` with `*.vite-plugin.ts` suffix, `vite:` prefix, Vite 8 hook filters; gitignored `src/**/wasm/` dirs populated by `copy-assets` target via `copy-files-from-to.cjson`
- Socket.IO RPC uses `emitWithAck` pattern (replaced manual `pendingRequests` Map); prod uses `RedisIoAdapter` with `@socket.io/redis-streams-adapter` for horizontal scaling and CSR; dev uses standalone Socket.IO server on `PORT+1` via `DevWebSocketService` without Redis adapter; auth via `server.use()` middleware in gateway `afterInit`; health probes at `/health/live|ready|startup` via `@nestjs/terminus` with custom `RedisHealthIndicator` and `DatabaseHealthIndicator`
- API deployed to Fly.io (`apps/api/fly.prod.toml`); OTEL SDK bootstraps in `apps/api/app/telemetry/otel.ts`; metrics derived from `@taucad/telemetry` canonical definitions; `PrometheusExporter` on port 9464; traces+logs via OTLP/HTTP to Grafana Cloud; `TelemetryModule` (`@Global`) provides `TracerService` + `@Span()` decorator (only approved tracing approach; `withSpan` removed); `prom-client` fully replaced by `@opentelemetry/api`; Grafana dashboards-as-code in `infra/grafana/` with 10 dashboard JSONs + alert rules, synced to Fly.io Grafana via `apps/api/scripts/sync-grafana-dashboards.sh`; `grafana/otel-lgtm` in `docker-compose.yml` provides local LGTM stack parity with named volumes for data persistence
- Model benchmark suite at `apps/api/app/benchmarks/` — runner, geometry grader, HTML report generator for evaluating AI model performance on CAD tasks; uses OpenSCAD kernel for geometry validation; benchmark runner sends `kernel` metadata in chat messages which controls system prompt generation — must match target kernel; CLI at `apps/api/scripts/benchmark-models.mts` requires `node -r dotenv/config --import @oxc-node/core/register --import ./scripts/raw-loader.mts`; outputs JSON + HTML reports with geometry validation, GLB artifacts, and generated source code
- Editor architecture: machine owns openFiles, ref-counting, force-close; dockview subscribes only; use unique panel IDs (not file path); single FS worker — all filesystem access flows through one serialized worker with ZenFS and IndexedDB backend; `fromSafeAsync` (`#lib/xstate.lib.js`) replaces `fromPromise` for all UI XState async actors; `chat-editor-dockview.tsx` is the active editor (old `chat-editor.tsx` removed); file-type rendering uses a viewer registry pattern (`chat-editor-viewer-registry.ts`) with separate viewer components per type (code, markdown, plan)
- Two filesystem watch planes: kernel fast path (dependency-scoped) and UI tree path (directory-scoped); do not merge into one coarse stream
- Monaco IntelliSense types: `libs/api-extractor` generates bundled `.d.ts` per kernel; `TypeAcquisitionService` registers them via `addExtraLib` at `file:///node_modules/<pkg>/index.d.ts`; custom declarations for opencascade.js live in `repos/opencascade.js/src/declarations/`
- Typechecking uses `tsgo` (Go-based TS compiler); do not add cross-project `references` arrays to `tsconfig.json` (causes TS6305); avoid `using`/`await using` in shipped code — Rolldown won't downlevel and Safari lacks support; use try/finally with `[Symbol.asyncDispose]()` instead

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->
