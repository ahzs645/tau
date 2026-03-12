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
- **AI**: LangGraph agent with tool-use (OpenAI, Anthropic, Vertex AI, Ollama)

### Project Map

| Path                    | Description                                                            |
| ----------------------- | ---------------------------------------------------------------------- |
| `apps/ui`               | React Router v7 web app (CAD editor, file manager, AI chat, docs)      |
| `apps/api`              | NestJS API (auth, database, chat WebSocket, LangGraph agent)           |
| `packages/runtime`      | Multi-kernel CAD runtime — consumed as source via package.json exports |
| `packages/converter`    | CAD file conversion (STL, STEP, IGES, DXF, glTF, USDZ)                 |
| `packages/json-schema`  | JSON to JSON Schema inference                                          |
| `libs/chat`             | AI chat tool schemas, message schemas, RPC definitions                 |
| `libs/types`            | Shared TypeScript types (API, build, CAD, file, graphics)              |
| `libs/utils`            | Shared utilities (ID generation, path, file, schema, dispose)          |
| `libs/units`            | Units of measurement and conversions                                   |
| `apps/ui/content/docs/` | Docs site (Fumadocs): `(runtime)/` and `(editor)/` sections            |

## Skills

Project skills in `.cursor/skills/` provide guided workflows. Read the relevant `SKILL.md` when performing these tasks:

| Skill                   | When to use                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `create-policy`         | Writing or updating `docs/policy/*.md` documents                                           |
| `create-research`       | Writing or updating `docs/research/*.md` investigation documents                           |
| `adding-tools`          | Adding new tools to the AI chat system                                                     |
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
- Follow policy docs when applicable: testing-policy, library-api-policy, xstate-policy, lint-policy, react-testing-policy, filesystem-policy, commit-policy, typescript-policy, agents-md-policy, context-engineering-policy, jsdoc-policy
- Pin GitHub/dependency versions to exact commit hashes for reproducibility and immutability
- When behavior regressed from something that previously worked, prefer config changes over code changes — find the regression
- Use `pnpm patch` tool for dependency patches; do not manually create patch files
- Use `react-virtuoso` for virtualization, not `@tanstack/react-virtual`; follow patterns in `combobox-responsive.tsx`
- Never blow away the entire IndexedDB database — user work is stored there
- Prefer algorithmic, code-level solutions over bundler config or Vite plugins; optimize for 3rd-party consumer DX
- Avoid type assertion escape hatches (`as never`, `as unknown as`, unnecessary `as const` on returns); fix underlying type issues instead
- When asked to explore or investigate, present findings and analysis first; do not jump to code changes until implementation is explicitly requested
- JSDoc codeblocks use explicit language tags (`typescript`/`javascript`, not `ts`/`js`); `@public` tag gates compile-checking — never downgrade to `text` to avoid compilation; use `text` only for non-code content (output, trees); examples must reflect actual consumer usage patterns, not synthetic isolated calls; public JSDoc required for `libs/` and `packages/` only — apps are exempt

## Learned Workspace Facts

- Policy docs live in `docs/policy/` (testing, library-api, vision, lint, xstate, typescript, filesystem, react-testing, commit, agents-md, context-engineering, jsdoc, and more); research docs in `docs/research/`
- Hybrid oxlint + ESLint linting: oxlint runs first, ESLint handles residual rules; custom Oxlint JS plugins in `libs/oxlint/`; rule tests use `oxlint-disable` syntax (ESLint 9 RuleTester strips `eslint-disable` from `getAllComments()`)
- External repos in `repos/` managed via `repos.yaml` and `pnpm repos`; gitignored and cursorignored; add to `.oxlintrc.json` ignorePatterns
- `packages/runtime` is consumed as source via package.json exports, not built output; test mocks in `packages/runtime/src/testing/kernel-testing.utils.ts`; Vite plugins in `@taucad/vite` with `*.vite-plugin.ts` suffix, `vite:` prefix, Vite 8 hook filters
- PR workflow: submit as draft; human reviews before marking ready via `gh pr ready`
- Single FS worker architecture; all filesystem access flows through one serialized worker with ZenFS and IndexedDB backend
- Editor architecture: machine owns openFiles, ref-counting, force-close; dockview subscribes only; use unique panel IDs (not file path)
- Two filesystem watch planes: kernel fast path (dependency-scoped) and UI tree path (directory-scoped); do not merge into one coarse stream
- `repos/opencascade.js` WASM build: platform bindings in `BUILTIN_ADDITIONAL_BIND_CODE` (Python layer); full builds (10-30+ min) use `nohup`
- `fromSafeAsync` (`#lib/xstate.lib.js`) replaces `fromPromise` for all UI XState async actors; uses `<TReturn, TInput>` generics matching `fromPromise<TOutput, TInput>`
- Monaco IntelliSense types: `libs/api-extractor` generates bundled `.d.ts` per kernel; `TypeAcquisitionService` registers them via `addExtraLib` at `file:///node_modules/<pkg>/index.d.ts`; custom declarations for opencascade.js live in `repos/opencascade.js/src/declarations/`
- Typechecking uses `tsgo` (Go-based TS compiler); do not add cross-project `references` arrays to `tsconfig.json` (causes TS6305); avoid `using`/`await using` in shipped code — Rolldown won't downlevel and Safari lacks support; use try/finally with `[Symbol.asyncDispose]()` instead
