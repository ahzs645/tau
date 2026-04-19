---
title: 'Claude Code Skill Injection Techniques'
description: 'Comprehensive analysis of Claude Code skill injection, memory persistence, and conditional activation patterns compared to Tau current system, with actionable adoption recommendations.'
status: active
created: '2026-04-01'
updated: '2026-04-01'
category: comparison
related:
  - docs/policy/context-engineering-policy.md
  - docs/research/context-injection-architecture.md
  - docs/research/claude-code-architecture-mining.md
  - docs/research/claude-code-prompting-techniques.md
---

# Claude Code Skill Injection Techniques

Comprehensive analysis of how Claude Code discovers, loads, activates, and injects skills into the agent context — compared against Tau's `.tau/skills/` system — to identify specific techniques that can improve Tau's agentic coding performance.

## Executive Summary

Claude Code's skill system is architecturally richer than Tau's in seven key dimensions: (1) conditional activation via `paths:` glob patterns, (2) five-source discovery hierarchy, (3) delta-based injection that avoids re-sending known skills, (4) post-compact re-injection with per-skill token caps, (5) variable substitution (`${CLAUDE_SKILL_DIR}`) enabling self-referencing, (6) skill hooks that intercept tool lifecycle events, and (7) auto-extracted persistent memory that learns from conversations. Tau's skill system correctly implements progressive disclosure (metadata-only injection, full content on demand) but lacks conditional activation, post-compact preservation, and memory extraction. Six recommendations are proposed, three of which require no external dependency changes.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Finding 1: Skill Definition Format](#finding-1-skill-definition-format)
- [Finding 2: Five-Source Discovery Hierarchy](#finding-2-five-source-discovery-hierarchy)
- [Finding 3: Conditional and Dynamic Activation](#finding-3-conditional-and-dynamic-activation)
- [Finding 4: Skill-to-Prompt Injection Pipeline](#finding-4-skill-to-prompt-injection-pipeline)
- [Finding 5: Token Budget Management](#finding-5-token-budget-management)
- [Finding 6: Post-Compact Preservation](#finding-6-post-compact-preservation)
- [Finding 7: Memory Persistence and Auto-Learning](#finding-7-memory-persistence-and-auto-learning)
- [Tau Comparison](#tau-comparison)
- [Recommendations](#recommendations)

## Problem Statement

Tau's context injection architecture research identified that skills load once per agent invocation and never refresh, there is no conditional activation by file type, and no post-compact preservation. The deepagents middleware has been replaced by `client-context.middleware.ts` which assembles context from the browser-provided `ContextPayload`. This is a cleaner architecture (zero RPC round-trips) but still misses key patterns that Claude Code uses to maximize skill relevance while minimizing context overhead.

## Methodology

1. Read Claude Code `src/skills/loadSkillsDir.ts` (1058 lines), `bundledSkills.ts`, `src/utils/skills/skillChangeDetector.ts`, `src/utils/argumentSubstitution.ts`, `src/utils/promptShellExecution.ts` in full
2. Read Claude Code `src/tools/SkillTool/SkillTool.ts` (933 lines) and `src/tools/SkillTool/prompt.ts` (196 lines)
3. Read Claude Code `src/services/compact/compact.ts` post-compact skill re-injection
4. Read Claude Code `src/memdir/` memory system (memdir.ts, memoryTypes.ts, findRelevantMemories.ts, agentMemory.ts)
5. Read Claude Code `src/services/extractMemories/` auto-learning system
6. Compared against Tau's `client-context.middleware.ts` and `ContextPayload` schema

## Finding 1: Skill Definition Format

### YAML Frontmatter Schema

Claude Code skills are `SKILL.md` files inside named directories with a rich YAML frontmatter schema:

| Field                      | Type                 | Purpose                                                              |
| -------------------------- | -------------------- | -------------------------------------------------------------------- |
| `description`              | string               | Shown in skill catalog for model discovery                           |
| `when_to_use`              | string               | Model-facing guidance for auto-invocation                            |
| `allowed-tools`            | string[]             | Tools auto-permitted when skill is active                            |
| `paths`                    | string[]             | Glob patterns — skill only activates when matching files are touched |
| `context`                  | `'inline' \| 'fork'` | Inline expands into conversation; fork runs as sub-agent             |
| `agent`                    | string               | Agent type for fork mode                                             |
| `model`                    | string               | Model override per-skill                                             |
| `effort`                   | string               | Thinking depth override                                              |
| `hooks`                    | object               | Lifecycle hooks (PreToolUse, PostToolUse, Stop)                      |
| `arguments`                | string[]             | Named argument definitions for `$arg` substitution                   |
| `user-invocable`           | boolean              | Whether user can type `/skill-name`                                  |
| `disable-model-invocation` | boolean              | Prevent auto-invocation                                              |
| `shell`                    | string               | Shell for embedded `!` backtick commands                             |
| `version`                  | string               | Skill version                                                        |

**Source**: `repos/claude-code/src/utils/frontmatterParser.ts:10-58`

### Architectural Principle

The frontmatter is the skill's full contract — it controls discovery, activation, permissions, execution context, model routing, and lifecycle hooks before a single line of the markdown body is read. This is a "declaration-over-code" pattern.

### Tau Comparison

Tau's skill format uses the same `SKILL.md` directory convention but only supports `name`, `description`, and `path` in the metadata. No conditional activation, permission grants, model overrides, or lifecycle hooks.

## Finding 2: Five-Source Discovery Hierarchy

### Discovery Sources (Priority Order)

| Priority    | Source     | Path                                  | Use Case                                |
| ----------- | ---------- | ------------------------------------- | --------------------------------------- |
| 1 (highest) | Managed    | `~/.claude-managed/.claude/skills/`   | Enterprise-controlled                   |
| 2           | User       | `~/.claude/skills/`                   | Per-user global skills                  |
| 3           | Project    | `.claude/skills/` (walked up to HOME) | Project-level, git-tracked              |
| 4           | Additional | `--add-dir` flag                      | Explicitly specified                    |
| 5 (lowest)  | Legacy     | `~/.claude/commands/`                 | Deprecated format                       |
| +           | Bundled    | Compiled into binary                  | Core skills (e.g., `/batch`, `/verify`) |
| +           | MCP        | Connected MCP servers                 | Remote skill discovery                  |

**Deduplication**: resolved via `realpath()` — symlinks and overlapping paths handled cleanly. First-wins semantics: higher-priority sources shadow lower ones.

**Source**: `repos/claude-code/src/skills/loadSkillsDir.ts:638-803`

### Tau Comparison

Tau has a single source: `.tau/skills/` in the browser virtual filesystem. The `client-context.middleware.ts` reads skills from the browser-provided `ContextPayload.skills` array (assembled at the UI layer). There is no user-global, enterprise-managed, or additional directory support.

## Finding 3: Conditional and Dynamic Activation

### `paths:` Frontmatter — Glob-Based Conditional Skills

Skills with `paths:` frontmatter are NOT immediately loaded. They are stored in a `conditionalSkills` Map and activated only when file operations match their glob patterns:

```
paths:
  - "**/*.test.ts"
  - "**/*.spec.ts"
```

This skill would only activate when the agent reads, writes, or edits a test file. Once activated, it stays available for the session. Uses the `ignore` library (gitignore-style matching).

**Source**: `repos/claude-code/src/skills/loadSkillsDir.ts:997-1058`

### Dynamic Discovery from File Operations

`discoverSkillDirsForPaths()` is called whenever the model touches files. It walks from the file's parent directory UP to CWD, checking for `.claude/skills/` directories at each level. New skill directories discovered this way are loaded immediately.

Key behaviors:

- Cached: checked directories remembered in a Set to avoid re-statting
- Gitignore-filtered: directories inside gitignored paths (e.g., `node_modules/`) skipped
- Deepest-first sorting: skills closer to the touched file take precedence

**Source**: `repos/claude-code/src/skills/loadSkillsDir.ts:861-915`

### Hot-Reload via File Watching

`skillChangeDetector` uses chokidar to watch skill directories:

- 300ms reload debounce
- 1000ms file stability threshold
- On change: clears all skill caches, fires `ConfigChange` hooks, re-emits discovery signal

**Source**: `repos/claude-code/src/utils/skills/skillChangeDetector.ts:85-141`

### Tau Gap

Tau has no conditional activation, no dynamic discovery from file operations, and no file watching. All skills are loaded once from the browser-provided `ContextPayload.skills` array at agent startup.

## Finding 4: Skill-to-Prompt Injection Pipeline

### Catalog Injection (Metadata Only)

Skills appear in the prompt as a skill listing attachment — a bulleted list with name, description, and `whenToUse`:

```
- commit: Commit changes to git - Use when the user wants to commit
- review-pr: Review a pull request - Use for PR reviews
```

This is injected as a delta — only new skills since the last injection are sent. A `sentSkillNames` Set tracks what has already been announced.

**Source**: `repos/claude-code/src/tools/SkillTool/prompt.ts:70-171`

### SkillTool Invocation

The model invokes skills via `SkillTool({ skill: "name", args: "..." })` — a standard `tool_use` call. On invocation:

1. Skill content loaded via `getPromptForCommand()`
2. Variable substitution: `${CLAUDE_SKILL_DIR}` → skill's directory path, `${CLAUDE_SESSION_ID}` → session ID
3. Argument substitution: `$ARGUMENTS`, `$0`, `$1`, named args like `$foo`
4. Shell command execution: `!` backtick syntax runs embedded shell commands (security: blocked for MCP-sourced skills)
5. Content injected as user message(s) into the conversation

**Source**: `repos/claude-code/src/skills/loadSkillsDir.ts:344-399`

### Inline vs Fork Execution

Two execution paths:

- **Inline** (default): Skill content expanded into the current conversation as user messages
- **Fork** (`context: 'fork'`): Runs in an isolated sub-agent via `runAgent()` with independent context, model, and effort. Results returned as tool output to the parent.

### Skill Permission Gating

Skills that grant tool permissions (`allowed-tools`), register hooks, or override the model require explicit user permission before execution. A `SAFE_SKILL_PROPERTIES` allowlist determines which skills auto-permit — new properties added to the schema automatically require permission until reviewed. Security-by-default.

**Source**: `repos/claude-code/src/tools/SkillTool/SkillTool.ts:871-933`

### Tau Comparison

Tau correctly implements progressive disclosure — skills metadata in the prompt, full content on demand via `read_file`. However, Tau lacks:

- Delta-based injection (skills are re-sent on every model call via middleware)
- Variable substitution (`${TAU_SKILL_DIR}` for companion file references)
- Inline vs fork execution (all skills are inline)
- Permission gating for skills that grant tool access
- Argument substitution

## Finding 5: Token Budget Management

### 1% Context Budget for Skill Catalog

The skill listing is budgeted at 1% of the context window (in characters):

```typescript
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01;
export const DEFAULT_CHAR_BUDGET = 8_000;
export const MAX_LISTING_DESC_CHARS = 250;
```

When the budget is exceeded:

1. Bundled skills are never truncated
2. User/project skills have descriptions truncated
3. In extreme cases, non-bundled skills go name-only

**Source**: `repos/claude-code/src/tools/SkillTool/prompt.ts:20-29`

### Frontmatter-Only Token Estimation

Only frontmatter (name, description, whenToUse) counts toward the budget — full skill content is loaded only on invocation. Token estimation uses `roughTokenCountEstimation(frontmatterText)`.

### Tau Comparison

Tau has no explicit token budget for skill metadata. The `skillsSystemPrompt` template in `client-context.middleware.ts` includes all skills without truncation or budget management.

## Finding 6: Post-Compact Preservation

### Problem: Skills Lost After Compaction

When context is compacted (summarized to fit the window), injected skill content disappears from the conversation. Claude Code solves this with explicit post-compact re-injection.

### Invoked Skill Tracking

`addInvokedSkill()` stores the full content of every invoked skill keyed by `agentId:skillName`. This state **intentionally survives compaction** — the code explicitly documents: "Skill content must survive across multiple compactions."

**Source**: `repos/claude-code/src/bootstrap/state.ts:1501-1563`

### Post-Compact Re-Injection

After compaction, `createSkillAttachmentIfNeeded()`:

1. Reads all invoked skills for the current agent
2. Sorts by most-recent-first (budget pressure drops least-relevant first)
3. Truncates each skill to 5,000 tokens (`POST_COMPACT_MAX_TOKENS_PER_SKILL`)
4. Total budget: 25,000 tokens across all skills (`POST_COMPACT_SKILLS_TOKEN_BUDGET`)
5. Creates an `invoked_skills` attachment message

The truncation marker tells the model: `"[... skill content truncated for compaction; use Read on the skill path if you need the full text]"`

**Source**: `repos/claude-code/src/services/compact/compact.ts:1494-1534`

### Tau Gap

Tau's compaction middleware (`compaction.middleware.ts`) summarizes context when it exceeds `DEFAULT_TRIGGER_FRACTION = 0.85` of the context window. Skill content injected earlier in the conversation is summarized away with no re-injection mechanism. After compaction, the agent loses access to previously invoked skills.

## Finding 7: Memory Persistence and Auto-Learning

### The Memdir Concept

Claude Code maintains persistent memory as plain markdown files at `~/.claude/projects/<sanitized-git-root>/memory/`:

- `MEMORY.md` is the index — one-line pointers to topic files
- Each topic file has frontmatter: `name`, `description`, `type`
- Capped at 200 lines / 25KB to prevent bloat

### Four-Type Memory Taxonomy

| Type        | Purpose                       | Example                                          |
| ----------- | ----------------------------- | ------------------------------------------------ |
| `user`      | Role, goals, preferences      | "Prefers functional patterns over OOP"           |
| `feedback`  | Corrections AND confirmations | "Never use `any` type — fix underlying issues"   |
| `project`   | Ongoing work, decisions       | "Migration to Vite 8 in progress, do not revert" |
| `reference` | Pointers to external systems  | "CI dashboard: grafana.internal/d/abc"           |

**Explicitly excluded** (even when user asks): code patterns, architecture, git history, file structure, debugging solutions, ephemeral task details.

**Source**: `repos/claude-code/src/memdir/memoryTypes.ts:14-195`

### Memory Drift Prevention

The prompt explicitly warns: "The memory says X exists is not the same as X exists now." Before acting on memory claims, the agent must verify: if a file path, check it exists; if a function or flag, grep for it.

### LLM-Powered Memory Retrieval

On each query, `findRelevantMemories()`:

1. Scans memory directory (up to 200 files, newest-first)
2. Reads frontmatter-only (first 30 lines) for each file
3. Sends manifest + user query to Sonnet
4. Sonnet selects up to 5 relevant memories
5. Returns paths + mtime for injection

### Auto-Learning from Conversations

`extractMemories` runs as a forked subagent at the end of each query loop:

- Analyzes recent messages for memorable information
- Follows the four-type taxonomy
- Writes memory files with proper frontmatter
- Updates MEMORY.md index
- Mutual exclusion: skips if the main agent already wrote to memory
- Throttled: configurable frequency (default: every turn)

**Source**: `repos/claude-code/src/services/extractMemories/extractMemories.ts`

### Memory Consolidation (DreamTask)

Background consolidation runs when: hours since last consolidation ≥ 24 AND transcript count ≥ 5.

Four phases:

1. **Orient** — read existing memory
2. **Gather** — review daily logs, check for drift
3. **Consolidate** — write/update files, merge duplicates, resolve contradictions
4. **Prune** — keep MEMORY.md under 200 lines / 25KB

### Tau Comparison

Tau has `.tau/AGENTS.md` loaded via `client-context.middleware.ts` as `<agent_memory>`. The agent can edit this file via `edit_file`. However:

| Feature                  | Claude Code                                   | Tau                               |
| ------------------------ | --------------------------------------------- | --------------------------------- |
| **Memory taxonomy**      | Four types with structured frontmatter        | Free-form markdown                |
| **Auto-extraction**      | Forked subagent after each turn               | Not implemented                   |
| **Memory retrieval**     | LLM-powered (Sonnet selects 5 relevant files) | Full injection (entire AGENTS.md) |
| **Drift prevention**     | "Verify before acting" + age caveat           | Not present                       |
| **Memory consolidation** | DreamTask (24h / 5 sessions)                  | Not implemented                   |
| **Storage**              | Multiple topic files in directory             | Single file                       |
| **Index**                | MEMORY.md (200 lines, 25KB cap)               | No index                          |
| **Multi-scope**          | User / project / local                        | Project only                      |
| **Exclusion rules**      | Explicit anti-save list                       | None                              |

## Tau Comparison

### Side-by-Side Skill Architecture

| Aspect                        | Claude Code                                                | Tau                            |
| ----------------------------- | ---------------------------------------------------------- | ------------------------------ |
| **Discovery sources**         | 5 (managed/user/project/additional/legacy) + bundled + MCP | 1 (browser ContextPayload)     |
| **Activation model**          | Always-on + conditional (`paths:`) + dynamic (walk-up)     | Always-on only                 |
| **Catalog injection**         | Delta-based, budgeted (1% context), per-entry 250-char cap | Full list on every model call  |
| **Variable substitution**     | `${CLAUDE_SKILL_DIR}`, `${CLAUDE_SESSION_ID}`, `$args`     | Not present                    |
| **Execution modes**           | Inline + fork (sub-agent)                                  | Inline only (agent reads file) |
| **Permission gating**         | Safe-properties allowlist, auto-allow/ask                  | Not present                    |
| **Skill hooks**               | PreToolUse, PostToolUse, Stop lifecycle events             | Not present                    |
| **Hot-reload**                | Chokidar file watching, 300ms debounce                     | Not present                    |
| **Post-compact preservation** | Invoked skills re-injected (5K/skill, 25K total)           | Not present                    |
| **Token budgeting**           | 1% of context for catalog, frontmatter-only estimation     | No budget                      |
| **Memory auto-extraction**    | Forked subagent after each turn                            | Not implemented                |
| **Memory retrieval**          | LLM-powered (5 relevant files via Sonnet)                  | Full AGENTS.md injection       |

### What Tau Already Does Well

1. **Progressive disclosure** — metadata-only catalog, full content via `read_file`
2. **Client-assembled context** — zero RPC round-trips (context from browser ContextPayload)
3. **Skill catalog format** — name/description/path listing matches Claude Code's approach
4. **Agent-editable memory** — `.tau/AGENTS.md` editable via `edit_file` tool

## Recommendations

| #   | Action                                                                                                                                                                                                                                 | Priority | Effort | Impact                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------------------- |
| R1  | **Add conditional skill activation** — support `paths:` glob frontmatter in `.tau/skills/*/SKILL.md`; evaluate globs against the current file context from `ContextPayload.snapshot`; only inject matching skills into the catalog     | P0       | Medium | High — keeps context lean and domain-specific            |
| R2  | **Add post-compact skill re-injection** — track invoked skills in agent state (survives compaction); after compaction, re-inject truncated skill content (5K/skill, 25K total) as attachment with "Read full file" fallback            | P0       | Medium | High — agents lose skill context after compaction today  |
| R3  | **Add `${TAU_SKILL_DIR}` variable substitution** — when skill content is loaded, replace `${TAU_SKILL_DIR}` with the skill's directory path, enabling companion files (type definitions, examples, templates) alongside SKILL.md       | P1       | Low    | Medium — enables richer skill packages                   |
| R4  | **Add skill catalog token budget** — cap skill catalog at 1% of context window; truncate descriptions at 250 chars; drop least-relevant skills to name-only when budget exceeded                                                       | P1       | Low    | Medium — prevents context pollution as skill count grows |
| R5  | **Add delta-based skill injection** — track which skills have been announced via a Set; only inject new skills in subsequent model calls; skip re-injection on session resume                                                          | P2       | Low    | Medium — reduces repetitive token usage                  |
| R6  | **Implement memory auto-extraction** — after each agent turn, analyze conversation for durable learnings (user preferences, project facts, corrections); write to `.tau/AGENTS.md` structured sections; throttle to avoid over-writing | P1       | High   | High — closes the biggest gap vs Claude Code             |
| R7  | **Add memory drift prevention** — inject "verify before acting on memory" caveat; add age-based staleness warnings for memories older than N days                                                                                      | P2       | Low    | Medium — prevents stale memory from causing errors       |
| R8  | **Add `allowed-tools` frontmatter** — skills that grant specific tool permissions (e.g., a "deploy" skill auto-permits deployment shell commands)                                                                                      | P2       | Medium | Medium — enables permission-aware skill packages         |
| R9  | **Add skill hooks** — allow skills to register PreToolUse/PostToolUse hooks via YAML frontmatter, enabling coding standard enforcement and output validation                                                                           | P3       | High   | Medium — extensibility for advanced workflows            |
| R10 | **Add multi-source discovery** — support user-global skills at `~/.tau/skills/` in addition to project `.tau/skills/`                                                                                                                  | P3       | Medium | Low — enables cross-project skill sharing                |

## Code Examples

### R1: Conditional Skill Activation (Tau Implementation Sketch)

```typescript
const skillsWithPaths = contextPayload.skills.filter((s) => s.paths?.length);
const activeSkills = contextPayload.skills.filter((s) => {
  if (!s.paths?.length) return true; // always-on
  const ig = ignore().add(s.paths);
  return snapshot.activeFile && ig.ignores(snapshot.activeFile);
});
```

### R2: Post-Compact Skill Re-Injection (Tau Implementation Sketch)

```typescript
const POST_COMPACT_MAX_PER_SKILL = 5000; // tokens
const POST_COMPACT_TOTAL_BUDGET = 25000;

const reInjection = invokedSkills
  .sort((a, b) => b.invokedAt - a.invokedAt)
  .reduce(
    (acc, skill) => {
      if (acc.totalTokens >= POST_COMPACT_TOTAL_BUDGET) return acc;
      const truncated = truncateToTokens(skill.content, POST_COMPACT_MAX_PER_SKILL);
      acc.skills.push({ ...skill, content: truncated });
      acc.totalTokens += estimateTokens(truncated);
      return acc;
    },
    { skills: [], totalTokens: 0 },
  );
```

## References

- Source: `repos/claude-code/src/skills/loadSkillsDir.ts` (skill discovery and loading)
- Source: `repos/claude-code/src/tools/SkillTool/` (skill invocation)
- Source: `repos/claude-code/src/services/compact/compact.ts` (post-compact re-injection)
- Source: `repos/claude-code/src/memdir/` (memory system)
- Source: `repos/claude-code/src/services/extractMemories/` (auto-learning)
- Tau: `apps/api/app/api/chat/middleware/client-context.middleware.ts` (current injection)
- Tau: `libs/chat/src/schemas/context-payload.schema.ts` (ContextPayload schema)
- Related: `docs/research/context-injection-architecture.md`
- Policy: `docs/policy/context-engineering-policy.md`
