# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

Tau is the AI-native CAD platform for the web (`tau.new`), built as an Nx monorepo.

- **Frontend**: React Router v7, React 19, TypeScript, Tailwind CSS, Fumadocs
- **Backend**: NestJS API with Fastify, PostgreSQL (Drizzle ORM), Redis, Better Auth
- **CAD Engine**: Multi-kernel runtime supporting Replicad, JSCAD, Manifold, OpenSCAD, and KCL
- **AI Integration**: LangGraph agent with tool-use, supporting OpenAI, Anthropic, Vertex AI, Ollama
- **Build System**: Nx monorepo, pnpm workspaces, Vite

### Applications
- `apps/ui` - React Router v7 web app (CAD editor, file manager, AI chat, docs site)
- `apps/api` - NestJS API (auth, database, chat WebSocket, LangGraph agent)
- `apps/ui-e2e` - Playwright E2E tests for UI
- `apps/api-e2e` - API E2E tests

### Published Packages (`@taucad/*`)
- `packages/kernels` - Multi-kernel CAD runtime (Replicad/JSCAD/Manifold/OpenSCAD/Zoo), worker client, middleware
- `packages/converter` - CAD file conversion (STL, STEP, IGES, DXF, glTF, USDZ)
- `packages/json-schema` - JSON to JSON Schema inference
- `packages/js` - Tau JavaScript API (early stage)

### Internal Libraries
- `libs/chat` - AI chat tool schemas, message schemas, RPC definitions
- `libs/types` - Shared TypeScript types (API, build, CAD, file, graphics, manufacturing)
- `libs/utils` - Shared utilities (ID generation, path, file, schema, dispose)
- `libs/units` - Units of measurement and conversions
- `libs/api-extractor` - Extracts API type definitions from CAD libraries for LLM context
- `libs/tau-examples` - Example CAD projects and templates

### Documentation Site
Docs live in `apps/ui/content/docs/` using Fumadocs, organized into two sections:
- **Kernels** (`(kernels)/`) - Full docs for `@taucad/kernels`: getting started, guides, concepts, API reference
- **Editor** (`(editor)/`) - Editor documentation (early stage)

## Development Commands

```bash
# Infrastructure (PostgreSQL + Redis via Docker)
pnpm infra:up               # Start all infrastructure
pnpm infra:down             # Stop all infrastructure
pnpm infra:reset            # Reset infrastructure (destroys data)

# Database (Drizzle ORM)
pnpm db:generate            # Generate Drizzle migrations
pnpm db:migrate             # Run migrations
pnpm db:studio              # Open Drizzle Studio

# CI
pnpm ci:affected            # Run affected tests, builds, lint, typecheck
pnpm ci:all                 # Run all tests, builds, lint, typecheck
```

## Code Preferences
- Early returns to reduce nesting
- Composition over inheritance
- Const declarations over function declarations
- Conditional class utilities (cn/clsx) over ternary for className
- Functional programming patterns preferred

## Testing

Vitest with separate configurations for UI (jsdom) and API (node) environments.

## Database

PostgreSQL with Drizzle ORM. Schema in `apps/api/app/database/`, migrations via `pnpm db:generate`. Auth tables managed by Better Auth.
