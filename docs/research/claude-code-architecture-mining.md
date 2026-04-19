---
title: 'Claude Code Architecture Mining'
description: 'Deep analysis of Claude Code source architecture for patterns applicable to Tau AI agent, multi-agent orchestration, plugin system, and observability.'
status: active
created: '2026-04-01'
updated: '2026-04-01'
category: reference
related:
  - docs/policy/vision-policy.md
  - docs/research/observability-architecture.md
---

# Claude Code Architecture Mining

Analysis of the Claude Code CLI source (~1,900 files, 512K+ lines of TypeScript) for architectural patterns relevant to Tau's AI-native CAD platform — particularly the AI agent, multi-agent orchestration (Vision Phase 3), plugin extensibility, and observability stack.

## Executive Summary

Claude Code is Anthropic's agentic CLI built on Bun + React/Ink with ~40 tools, a sophisticated plugin/skill/memory ecosystem, and multi-agent coordination via coordinator mode, fork subagents, and swarm teams. Six key architectural patterns are directly relevant to Tau: (1) the `buildTool()` factory with Zod-schema-driven tool registration, (2) the four-phase coordinator orchestration model for Phase 3 multi-agent workflows, (3) filesystem-based persistent memory with LLM-powered retrieval, (4) the 28-event hook system for extensibility, (5) deferred tool discovery via keyword search for scaling tool count, and (6) OS-level sandboxing for shell execution. Several patterns align closely with Tau's existing architecture, while others offer novel approaches worth adapting.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Finding 1: Tool System Architecture](#finding-1-tool-system-architecture)
- [Finding 2: Multi-Agent Orchestration](#finding-2-multi-agent-orchestration)
- [Finding 3: Skill & Memory Systems](#finding-3-skill--memory-systems)
- [Finding 4: Query Engine & Streaming](#finding-4-query-engine--streaming)
- [Finding 5: MCP & Extensibility](#finding-5-mcp--extensibility)
- [Finding 6: Telemetry & Security](#finding-6-telemetry--security)
- [Finding 7: Startup & Performance](#finding-7-startup--performance)
- [Tau Alignment Analysis](#tau-alignment-analysis)
- [Recommendations](#recommendations)

## Problem Statement

Tau's AI agent (LangGraph-based, NestJS backend) supports tool-use, TDD, and screenshot verification for CAD code generation. The Vision Policy outlines Phase 3 multi-agent orchestration where domain-specific agents coordinate through a systems agent. Understanding how a production-scale agentic system (Claude Code) solves tool registration, agent coordination, memory persistence, and observability provides concrete architectural patterns to evaluate for Tau's roadmap.

## Methodology

1. Cloned `zackautocracy/claude-code` (source map snapshot, 2026-03-31) via `pnpm repos add`
2. Deployed 6 parallel subagents, each mining a focused domain:

- Tool system & plugin architecture (`src/tools/`, `src/plugins/`, `src/hooks/`)
- Multi-agent coordination (`src/coordinator/`, `src/tasks/`, `src/tools/AgentTool/`)
- Skills & memory (`src/skills/`, `src/memdir/`, `src/context/`, `src/services/compact/`)
- Query engine & streaming (`src/QueryEngine.ts`, `src/query/`, `src/cost-tracker.ts`)
- MCP & bridge architecture (`src/services/mcp/`, `src/bridge/`, `src/server/`)
- Telemetry & security (`src/utils/telemetry/`, `src/utils/sandbox/`, `src/bootstrap/`)

3. Cross-referenced findings against Tau's vision policy, existing agent architecture, and `@taucad/telemetry`

## Finding 1: Tool System Architecture

### F1.1: `buildTool()` Factory with Fail-Closed Defaults

Every tool is defined via `ToolDef` (omitting 7 defaultable keys) and constructed through `buildTool(def)` which spreads `TOOL_DEFAULTS` — fail-closed: `isConcurrencySafe → false`, `isReadOnly → false`. This eliminates `?.() ?? default` at every call site while preserving the literal type via `BuiltTool<D>`.

**Source**: `src/Tool.ts:757-792`

### F1.2: Zod-Schema-Driven Input/Output

All tools use Zod v4 with `lazySchema()` for deferred evaluation (breaks circular init). Input schemas use `z.strictObject()` with `.describe()` on each field. Output schemas use `z.discriminatedUnion()` for multi-variant results (e.g., FileReadTool returns `text | image | notebook | pdf | parts | file_unchanged`).

**Source**: `src/tools/FileReadTool/FileReadTool.ts:227-332`

### F1.3: Static Registry with Feature-Flag Dead Code Elimination

`getAllBaseTools()` returns a flat array. Feature-gated tools use `require()` behind `feature()` checks from `bun:bundle`, enabling compile-time tree shaking. Lazy `require()` also breaks circular dependencies.

**Source**: `src/tools.ts:193-251`

### F1.4: Deferred Tool Discovery (ToolSearch)

When tool count exceeds a threshold, low-frequency tools get `defer_loading: true` in the API call. The model must use `ToolSearchTool` (keyword search over tool names, `searchHint` strings, and prompt text) to activate them. Tools opt out with `alwaysLoad: true`. This prevents context window bloat from ~40+ tool schemas.

**Source**: `src/tools/ToolSearchTool/ToolSearchTool.ts:304-471`

### F1.5: Three-Layer Permission Pipeline

Tool execution follows: (1) deny-rule filtering strips tools from the model's view entirely, (2) `validateInput()` validates structure without I/O, (3) `checkPermissions()` returns `allow | deny | ask | passthrough`. For Bash, this is ~2,600 lines including AST-based tree-sitter parsing and Haiku-powered classifier auto-approval.

**Source**: `src/tools/BashTool/bashPermissions.ts`, `src/hooks/toolPermission/`

### F1.6: Atomic Race Resolution for Permissions

`createResolveOnce()` provides compare-and-swap semantics for permission resolution. Multiple async racers (hooks, classifier, user prompt, IDE bridge, messaging channel) compete, and only the first to `claim()` wins.

**Source**: `src/hooks/toolPermission/PermissionContext.ts:75-94`

## Finding 2: Multi-Agent Orchestration

### F2.1: Seven Task Types with Five Lifecycle States

Task taxonomy: `local_bash`, `local_agent`, `remote_agent`, `in_process_teammate`, `local_workflow`, `monitor_mcp`, `dream`. States: `pending → running → completed | failed | killed`. Killed agents can be resumed via `SendMessageTool`.

**Source**: `src/Task.ts:6-29`

### F2.2: Coordinator Mode — Four-Phase Orchestration

The coordinator mode transforms the main agent into a pure orchestrator with a system prompt defining: **Research → Synthesis → Implementation → Verification**. Workers are spawned via the `Agent` tool with `subagent_type: "worker"`. Read-only tasks run in parallel; write-heavy tasks serialize per file set. Results arrive as `<task-notification>` XML injected as user-role messages.

Workers receive self-contained prompts ("Workers can't see your conversation"). A scratchpad directory provides durable cross-worker knowledge via the filesystem.

**Source**: `src/coordinator/coordinatorMode.ts:36-369`

### F2.3: Fork Subagent — Conversation Inheritance with Cache Sharing

Forked children inherit the parent's full conversation and system prompt. Fork children produce byte-identical API request prefixes by using placeholder tool results, enabling prompt cache sharing across forks. Anti-recursion guard via `<fork-boilerplate>` tag scanning.

**Source**: `src/tools/AgentTool/forkSubagent.ts:32-104`

### F2.4: Three Inter-Agent Communication Modes

1. **In-process routing**: `agentNameRegistry` lookup → queue `pendingMessage` or auto-resume stopped agents
2. **Filesystem mailbox**: `writeToMailbox(recipientName, message, teamName)` — file-based inbox
3. **Broadcast**: `to: "*"` sends to all team members (linear cost, discouraged)

Structured protocol messages (shutdown_request, plan_approval_response) route through the mailbox with JSON payloads.

**Source**: `src/tools/SendMessageTool/SendMessageTool.ts:149-873`

### F2.5: Swarm Backend Architecture — Three Execution Modes

| Backend    | Detection           | Isolation                             | Communication            |
| ---------- | ------------------- | ------------------------------------- | ------------------------ |
| tmux       | Inside tmux session | Separate pane/window                  | Filesystem mailbox       |
| iTerm2     | iTerm2 + it2 CLI    | iTerm2 tab                            | Filesystem mailbox       |
| in-process | Fallback            | `AsyncLocalStorage` context isolation | In-process message queue |

In-process teammates run in the same Node.js process with independent `AbortController` and `AsyncLocalStorage` for identity isolation.

**Source**: `src/utils/swarm/backends/`

### F2.6: Git Worktree Isolation for Parallel Agents

`EnterWorktreeTool` creates an isolated git worktree via `createWorktreeForSession()`, changes `process.cwd()`, clears system prompt caches. On completion, the worktree path and branch are included in the `<task-notification>` XML. Cleanup is automatic if no changes were made.

**Source**: `src/tools/EnterWorktreeTool/EnterWorktreeTool.ts:77-119`

### F2.7: DreamTask — Background Memory Consolidation

A background agent that reviews recent sessions and consolidates learnings into persistent memory. Tracks sessions reviewed, files touched, turns processed (capped at 30). On kill, rolls back consolidation lock mtime so the next session can retry.

**Source**: `src/tasks/DreamTask/DreamTask.ts`

## Finding 3: Skill & Memory Systems

### F3.1: Skills Are Prompt Injection, Not Tool Calls

Skills are markdown files with YAML frontmatter (`SKILL.md`) inside named directories. When invoked, `getPromptForCommand()` returns `ContentBlockParam[]` — the skill's markdown body is injected as a user message. Skills can specify `allowedTools` to grant tool permissions and use `${CLAUDE_SKILL_DIR}` for self-referencing.

Key frontmatter fields: `when_to_use` (auto-invocation trigger), `allowed-tools`, `context: fork` (sub-agent isolation), `paths` (conditional activation by file patterns), `model`, `effort`.

**Source**: `src/skills/loadSkillsDir.ts:185-401`

### F3.2: Five-Source Skill Discovery Hierarchy

Skills load from: (1) managed/enterprise, (2) user (`~/.claude/skills/`), (3) project (`.claude/skills/`, walked up directory tree), (4) additional directories (`--add-dir`), (5) legacy commands. Deduplication via `realpath()`. Dynamic discovery: when file tools touch paths, `discoverSkillDirsForPaths()` walks up looking for `.claude/skills/` directories. Conditional skills with `paths:` frontmatter activate only when matching files are touched.

**Source**: `src/skills/loadSkillsDir.ts:638-1058`

### F3.3: Memdir — File-Based Persistent Memory

Memory lives in `~/.claude/projects/<sanitized-git-root>/memory/` as plain markdown files with frontmatter (name, description, type). Four memory types: `user` (preferences), `feedback` (corrections/confirmations), `project` (ongoing work), `reference` (external system pointers). Explicitly excludes: code patterns, architecture, git history, file structure, debugging solutions.

`MEMORY.md` is the index — one-line pointers to topic files, capped at 200 lines / 25KB, always loaded into system prompt context.

**Source**: `src/memdir/memdir.ts:34-266`, `src/memdir/memoryTypes.ts:14-178`

### F3.4: LLM-Powered Memory Retrieval

On each query, `findRelevantMemories()` scans the memory directory (up to 200 files, newest-first), reads frontmatter-only (first 30 lines), sends the manifest + user query to Sonnet, which selects up to 5 relevant memory files. Memory freshness: memories >1 day old get a staleness caveat preventing stale file:line citations from being asserted authoritatively.

**Source**: `src/memdir/findRelevantMemories.ts:39-75`, `src/memdir/memoryAge.ts`

### F3.5: Nine-Section Structured Compaction

When context approaches the window limit, auto-compact generates a structured summary with 9 sections: Primary Request, Key Concepts, Files/Code, Errors/Fixes, Problem Solving, All User Messages (verbatim), Pending Tasks, Current Work (with code snippets), Optional Next Step. Uses `<analysis>` scratchpad (stripped post-generation). Post-compact, recently-read files (top 5, 50K token budget) and invoked skills are re-injected.

**Source**: `src/services/compact/prompt.ts:61-143`, `src/services/compact/compact.ts:387-763`

### F3.6: Three-Scope Agent Memory

Agent memory persists across sessions in three scopes: `user` (`~/.claude/agent-memory/{agentType}/MEMORY.md`), `project` (`.claude/agent-memory/{agentType}/MEMORY.md`, VCS-tracked), `local` (`.claude/agent-memory-local/{agentType}/MEMORY.md`, gitignored). Loaded via `loadAgentMemoryPrompt()`.

**Source**: `src/memdir/agentMemory.ts:12-13`

## Finding 4: Query Engine & Streaming

### F4.1: Three-Layer Query Architecture

1. `**QueryEngine`\*\* — owns conversation lifecycle, session state, permission tracking. One instance per conversation.
2. `**queryLoop()**` — the agentic tool-call loop. A `while(true)` loop with mutable `State` struct reassigned at continue sites.
3. `**queryModelWithStreaming()**` — the actual Anthropic SDK streaming call with VCR recording and retry logic.

The loop: pre-process context → call model → collect tool_use blocks → execute tools (streaming or sequential) → gather attachments → check termination → continue or return.

**Source**: `src/QueryEngine.ts:184`, `src/query.ts:204-307`, `src/services/api/claude.ts:752`

### F4.2: Streaming Tool Execution

`StreamingToolExecutor` starts tool execution while the model is still streaming. Concurrency-safe tools run in parallel; non-concurrent tools get exclusive access. Results are buffered and yielded in order.

**Source**: `src/query.ts:561-568`

### F4.3: Four-Stage Context Window Reduction

Before each API call: (1) snip compact (remove old messages), (2) microcompact (per-tool-result truncation/dedup), (3) context collapse (staged directory/file collapses), (4) auto compact (full API-based summarization). Three-stage prompt-too-long recovery: context collapse drain → reactive compact → surface error.

**Source**: `src/query.ts:396-547, 1062-1183`

### F4.4: Effort Levels Control Thinking Depth

Four levels: `low | medium | high | max`. Resolution: env var → appState → model default. Wired to API via `output_config.effort`. Adaptive thinking mode lets the model decide depth. "Ultrathink" keyword trigger bumps effort from medium to high.

**Source**: `src/utils/model/effort.ts:13-167`

### F4.5: Cost Tracking with Hardcoded Pricing Table

Per-message cost computed at `message_delta` time. `addToTotalSessionCost()` accumulates into per-model usage stats and OTEL counters. Hardcoded per-million-token pricing table for each model family. Session costs persisted to project config JSON for resume.

**Source**: `src/cost-tracker.ts:278-323`, `src/utils/model/modelCost.ts:104-126`

## Finding 5: MCP & Extensibility

### F5.1: Eight MCP Transport Variants

`stdio`, `sse`, `sse-ide`, `http`, `ws`, `sdk`, `ws-ide`, `claudeai-proxy`. Each has its own Zod schema. Connection batching: 3 concurrent local servers, 20 concurrent remote servers. Five-state connection lifecycle: `connected`, `failed`, `needs-auth`, `pending`, `disabled`.

**Source**: `src/services/mcp/types.ts:23-226`

### F5.2: Multi-Scope MCP Configuration with Enterprise Policy

Seven config scopes: `local`, `user`, `project`, `dynamic`, `enterprise`, `claudeai`, `managed`. Enterprise scope has exclusive control when present. Deduplication by server signature (command+args for stdio, URL for remote). Three-tier policy: name-based, command-based, URL-based. Denylist takes absolute precedence.

**Source**: `src/services/mcp/config.ts`

### F5.3: Plugin System with Multi-Source Extension Points

Plugins extend via: MCP servers (merged into tool pool), LSP servers, commands, agents, skills, hooks, output styles, and settings. Plugin manifest uses Zod schema. Sources: relative paths, npm, pip, git URLs, GitHub repos, git-subdir (monorepo sparse checkout). Marketplace architecture with anti-impersonation checks.

**Source**: `src/utils/plugins/schemas.ts:884-1391`

### F5.4: 28-Event Hook System

Hook events span: lifecycle (`SessionStart`, `SessionEnd`, `Setup`), tool lifecycle (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`), permissions (`PermissionRequest`, `PermissionDenied`), compaction (`PreCompact`, `PostCompact`), agents (`SubagentStart`, `SubagentStop`), elicitation, filesystem (`CwdChanged`, `FileChanged`), and more. Four hook types: `command` (shell), `prompt` (LLM), `http` (webhook), `agent` (agentic verifier).

**Source**: `src/entrypoints/sdk/coreSchemas.ts:355-383`, `src/schemas/hooks.ts:31-189`

### F5.5: SDK Entrypoints for Programmatic Usage

Two schema layers: `coreSchemas.ts` (~~1,890 lines for consumer-facing SDK types) and `controlSchemas.ts` (~~664 lines for control protocol between SDK and CLI). MCP server entrypoint exposes all tools via `ListToolsRequestSchema` + `CallToolRequestSchema` handlers.

**Source**: `src/entrypoints/sdk/`

## Finding 6: Telemetry & Security

### F6.1: Full OTEL Three-Signal Coverage with Lazy Loading

Metrics, traces, logs via `@opentelemetry/`\* SDK. Exporters are dynamically imported based on configured protocol to avoid loading all 6 packages (~1.2MB) at startup. Delta temporality default for metrics. Graceful shutdown with parallel flush+shutdown raced against 2s timeout.

**Source**: `src/utils/telemetry/instrumentation.ts`

### F6.2: AsyncLocalStorage Span Hierarchy

Session tracing: `interaction → llm_request → tool → tool.blocked_on_user → tool.execution → hook`. Spans stored in `Map<string, WeakRef<SpanContext>>` with 30-minute TTL cleanup.

**Source**: `src/utils/telemetry/sessionTracing.ts:79-120`

### F6.3: OS-Level Shell Sandboxing

`@anthropic-ai/sandbox-runtime` wraps shell commands with OS-level isolation: macOS (sandbox-exec), Linux/WSL2 (bubblewrap). Filesystem allow/deny lists derived from permission rules. Git bare-repo files scrubbed post-command to prevent `core.fsmonitor` escape vectors.

**Source**: `src/utils/sandbox/sandbox-adapter.ts`

### F6.4: Fuzzy File Index with Bitmap Pre-Filter

Pure TypeScript port of nucleo scoring. 26-bit `charBits` per path for O(1) rejection. `String.indexOf()` (SIMD-accelerated in V8) for greedy match positions. Gap-bound reject skips paths that can't beat top-k threshold. Async index building with ~4ms chunked yielding for responsiveness.

**Source**: `src/native-ts/file-index/index.ts:83-291`

## Finding 7: Startup & Performance

### F7.1: Pre-Import Prefetch Parallelism

Three async operations fire as top-level side effects in `main.tsx` before ~135ms of remaining imports: (1) profile checkpoint, (2) MDM subprocess spawns (plutil/reg query), (3) parallel macOS keychain reads. Subprocesses finish during the import window — nearly free.

**Source**: `src/main.tsx:1-20`, `src/utils/secureStorage/keychainPrefetch.ts:69-98`

### F7.2: Deferred Analytics Drain

Events logged before `attachAnalyticsSink()` are queued. Drain via `queueMicrotask()` when sink attaches. OTLP exporters lazy-loaded to avoid ~1.2MB startup cost.

**Source**: `src/services/analytics/index.ts:95-123`

### F7.3: lazySchema Pattern

All Zod schemas use `lazySchema(() => z.object({...}))` — a factory that defers schema construction. This breaks circular dependencies and reduces startup cost from schema evaluation.

**Source**: Throughout codebase

## Tau Alignment Analysis

### Vision Policy Cross-Reference

| Vision Principle                             | Claude Code Pattern                                                    | Tau Alignment                                                                                           | Classification |
| -------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------- |
| "Everything is pluggable" (`defineKernel()`) | Plugin system with MCP/LSP/hooks/skills extension points               | Tau's kernel plugin pattern is structurally similar; hook system adds lifecycle extensibility Tau lacks | **Adapt**      |
| "AI agents are collaborators"                | Coordinator mode: Research → Synthesis → Implementation → Verification | Maps to Phase 3 multi-agent orchestration; 4-phase workflow is a concrete pattern                       | **Adapt**      |
| "Code is the interface"                      | Filesystem-based memory, task lists, and inter-agent mailbox           | Tau already uses files-as-interface; persistent memory and filesystem task lists are novel              | **Adapt**      |
| Multi-kernel runtime                         | Single-model tool system, no kernel concept                            | Not applicable — Claude Code is single-domain (coding)                                                  | **Skip**       |
| Phase 3 multi-agent                          | Coordinator + fork + swarm (three concurrency models)                  | Directly relevant — three models offer different trade-offs for different Phase 3 scenarios             | **Adopt**      |

### Architectural Comparison

| Area                 | Claude Code                                              | Tau Current                                    | Gap                                                 |
| -------------------- | -------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| Tool registration    | `buildTool()` factory + Zod schema + deferred discovery  | LangGraph tool schemas in `libs/chat`          | Tau lacks deferred discovery for scaling tool count |
| Agent orchestration  | Coordinator/fork/swarm modes                             | Single LangGraph agent                         | Tau needs multi-agent patterns for Phase 3          |
| Memory persistence   | File-based memdir with LLM retrieval                     | Session-scoped chat history only               | No persistent cross-session memory                  |
| Context management   | 4-stage reduction pipeline + structured compaction       | LangGraph message trimming                     | Less sophisticated context management               |
| Observability        | Full OTEL 3-signal + Perfetto traces + BigQuery exporter | `@taucad/telemetry` with OTEL metrics + traces | Tau's stack is architecturally aligned; less mature |
| Permission model     | Three-layer pipeline with classifier + hooks             | LangGraph tool gates                           | Less granular permission model                      |
| Sandboxing           | OS-level sandbox-exec/bubblewrap                         | None (browser sandbox only)                    | Different threat model (browser vs CLI)             |
| Plugin system        | Multi-source plugins with marketplace                    | Kernel plugins via `defineKernel()`            | Tau plugins are domain-specific (CAD kernels)       |
| Hook system          | 28 lifecycle events with 4 hook types                    | No general hook system                         | Significant gap for extensibility                   |
| Startup optimization | Pre-import prefetch, lazy loading, dead code elimination | Vite lazy loading, code splitting              | Different runtime (Bun vs browser)                  |

## Recommendations

| #   | Action                                                                                                                                                                                                        | Priority | Effort | Impact | Vision Phase |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ | ------------ |
| R1  | **Adopt coordinator orchestration pattern** for Phase 3 multi-agent: Research → Synthesis → Implementation → Verification with self-contained worker prompts and `<task-notification>` XML result aggregation | P0       | High   | High   | Phase 3      |
| R2  | **Adapt persistent memory system** — file-based memdir with four-type taxonomy (user/feedback/project/reference) and LLM-powered retrieval for cross-session agent learning                                   | P1       | Medium | High   | Phase 1-3    |
| R3  | **Adapt hook system** — lifecycle events (`PreToolUse`, `PostToolUse`, `SessionStart`) with webhook/command/prompt hook types for agent extensibility                                                         | P1       | Medium | High   | Phase 1      |
| R4  | **Adapt deferred tool discovery** — as Tau's tool count grows, implement keyword-based tool search to prevent context window bloat                                                                            | P2       | Low    | Medium | Phase 1-2    |
| R5  | **Reference structured compaction** — 9-section summary template with file restoration post-compact for long-running agent sessions                                                                           | P2       | Medium | Medium | Phase 1      |
| R6  | **Adapt `buildTool()` factory pattern** — fail-closed defaults with Zod schema validation for Tau's LangGraph tool definitions                                                                                | P2       | Low    | Medium | Phase 1      |
| R7  | **Reference fork subagent cache sharing** — byte-identical API request prefixes via placeholder tool results for prompt cache optimization                                                                    | P3       | High   | Medium | Phase 3      |
| R8  | **Adapt effort/thinking levels** — expose thinking depth control (low/medium/high/max) in Tau's AI chat UI                                                                                                    | P2       | Low    | Medium | Phase 1      |
| R9  | **Reference filesystem mailbox pattern** — inter-agent communication via file-based inbox for swarm coordination                                                                                              | P3       | Low    | Low    | Phase 3      |
| R10 | **Adapt OTEL span hierarchy** — adopt `interaction → llm_request → tool → tool.execution` span naming convention for `@taucad/telemetry` consistency                                                          | P2       | Low    | Medium | Phase 1      |
| R11 | **Reference fuzzy file index** — bitmap pre-filter + gap-bound reject scoring for Tau's file tree search                                                                                                      | P3       | Medium | Low    | Phase 1      |
| R12 | **Skip OS-level sandboxing** — different threat model (Tau runs in browser sandbox; Claude Code runs on user's machine)                                                                                       | —        | —      | —      | —            |

## Key Architectural Patterns Worth Studying

### Pattern 1: Schema-Driven Everything

Claude Code uses Zod schemas as the single source of truth for tool inputs, tool outputs, permission rules, plugin manifests, marketplace configs, hook definitions, MCP server configs, and SDK types. Types are inferred via `z.infer<>`. The `lazySchema()` pattern defers construction to break circular dependencies. This is architecturally aligned with Tau's Zod usage in `libs/chat` but applied more pervasively.

### Pattern 2: Deny-Before-Ask Permission Ordering

Throughout the permission system, deny rules are checked before ask rules, and both before allow rules. In bash permissions: exact-deny → prefix-deny → exact-ask → prefix-ask → path constraints → exact-allow → prefix-allow → mode check → read-only auto-allow. This ordering prevents security bypasses.

### Pattern 3: Atomic Race Resolution

The `createResolveOnce()` pattern with `.claim()` provides compare-and-swap semantics for permission resolution. Multiple async racers compete, and only the first to claim wins. This avoids the ref/state sync guard anti-pattern that Tau's xstate-policy warns against.

### Pattern 4: Files as Coordination Medium

Inter-agent communication, task lists, memory, and team configuration all use the filesystem as the coordination medium. This aligns with Tau's "files are the interface" principle and suggests that Phase 3 multi-agent coordination should use the filesystem (not in-memory message buses) for durability and debuggability.

### Pattern 5: Prompt Cache Sharing via Byte-Identical Prefixes

Fork subagents produce byte-identical API request prefixes by using placeholder tool results for all tool_use blocks. This enables prompt cache hits across forks — significant cost savings for parallel agent execution.

## References

- Source: `repos/claude-code/` (cloned via `pnpm repos add zackautocracy/claude-code -g reference --clone`)
- [GitHub mirror](https://github.com/zackautocracy/claude-code) — research snapshot, not official Anthropic repository
- Vision: `docs/policy/vision-policy.md`
- Telemetry: `docs/research/observability-architecture.md`
