---
title: 'Claude Code Subagent Architecture'
description: 'Deep analysis of how Claude Code spawns, isolates, coordinates, and manages subagents — three concurrency models (coordinator, fork, swarm), task lifecycle, inter-agent communication, and comparison with Tau single-agent architecture.'
status: active
created: '2026-04-01'
updated: '2026-04-01'
category: reference
related:
  - docs/policy/vision-policy.md
  - docs/research/claude-code-architecture-mining.md
  - docs/research/claude-code-prompting-techniques.md
  - docs/research/claude-code-skill-injection-techniques.md
---

# Claude Code Subagent Architecture

Deep analysis of how Claude Code spawns, isolates, coordinates, and manages subagents — covering the three concurrency models (coordinator, fork, swarm), task lifecycle, inter-agent communication, and result aggregation — with comparison against Tau's single-agent LangGraph architecture.

## Executive Summary

Claude Code implements three mutually-selectable concurrency models for multi-agent work: (1) **Coordinator mode** — a pure orchestrator dispatches self-contained workers through a four-phase Research/Synthesis/Implementation/Verification workflow; (2) **Fork mode** — subagents inherit the parent's full conversation context with byte-identical API prefixes for prompt cache sharing; and (3) **Swarm/team mode** — independent agents coordinate via filesystem mailboxes and shared task lists across tmux, iTerm2, or in-process backends. Tau currently runs a single LangGraph agent per chat request with no subagent capability. The coordinator pattern maps directly to Tau's Vision Phase 3 multi-agent orchestration. Seven recommendations are proposed for adopting subagent patterns into Tau's LangGraph architecture.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Finding 1: AgentTool — The Spawning Mechanism](#finding-1-agenttool--the-spawning-mechanism)
- [Finding 2: Three Concurrency Models](#finding-2-three-concurrency-models)
- [Finding 3: Task Lifecycle Management](#finding-3-task-lifecycle-management)
- [Finding 4: Context Isolation](#finding-4-context-isolation)
- [Finding 5: Inter-Agent Communication](#finding-5-inter-agent-communication)
- [Finding 6: Result Aggregation](#finding-6-result-aggregation)
- [Finding 7: Git Worktree Isolation](#finding-7-git-worktree-isolation)
- [Finding 8: Agent Lifecycle Operations](#finding-8-agent-lifecycle-operations)
- [Tau Comparison](#tau-comparison)
- [Recommendations](#recommendations)

## Problem Statement

Tau's Vision Policy (Phase 3) describes "multi-agent orchestration — domain-specific AI agents (mechanical, electrical, firmware, simulation) coordinating through a systems agent that maintains cross-discipline constraints." Tau currently operates a single LangGraph `ReactAgent` per chat request with no subagent spawning, no coordinator pattern, and no inter-agent communication. Understanding how Claude Code — a production system handling millions of daily agent spawns — implements multi-agent coordination provides a concrete architectural blueprint for Tau's Phase 3 roadmap.

## Methodology

1. Deep-read `src/tools/AgentTool/` (spawning mechanism, 21 findings across 8 files)
2. Deep-read `src/coordinator/` (orchestration mode, system prompt, worker dispatch)
3. Deep-read `src/tools/AgentTool/forkSubagent.ts` (fork pattern, cache sharing)
4. Deep-read `src/utils/swarm/` (team backends, mailbox, registry, in-process isolation)
5. Deep-read `src/tasks/` (task types, lifecycle states, notification delivery)
6. Deep-read `src/tools/SendMessageTool/` (inter-agent messaging protocol)
7. Cross-referenced against Tau's `chat.service.ts`, `chat.controller.ts`, and middleware stack

## Finding 1: AgentTool — The Spawning Mechanism

### Input Schema

The `AgentTool` accepts these parameters:

| Parameter           | Type                             | Purpose                                                          |
| ------------------- | -------------------------------- | ---------------------------------------------------------------- |
| `prompt`            | string                           | The task for the agent to perform                                |
| `description`       | string                           | Short (3-5 word) task description                                |
| `subagent_type`     | string?                          | Specialized agent type (e.g., `'Explore'`, `'Plan'`, `'worker'`) |
| `model`             | `'sonnet' \| 'opus' \| 'haiku'`? | Model override                                                   |
| `run_in_background` | boolean?                         | Run asynchronously                                               |
| `name`              | string?                          | Agent name (for team messaging)                                  |
| `team_name`         | string?                          | Team to join                                                     |
| `mode`              | PermissionMode?                  | Permission mode override                                         |
| `isolation`         | `'worktree'`?                    | Git worktree isolation                                           |
| `cwd`               | string?                          | Working directory override                                       |

**Source**: `repos/claude-code/src/tools/AgentTool/AgentTool.tsx:82-125`

### Spawning Sequence (10 Steps)

1. Team/teammate validation — block teammate re-spawning
2. Multi-agent spawn dispatch — if `team_name` + `name`, spawn teammate and return
3. Agent type resolution — lookup in `agentDefinitions.activeAgents`, default to fork or general-purpose
4. Required MCP server check — wait up to 30s for pending servers
5. Model resolution — agent-defined → CLI flag → env var → default
6. Isolation setup — create git worktree if `isolation === 'worktree'`
7. System prompt assembly — fork uses parent's rendered prompt; normal uses `getSystemPrompt()` + `enhanceSystemPromptWithEnvDetails()`
8. Tool pool assembly — independent `assembleToolPool()` for worker
9. Async decision — background if `run_in_background`, coordinator mode, fork mode, or proactive mode
10. Dispatch — call `runAgent()` async generator

### Built-In Agent Types

| Type                | Model   | Read-Only | Key Traits                                           |
| ------------------- | ------- | --------- | ---------------------------------------------------- |
| `general-purpose`   | default | No        | All tools, general search/analysis                   |
| `Explore`           | haiku   | Yes       | One-shot, `omitClaudeMd`, disallows Edit/Write/Agent |
| `Plan`              | inherit | Yes       | One-shot, read-only architect                        |
| `verification`      | inherit | No        | Background, adversarial red-team verifier            |
| `claude-code-guide` | haiku   | No        | Docs fetcher, limited tools                          |
| `fork` (synthetic)  | inherit | No        | Cache-optimized clone, `permissionMode: 'bubble'`    |

**Source**: `repos/claude-code/src/tools/AgentTool/builtInAgents.ts`

### One-Shot Optimization

Explore and Plan agents are marked "one-shot" — they skip the agentId/`<usage>` trailer in results (~135 chars × 34M weekly runs ≈ 1-2 Gtok/week saved), omit CLAUDE.md, and strip git status from system context.

**Source**: `repos/claude-code/src/tools/AgentTool/constants.ts:9-12`

## Finding 2: Three Concurrency Models

### Model 1: Coordinator Mode

The coordinator transforms the main agent into a **pure orchestrator** with a ~370-line system prompt defining a four-phase workflow:

| Phase              | Who                | Purpose                                                |
| ------------------ | ------------------ | ------------------------------------------------------ |
| **Research**       | Workers (parallel) | Investigate codebase, read files, grep                 |
| **Synthesis**      | Coordinator only   | Read worker findings, craft implementation specs       |
| **Implementation** | Workers            | Targeted changes per spec (one at a time per file set) |
| **Verification**   | Workers            | Run tests, check behavior, prove correctness           |

**Key architectural rules:**

- "Workers can't see your conversation" — every prompt must be self-contained
- Read-only tasks run in parallel freely; write-heavy tasks serialize per file set
- Scratchpad directory for durable cross-worker knowledge via filesystem
- Coordinator NEVER writes code directly — delegates everything to workers

**Activation**: Feature flag `COORDINATOR_MODE` + env var. Mutually exclusive with fork mode. Sessions persist their mode across resume.

**Source**: `repos/claude-code/src/coordinator/coordinatorMode.ts:111-369`

### Model 2: Fork Subagent

Fork creates **clones that inherit the parent's full conversation**:

- Triggered when `subagent_type` is omitted and fork feature gate is active
- `buildForkedMessages()` clones the parent's assistant message with all tool_use blocks, creates placeholder tool_results with identical text, appends per-child directive
- **Byte-identical API prefixes** enable prompt cache sharing across concurrent forks
- Anti-recursion guard: `isInForkChild()` scans messages for `<fork-boilerplate>` tag
- `permissionMode: 'bubble'` surfaces permission prompts to parent terminal
- All forks forced to run async (`forceAsync = true`)

**Source**: `repos/claude-code/src/tools/AgentTool/forkSubagent.ts`

### Model 3: Swarm/Team Mode

Independent agents coordinate via filesystem-based messaging:

| Backend        | Detection                   | Isolation                            | Communication   |
| -------------- | --------------------------- | ------------------------------------ | --------------- |
| **tmux**       | `TMUX` env var              | Separate pane (30/70 vertical split) | File mailbox    |
| **iTerm2**     | `TERM_PROGRAM` + `it2` CLI  | Separate tab                         | File mailbox    |
| **In-process** | Fallback (always available) | `AsyncLocalStorage`                  | In-memory queue |

**Team structure**: Leader creates team via `TeamCreateTool`, spawns teammates with names/roles. Team config at `~/.claude/teams/{name}/config.json`. Shared task list at `~/.claude/tasks/{id}/`.

**Source**: `repos/claude-code/src/utils/swarm/backends/`

### Comparison Matrix

| Aspect           | Coordinator                            | Fork                              | Swarm/Team                         |
| ---------------- | -------------------------------------- | --------------------------------- | ---------------------------------- |
| Context sharing  | None — self-contained prompts          | Full conversation inheritance     | Filesystem mailbox + task list     |
| Cache efficiency | Standard (no sharing)                  | Maximum (byte-identical prefixes) | None (independent sessions)        |
| Parallelism      | Multiple workers in one message        | Multiple forks in one message     | Independent processes              |
| Isolation        | API-level (separate message histories) | API-level + optional worktree     | Process-level or AsyncLocalStorage |
| Coordination     | System prompt + `<task-notification>`  | Parent consumes fork output       | Mailbox polling + task claims      |
| Best for         | Complex multi-phase tasks              | Parallel variations of same task  | Long-running teams with roles      |

## Finding 3: Task Lifecycle Management

### Task Type Taxonomy

Seven task types with type-prefixed IDs:

| Type                  | Prefix | Purpose                                |
| --------------------- | ------ | -------------------------------------- |
| `local_bash`          | `b`    | Shell command execution                |
| `local_agent`         | `a`    | LLM subagent (coordinator/fork/inline) |
| `remote_agent`        | `r`    | Cloud-hosted agent session             |
| `in_process_teammate` | `t`    | In-process swarm teammate              |
| `local_workflow`      | `w`    | Workflow orchestration                 |
| `monitor_mcp`         | `m`    | MCP server monitor                     |
| `dream`               | `d`    | Background memory consolidation        |

### State Machine

```
pending → running → completed
                  → failed
                  → killed → (resumable via SendMessage)
```

Terminal states: `completed`, `failed`, `killed`. Killed agents can be **resumed** — `SendMessageTool` detects stopped tasks and calls `resumeAgentBackground()`, which reconstructs the agent from its transcript and metadata.

**Source**: `repos/claude-code/src/Task.ts:6-29`

### Sync → Async Backgrounding

Agents start synchronous (foreground) but can be backgrounded:

- Automatically after 120s (`autoBackgroundMs`)
- Manually via Ctrl+B
- On `backgroundSignal` resolution, the foreground iterator is cleaned up and `runAgent()` restarts in async mode
- Progress tracking transfers seamlessly via `ProgressTracker`

## Finding 4: Context Isolation

### `createSubagentContext()` — The Isolation Boundary

Every subagent gets a fully isolated `ToolUseContext` via `createSubagentContext()`:

**Cloned (independent copies):**

- `readFileState` (LRU file cache)
- `contentReplacementState` (tool result budgets)
- `localDenialTracking` (permission denial history)
- All Set collections (skills, memory paths) — fresh empties

**Isolated (no-ops or undefined):**

- `setAppState` → no-op (prevents child mutations to parent state)
- All UI callbacks (`addNotification`, `setToolJSX`, `setStreamMode`) → undefined
- `toolDecisions` → undefined (fresh permission cache)

**Shared (reaches root):**

- `setAppStateForTasks` → always reaches root store (task registration/kill visibility)
- `updateAttributionState` → functional, safe for concurrent calls
- `fileReadingLimits`, `userModified` → copied from parent

**Source**: `repos/claude-code/src/utils/forkedAgent.ts:345-462`

### AbortController Linking

Three distinct patterns:

| Pattern      | When                  | Behavior                                       |
| ------------ | --------------------- | ---------------------------------------------- |
| Shared       | Sync agents           | Parent ESC kills child immediately             |
| Unlinked     | Async agents          | Child survives parent ESC                      |
| Child-linked | createSubagentContext | Parent abort cascades to child, not vice versa |

### Agent MCP Server Scoping

Agents can define their own MCP servers. Two scoping modes:

- **By reference** (string name): Memoized shared client, NOT cleaned up with agent
- **Inline definition**: New client created, cleaned up in agent's `finally` block

**Source**: `repos/claude-code/src/tools/AgentTool/runAgent.ts:95-218`

## Finding 5: Inter-Agent Communication

### Three Routing Modes

**Mode 1 — In-process routing**: `agentNameRegistry` lookup → queue `pendingMessage` if running, or auto-resume if stopped.

**Mode 2 — Filesystem mailbox**: `writeToMailbox(recipientName, message, teamName)` writes to `~/.claude/teams/{team}/inboxes/{name}.json`. File lock with retries (10 retries, 5-100ms backoff). Polling: 500ms for in-process, 1000ms for pane-based.

**Mode 3 — Broadcast**: `to: "*"` fans out to all team members except sender.

### Message Format

```typescript
type TeammateMessage = {
  from: string;
  text: string; // may be JSON for structured messages
  timestamp: string; // ISO
  read: boolean; // false = unread
  color?: string;
  summary?: string; // 5-10 word preview
};
```

### Structured Protocol Messages

Discriminated union: `shutdown_request`, `shutdown_response`, `plan_approval_response`. Route through the mailbox with JSON payloads.

### Message Priority (In-Process Poll Loop)

1. Shutdown requests (highest)
2. Team-lead messages
3. Any unread message (FIFO)
4. Task list claims (lowest)

**Source**: `repos/claude-code/src/tools/SendMessageTool/SendMessageTool.ts`, `repos/claude-code/src/utils/teammateMailbox.ts`

## Finding 6: Result Aggregation

### `<task-notification>` XML Format

Worker results arrive as **user-role messages** in the parent's conversation:

```xml
<task-notification>
  <task-id>{agentId}</task-id>
  <output-file>{path}</output-file>
  <status>completed|failed|killed</status>
  <summary>{human-readable}</summary>
  <result>{agent's final text}</result>
  <usage>
    <total_tokens>N</total_tokens>
    <tool_uses>N</tool_uses>
    <duration_ms>N</duration_ms>
  </usage>
  <worktree>
    <worktree-path>{path}</worktree-path>
    <worktree-branch>{branch}</worktree-branch>
  </worktree>
</task-notification>
```

Delivery via `enqueuePendingNotification()` with `mode: 'task-notification'`. Atomic `notified` flag prevents duplicate delivery.

**Source**: `repos/claude-code/src/tasks/LocalAgentTask/LocalAgentTask.tsx:197-262`

### Background Summarization

Every 30 seconds, `startAgentSummarization()` forks the agent's transcript and generates a 3-5 word progress summary via a lightweight API call. Summary stored in `task.progress.summary`. Uses the parent's prompt cache (identical prefix) — tools are denied via `canUseTool` callback (not by removal, which would bust the cache).

**Source**: `repos/claude-code/src/services/AgentSummary/agentSummary.ts`

### Handoff Safety Classification

When auto-mode is active, `classifyHandoffIfNeeded()` runs a classifier on the sub-agent's work before returning results to the parent. Flagged work gets a `SECURITY WARNING` prepended to the result.

## Finding 7: Git Worktree Isolation

### Lifecycle

1. **Create**: `createAgentWorktree(slug)` creates a worktree with branch `agent-{id-prefix}`
2. **Execute**: All agent work runs inside `runWithCwdOverride(worktreePath, fn)` so `getCwd()` returns the worktree
3. **Fork + worktree**: Worktree notice injected telling child to translate paths and re-read stale files
4. **Cleanup**: `hasWorktreeChanges(worktreePath, headCommit)` — if no changes, auto-remove. If changes exist, return `{ worktreePath, worktreeBranch }` in the result
5. **Resume**: Worktree path persisted in agent metadata. On resume, mtime bumped to prevent stale cleanup

**Source**: `repos/claude-code/src/tools/AgentTool/AgentTool.tsx:590-685`

## Finding 8: Agent Lifecycle Operations

### 10-Step Cleanup on Agent Exit

The `finally` block in `runAgent()` performs:

1. Clean up agent-specific MCP servers (inline definitions only)
2. Clear agent's session hooks
3. Clean up prompt cache tracking state
4. Release cloned file state cache memory
5. Release cloned fork context messages
6. Unregister perfetto agent tracing
7. Clear transcript subdirectory mapping
8. Release agent's todo entries
9. Kill orphaned bash tasks spawned by this agent
10. Kill MCP monitor tasks for this agent

Additional cleanup: invoked skills, dump state, foreground task unregistration, auto-background timer cancellation, worktree cleanup.

**Source**: `repos/claude-code/src/tools/AgentTool/runAgent.ts:816-858`

### Agent Resume

`resumeAgentBackground()` reconstructs a stopped agent from its transcript:

1. Read transcript + metadata from disk
2. Filter messages (whitespace-only, orphaned thinking, unresolved tool uses)
3. Reconstruct `contentReplacementState` for prompt cache stability
4. Validate worktree still exists
5. Resolve agent definition from metadata
6. Register as async agent, spawn with resumed messages + new prompt

### Permission Handling

Resolution precedence:

1. `bypassPermissions` / `acceptEdits` from parent always win
2. Agent-defined `permissionMode` overrides parent's mode
3. Async agents auto-deny permissions unless `canShowPermissionPrompts` or `permissionMode: 'bubble'`
4. `allowedTools` replaces ALL session-level allow rules (preventing parent permission leakage)

## Tau Comparison

### Architectural Gap Analysis

| Aspect                 | Claude Code                                                             | Tau                                                           |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Agent model**        | Three concurrency models (coordinator/fork/swarm)                       | Single `ReactAgent` per request                               |
| **Graph structure**    | Custom `while(true)` loop with mutable state                            | LangChain `createAgent` (opaque graph)                        |
| **Subagent spawning**  | `AgentTool` with 10-step spawn sequence                                 | No subagent tool                                              |
| **Agent types**        | 6 built-in + custom via markdown definitions                            | N/A                                                           |
| **Context isolation**  | `createSubagentContext()` with cloned/isolated/shared layers            | N/A                                                           |
| **Inter-agent comms**  | In-process queue, filesystem mailbox, broadcast                         | N/A                                                           |
| **Result format**      | `<task-notification>` XML as user messages                              | N/A                                                           |
| **Git worktree**       | Per-agent worktrees with auto-cleanup                                   | N/A                                                           |
| **Task lifecycle**     | 7 types, 5 states, foreground/background transitions                    | N/A                                                           |
| **Agent resume**       | Reconstruct from transcript + metadata                                  | Postgres checkpointer (conversation resume, not agent resume) |
| **Permission scoping** | Per-agent permission rules, bubble mode                                 | Single permission context                                     |
| **Cleanup**            | 10-step resource cleanup in `finally` block                             | N/A                                                           |
| **Progress tracking**  | 30s summarization via forked API call                                   | N/A                                                           |
| **Orchestration**      | 4-phase workflow (Research → Synthesis → Implementation → Verification) | N/A                                                           |

### What Tau Has That Claude Code Doesn't

1. **Persistent state via Postgres checkpointer** — Claude Code uses transcript files; Tau has structured state persistence with LangGraph checkpoints
2. **Server-side execution** — Tau's agent runs on NestJS, enabling multi-user concurrency without process isolation
3. **Browser-native filesystem** — Tau's RPC bridge to browser virtual FS is architecturally more flexible than Claude Code's local filesystem
4. **Kernel-specific tool sets** — Tau's `ToolService.getTools(choice)` provides domain-specific tool surfaces per CAD kernel
5. **Geometry analysis tooling** — `@taucad/testing` provides geometric validation no coding agent has

### Vision Policy Alignment

The coordinator pattern maps directly to Vision Phase 3:

| Vision Phase 3 Concept                 | Claude Code Implementation                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| "Domain-specific AI agents"            | Built-in agent types with specialized system prompts                                |
| "Coordinating through a systems agent" | Coordinator mode — main agent becomes pure orchestrator                             |
| "Cross-discipline constraints"         | Self-contained worker prompts with explicit constraint specifications               |
| "Automated iteration"                  | `<task-notification>` result aggregation → coordinator synthesizes → dispatches fix |

## Recommendations

| #   | Action                                                                                                                                                                                                                                              | Priority | Effort | Impact | Vision Phase |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ | ------------ |
| R1  | **Adopt coordinator orchestration model** — implement a `coordinatorAgent` graph node that dispatches self-contained worker prompts and receives `<task-notification>` results as structured messages; use LangGraph's subgraph pattern for workers | P0       | High   | High   | Phase 3      |
| R2  | **Implement context isolation layer** — create `createSubagentContext()` equivalent that clones tool state, isolates mutation callbacks, and links AbortControllers for parent-child lifecycle management                                           | P0       | Medium | High   | Phase 3      |
| R3  | **Add `AgentTool` to Tau's tool set** — a tool that spawns subagents with `prompt`, `subagent_type`, `model`, and `run_in_background` parameters, returning results via structured messages                                                         | P0       | High   | High   | Phase 3      |
| R4  | **Implement `<task-notification>` result aggregation** — subagent results arrive as structured messages in the coordinator's conversation with status, summary, result, and usage metadata                                                          | P1       | Medium | High   | Phase 3      |
| R5  | **Add domain-specific agent types for CAD** — `mechanical-agent`, `analysis-agent`, `firmware-agent` with kernel-specific tool sets and system prompts, matching Vision Phase 3 domain specialization                                               | P1       | Medium | High   | Phase 3      |
| R6  | **Implement 30s progress summarization** — periodically generate 3-5 word progress summaries for background subagents, displayed in the chat UI                                                                                                     | P2       | Low    | Medium | Phase 3      |
| R7  | **Add agent cleanup protocol** — 10-step resource cleanup in `finally` blocks covering MCP connections, file caches, hooks, orphaned tasks, and transcript state                                                                                    | P2       | Medium | Medium | Phase 3      |
| R8  | **Reference filesystem mailbox pattern** — for Phase 3 team coordination, use `.tau/agent-mailbox/` with file-based message queues between persistent agent sessions                                                                                | P3       | Medium | Medium | Phase 3      |
| R9  | **Reference fork cache sharing** — for parallel subagents working on the same conversation, use byte-identical API prefixes with placeholder tool_results for prompt cache optimization                                                             | P3       | High   | Medium | Phase 3      |

## Diagrams

### Coordinator Mode Data Flow

```
User Message
    │
    ▼
Coordinator Agent (orchestrator prompt)
    │
    ├─── spawn Worker A (Research) ─── self-contained prompt ──→ [reads codebase]
    │                                                              │
    ├─── spawn Worker B (Research) ─── self-contained prompt ──→ [reads codebase]
    │                                                              │
    ▼                                                              ▼
<task-notification A>                              <task-notification B>
    │                                                              │
    └──────────────────── Coordinator ◄────────────────────────────┘
                              │
                        (Synthesis phase)
                              │
                    ├─── spawn Worker C (Implementation)
                    │         │
                    ▼         ▼
              <task-notification C>
                    │
              (Verification phase)
                    │
              spawn Worker D (Verification) ──→ run tests
                    │
              <task-notification D>
                    │
                    ▼
              Final Response to User
```

### Context Isolation Layers

```
Parent Agent
├── readFileState (LRU)     ──clone──→  Subagent readFileState (independent)
├── setAppState             ──isolate──→ no-op (child can't mutate parent)
├── setAppStateForTasks     ──share──→   same store (task visibility)
├── abortController         ──link──→    child-linked (parent cascades)
├── toolDecisions           ──isolate──→ undefined (fresh permissions)
├── UI callbacks            ──isolate──→ undefined (no parent UI access)
└── agentId                 ──new──→     fresh UUID
```

## References

- Source: `repos/claude-code/src/tools/AgentTool/` (spawning mechanism)
- Source: `repos/claude-code/src/coordinator/` (orchestration mode)
- Source: `repos/claude-code/src/utils/swarm/` (team backends)
- Source: `repos/claude-code/src/tasks/` (task lifecycle)
- Source: `repos/claude-code/src/tools/SendMessageTool/` (inter-agent comms)
- Tau: `apps/api/app/api/chat/chat.service.ts` (single-agent architecture)
- Tau: `apps/api/app/api/chat/chat.controller.ts` (agent execution)
- Vision: `docs/policy/vision-policy.md` (Phase 3 multi-agent)
- Related: `docs/research/claude-code-architecture-mining.md`
