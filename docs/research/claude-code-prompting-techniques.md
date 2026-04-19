---
title: 'Claude Code Prompting Techniques'
description: 'Actionable prompting, context assembly, and prompt caching patterns from Claude Code that Tau can directly apply to improve agentic coding performance.'
status: active
created: '2026-04-01'
updated: '2026-04-02'
category: comparison
related:
  - docs/policy/context-engineering-policy.md
  - docs/research/context-injection-architecture.md
  - docs/research/claude-code-architecture-mining.md
  - docs/research/claude-code-subagent-architecture.md
---

# Claude Code Prompting Techniques

Actionable analysis of Claude Code's system prompt construction, context assembly pipeline, prompt caching strategies, memory architecture, coordinator orchestration, verification patterns, and context compaction — compared against Tau's current implementation — to identify concrete techniques that can directly improve Tau's agentic CAD coding performance.

## Executive Summary

Claude Code's prompting architecture uses three key techniques Tau lacks: (1) a static/dynamic boundary marker that enables global prompt cache sharing, saving significant API costs; (2) two-channel context injection where CLAUDE.md goes in user messages (not the system prompt) to avoid cache busting; and (3) eval-driven prompt iteration with specific anti-gold-plating rules that prevent the most common agentic coding failures. Beyond these core patterns, deep mining of the full codebase revealed ten additional architectural patterns — coordinator orchestration with anti-delegation enforcement, a four-type XML-structured memory taxonomy with bidirectional learning, context compaction with verbatim quote anchoring, rationalization inoculation for verification agents, subagent context stripping saving ~5-15 Gtok/week, communication channel contracts, audience-aware prompt branching, precedent-based disambiguation, runtime-validated pre-conditions, and meta-prompting for agent/skill generation. Tau's monolithic `getCadSystemPrompt()` can adopt these patterns with modest refactoring.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Finding 1: Static/Dynamic Prompt Separation](#finding-1-staticdynamic-prompt-separation)
- [Finding 2: Two-Channel Context Injection](#finding-2-two-channel-context-injection)
- [Finding 3: Anti-Gold-Plating Rules](#finding-3-anti-gold-plating-rules)
- [Finding 4: Tool Prompt Architecture](#finding-4-tool-prompt-architecture)
- [Finding 5: Prompt Cache Optimization Patterns](#finding-5-prompt-cache-optimization-patterns)
- [Finding 6: Context Size Management](#finding-6-context-size-management)
- [Finding 7: Dynamic Section Registry](#finding-7-dynamic-section-registry)
- [Finding 8: Environment Self-Awareness](#finding-8-environment-self-awareness)
- [Finding 9: Coordinator Orchestration Patterns](#finding-9-coordinator-orchestration-patterns)
- [Finding 10: Memory Architecture](#finding-10-memory-architecture)
- [Finding 11: Context Compaction](#finding-11-context-compaction)
- [Finding 12: Verification Agent — Rationalization Inoculation](#finding-12-verification-agent--rationalization-inoculation)
- [Finding 13: Subagent Context Engineering](#finding-13-subagent-context-engineering)
- [Finding 14: Communication Channel Contracts](#finding-14-communication-channel-contracts)
- [Finding 15: Audience-Aware Prompt Branching](#finding-15-audience-aware-prompt-branching)
- [Finding 16: Precedent-Based Disambiguation](#finding-16-precedent-based-disambiguation)
- [Finding 17: Runtime-Validated Pre-Conditions](#finding-17-runtime-validated-pre-conditions)
- [Finding 18: Meta-Prompting](#finding-18-meta-prompting)
- [Tau Comparison](#tau-comparison)
- [Recommendations](#recommendations)

## Problem Statement

Tau's context engineering policy defines best practices (right altitude, single source of truth, examples over rules, progressive disclosure), but the current implementation in `cad-agent.prompt.ts` is a monolithic tagged string assembled once per agent invocation. The context injection architecture research identified seven gaps vs Cursor's model. This document examines Claude Code — a production agentic system handling millions of daily sessions — to extract specific prompting techniques that Tau can adopt to improve agent performance and reduce costs.

## Methodology

1. Read Claude Code `src/constants/prompts.ts` (~915 lines), `systemPromptSections.ts`, `xml.ts`, `system.ts`, `toolLimits.ts` in full
2. Traced context assembly pipeline: `getSystemPrompt()` → `appendSystemContext()` → `prependUserContext()` → `buildSystemPromptBlocks()` → API call
3. Analyzed tool prompt contributions via `prompt()` method across all 35+ tools
4. Analyzed coordinator mode (`src/coordinator/coordinatorMode.ts`), memory system (`src/memdir/`), context compaction (`src/services/compact/prompt.ts`), built-in agents (`src/tools/AgentTool/built-in/`), security review (`src/commands/security-review.ts`), bundled skills (`src/skills/bundled/`), and plugin agent loading (`src/utils/plugins/loadPluginAgents.ts`)
5. Compared against Tau's `getCadSystemPrompt()`, `client-context.middleware.ts`, `prompt-caching.middleware.ts`, and `inject-snapshot-context.ts`

## Finding 1: Static/Dynamic Prompt Separation

### The Boundary Marker Pattern

Claude Code's system prompt is returned as a `string[]` (not a concatenated string). A sentinel marker `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` splits the array into two halves:

**Before boundary (static, globally cacheable):**

1. Identity prefix ("You are Claude Code...")
2. System rules (markdown format, permissions, compression notice)
3. Coding task behavior (code style, anti-gold-plating)
4. Actions (reversibility, blast radius, confirmation)
5. Tool usage (preference hierarchy, parallelism)
6. Tone and style
7. Output efficiency

**After boundary (dynamic, per-session):**

1. Session guidance (agent/skill availability)
2. Memory prompt (behavioral instructions)
3. Environment info (CWD, platform, model ID)
4. Language preference
5. MCP instructions
6. Token budget guidance

**Source**: `repos/claude-code/src/constants/prompts.ts:560-577`

### Why This Matters

The `splitSysPromptPrefix()` function creates cache blocks with different scopes:

| Block          | Content                            | Cache Scope                     |
| -------------- | ---------------------------------- | ------------------------------- |
| Static prefix  | Identity through output efficiency | `'global'` (cross-organization) |
| Dynamic suffix | Session-specific content           | `null` (never cached)           |

This enables ~70% of the system prompt to be cached globally across all Claude Code users. The comment warns: `=== BOUNDARY MARKER - DO NOT MOVE OR REMOVE ===`.

### Tau Gap

Tau's `createCachedSystemMessage()` wraps the entire `getCadSystemPrompt()` output as a single `SystemMessage` with `cache_control: { type: 'ephemeral' }`. There is no static/dynamic split. The 2-breakpoint strategy in `prompt-caching.middleware.ts` places breakpoints on the system message and last conversation message, but the system message itself is monolithic — any per-session content (kernel config, mode, testing state) invalidates the entire cache.

## Finding 2: Two-Channel Context Injection

### System Prompt vs User Message Channels

Claude Code uses two distinct channels for context injection:

**Channel 1 — System prompt**: Git status (branch, recent commits, short status truncated at 2000 chars). Small, stable, always relevant.

**Channel 2 — First user message**: CLAUDE.md content wrapped in `<system-reminder>` tags with the caveat: "IMPORTANT: this context may or may not be relevant to your tasks."

**Source**: `repos/claude-code/src/utils/api.ts:437-469`

### The Rationale

CLAUDE.md content is:

- Large (potentially tens of KB)
- Variable (user edits between sessions)
- Not always relevant (project memory may not apply to the current task)

Injecting it as a user message means it never touches the system prompt cache. The `<system-reminder>` wrapper + "may or may not be relevant" caveat prevents the model from always acting on stale or irrelevant memory content.

### CLAUDE.md Loading Hierarchy

Four tiers loaded in ascending priority (later = higher attention):

1. **Managed** (`/etc/claude-code/CLAUDE.md`) — Enterprise-controlled
2. **User** (`~/.claude/CLAUDE.md`) — Per-user global
3. **Project** (`CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md` — walked from root to CWD)
4. **Local** (`CLAUDE.local.md`) — Private, gitignored

This exploits the model's recency bias — files loaded later in context receive more attention. The instruction header states: "These instructions OVERRIDE any default behavior."

**Source**: `repos/claude-code/src/utils/claudemd.ts:1-10`

### Tau Gap

Tau injects both skills and memory via `client-context.middleware.ts` into the `systemMessage` using `.concat()`. This means:

- Memory content (`.tau/AGENTS.md`) is part of the system prompt, potentially busting the cache on every edit
- There is no "may or may not be relevant" caveat
- No four-tier priority hierarchy

## Finding 3: Anti-Gold-Plating Rules

### The Most Prescriptive Prompt Section

Claude Code's system prompt contains three explicit anti-gold-plating rules that are the most detailed behavioral constraints in the entire prompt:

1. "Don't add features, refactor code, or make 'improvements' beyond what was asked..."
2. "Don't add error handling, fallbacks, or validation for scenarios that can't happen..."
3. "Don't create helpers, utilities, or abstractions for one-time operations..."

**Source**: `repos/claude-code/src/constants/prompts.ts:200-213`

### Eval-Driven Iteration

The codebase contains explicit eval annotations on prompt changes:

```
// H1 (verify function/file claims): 0/2 → 3/3 via appendSystemPrompt
// memory-prompt-iteration case 3, 0/2 → 3/3
// Token budget (H6a): merged old bullets 1+2, tightened both. Old 4 lines
// were ~70 tokens; new 4 lines are ~73 tokens. Net ~+3.
```

Every prompt change cites specific eval results. This transforms prompting from art to engineering.

### Numeric Length Anchors

An ant-only experiment uses quantitative length limits instead of qualitative guidance:

> "Length limits: keep text between tool calls to ≤25 words. Keep final responses to ≤100 words unless the task requires more detail."

Research showed ~1.2% output token reduction vs qualitative "be concise."

**Source**: `repos/claude-code/src/constants/prompts.ts:528-537`

### Tau Gap

Tau's `<code_standards>` section inherits per-kernel rules but does not include universal anti-gold-plating constraints. The system prompt includes prescriptive step lists in `<workflow>` that Tau's own context engineering policy flags as an anti-pattern ("obvious sequences"). No eval annotations exist on prompt changes.

## Finding 4: Tool Prompt Architecture

### Self-Contained Tool Prompts

Every Claude Code tool has a `prompt()` method returning its complete description. The system prompt references tools by name but never duplicates their descriptions. This is the cleanest implementation of "single source of truth" — tool description = HOW, system prompt = WHEN.

### Tool Preference Hierarchy

The system prompt explicitly steers the model toward specialized tools over `Bash`. The Bash tool prompt (~370 lines) contains explicit "do NOT use Bash for X, use Y instead" using an **"X (NOT Y)" pattern**:

- `File search: Use Glob (NOT find or ls)`
- `Content search: Use Grep (NOT grep or rg)`
- `Read files: Use Read (NOT cat/head/tail)`
- `Edit files: Use Edit (NOT sed/awk)`
- `Write files: Use Write (NOT echo >/cat <<EOF)`
- `Communication: Output text directly (NOT echo/printf)`

Additionally, search tools escalate to `AgentTool` for multi-round exploration: "When doing an open-ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead."

**Source**: `repos/claude-code/src/tools/BashTool/prompt.ts:280-363`

### searchHint — Keyword Discovery

Tools declare a `searchHint` string (3-10 words) for deferred tool discovery:

- WebSearch: `'search the web for current information'`
- GrepTool: `'search file contents with regex (ripgrep)'`
- NotebookEditTool: `'edit Jupyter notebook cells (.ipynb)'`

### Three-Tier Result Size Defense

| Tier               | Limit             | Purpose                        |
| ------------------ | ----------------- | ------------------------------ |
| Per-tool           | 50K chars default | Prevent individual tool floods |
| Per-result         | 100K tokens       | Absolute cap on any result     |
| Per-turn aggregate | 200K chars        | Cap across parallel tool calls |

When exceeded, results are persisted to disk and replaced with preview + file path.

**Source**: `repos/claude-code/src/constants/toolLimits.ts:13-49`

### Tau Gap

Tau's tool descriptions are defined in `apps/api/app/api/tools/tools/tool-*.ts` as `description` strings on LangChain `StructuredTool` instances. The system prompt correctly follows SSOT by referencing tools by name in `<workflow>`, not re-explaining them. However, Tau lacks:

- Explicit tool preference hierarchy (no "use X instead of shell for Y")
- `searchHint` for deferred discovery
- Three-tier result size defense (tool result trimming exists but is per-tool, not aggregate)
- Cross-tool escalation paths (search tools → agent for complex queries)

## Finding 5: Prompt Cache Optimization Patterns

### Dynamic Content Migration

Claude Code systematically migrated cache-busting content OUT of tool descriptions and the system prompt:

| Migration          | Before                              | After                          | Impact                                          |
| ------------------ | ----------------------------------- | ------------------------------ | ----------------------------------------------- |
| Agent list         | Tool description                    | `<system-reminder>` attachment | 10.2% fleet cache_creation tokens saved         |
| MCP instructions   | System prompt section               | Per-turn attachment delta      | Eliminates cache bust on MCP connect/disconnect |
| Sandbox temp paths | Per-UID `/private/tmp/claude-1001/` | Normalized `$TMPDIR`           | Identical across users                          |

**Source**: `repos/claude-code/src/tools/AgentTool/prompt.ts:54-57`

### `DANGEROUS_uncachedSystemPromptSection`

Dynamic sections that must recompute every turn are explicitly marked with a naming convention that forces developers to justify cache-busting:

```typescript
DANGEROUS_uncachedSystemPromptSection(
  'mcp_instructions',
  () => getMcpInstructionsSection(mcpClients),
  'MCP servers connect/disconnect between turns', // mandatory reason
);
```

### Prompt Cache Break Detection

A sophisticated two-phase detection system (`src/services/api/promptCacheBreakDetection.ts`) tracks 15+ dimensions that could cause cache invalidation — system hash, tools hash, model, fast mode, betas, effort value, and more. It uses dual-threshold anomaly detection (absolute minimum of 2,000 tokens + 5% relative drop) with source-aware isolation (each agent gets its own tracking state). When a break is detected, it attributes root cause: client-side change, TTL expiration, or server-side invalidation.

**Source**: `repos/claude-code/src/services/api/promptCacheBreakDetection.ts:28-698`

### Tau Gap

Tau's `prompt-caching.middleware.ts` uses a 2-breakpoint strategy (system message + last message), which is sound. But the system prompt itself contains per-kernel content (`<code_standards>`, `<canonical_example>`) that varies across kernels, busting the cache when users switch kernels mid-session. There is no migration pattern for moving dynamic content out of the system prompt, and no cache break detection or attribution system.

## Finding 6: Context Size Management

### Git Status Truncation with Self-Service Fallback

Git status is truncated at 2000 chars with an explicit fallback instruction: "truncated because it exceeds 2k characters. If you need more information, run 'git status' using BashTool."

This is the "progressive disclosure" pattern from Tau's context engineering policy applied at the implementation level.

### `<system-reminder>` as Universal Container

Claude Code uses a single XML tag `<system-reminder>` for all system-injected context that appears in user messages:

- CLAUDE.md content
- Deferred tool announcements
- Agent list announcements
- MCP instructions delta
- Skill discovery attachments

The system prompt tells the model: "Tool results and user messages may include `<system-reminder>` tags. They are automatically added by the system, and bear no direct relation to the specific tool results or user messages."

### Tau Gap

Tau uses `<editor_context>` for snapshot injection (via `inject-snapshot-context.ts`) and `<agent_memory>` for memory content. There is no universal container pattern. Adding new context types requires new XML tags and new middleware.

## Finding 7: Dynamic Section Registry

### Computed-Once, Named Sections

Claude Code's dynamic sections use a registry pattern:

```typescript
systemPromptSection('memory', () => loadMemoryPrompt());
systemPromptSection('env_info_simple', () => computeSimpleEnvInfo(model));
```

Sections are computed once per session and cached. The registry provides:

- Named sections for debugging ("which section generated this text?")
- Section-level cache invalidation (clear specific sections on `/compact`)
- Explicit `cacheBreak: true/false` classification

### Tau Gap

Tau computes the entire system prompt in `getCadSystemPrompt()` as a single string. There is no section registry, no named sections, and no per-section caching. Mid-session changes (e.g., mode switch to plan mode) require reconstructing the entire prompt.

## Finding 8: Environment Self-Awareness

### Model Self-Identification

Claude Code tells the model its own name, model ID, knowledge cutoff, and the latest model family names:

> "You are powered by the model named Claude Opus 4.6 (model ID: claude-opus-4-6-20260401). The most recent Claude model family is Claude 4.5/4.6."

It also tells the model that "Fast mode for Claude Code uses the same model with faster output. It does NOT switch to a different model."

### Undercover Mode

When running on public repos where model names shouldn't leak, ALL model name/ID references are stripped from the system prompt.

### Tau Gap

Tau does not tell the agent which model it is using. This prevents the agent from making model-aware decisions (e.g., knowing its context window size, knowledge cutoff, or capabilities).

## Finding 9: Coordinator Orchestration Patterns

### Phase-Table Decomposition

The coordinator system prompt (`src/coordinator/coordinatorMode.ts`) defines a four-phase pipeline with explicit ownership:

| Phase          | Who                | Purpose                                                           |
| -------------- | ------------------ | ----------------------------------------------------------------- |
| Research       | Workers (parallel) | Investigate codebase, find files, understand problem              |
| Synthesis      | **Coordinator**    | Read findings, understand the problem, craft implementation specs |
| Implementation | Workers            | Make targeted changes per spec, commit                            |
| Verification   | Workers            | Test changes work                                                 |

The bold **Coordinator** on Synthesis forces intellectual work to remain at the orchestration layer rather than being delegated.

**Source**: `repos/claude-code/src/coordinator/coordinatorMode.ts:199-209`

### "Never Delegate Understanding"

The most impactful anti-pattern rule in the coordinator prompt: never write "based on your findings" or "based on the research" in worker prompts. These phrases delegate synthesis to the worker instead of doing it yourself. The prompt provides contrastive examples:

**Anti-pattern (lazy delegation):**

> `Agent({ prompt: "Based on your findings, fix the auth bug" })`

**Good (synthesized spec):**

> `Agent({ prompt: "Fix the null pointer in src/auth/validate.ts:42. The user field on Session (src/auth/types.ts:15) is undefined when sessions expire but the token remains cached. Add a null check before user.id access — if null, return 401 with 'Session expired'." })`

**Source**: `repos/claude-code/src/coordinator/coordinatorMode.ts:256-268`

### Continue vs Spawn Decision Heuristic

A context-overlap decision table teaches the model to reason about whether prior context helps or pollutes:

| Situation                                             | Mechanism   | Why                                                          |
| ----------------------------------------------------- | ----------- | ------------------------------------------------------------ |
| Research explored exactly the files that need editing | Continue    | Worker already has files in context + gets a clear plan      |
| Research was broad but implementation is narrow       | Spawn fresh | Avoid dragging exploration noise; focused context is cleaner |
| Correcting a failure                                  | Continue    | Worker has the error context                                 |
| Verifying code a different worker wrote               | Spawn fresh | Verifier should see code with fresh eyes                     |
| First attempt used the wrong approach entirely        | Spawn fresh | Wrong-approach context pollutes the retry                    |

**Source**: `repos/claude-code/src/coordinator/coordinatorMode.ts:283-293`

### Purpose Statement Injection

Worker prompts include a brief purpose so downstream agents can calibrate depth: "This research will inform a PR description — focus on user-facing changes" vs "I need this to plan an implementation — report file paths, line numbers, and type signatures."

### Anti-Anthropomorphization

"Worker results and system notifications are internal signals, not conversation partners — never thank or acknowledge them." Prevents the model from wasting tokens treating task notifications as conversational partners.

### Tau Gap

Tau does not have a coordinator mode. If one is added, the phase-table, "never delegate understanding," and continue-vs-spawn heuristic are directly applicable. The purpose statement pattern could be adopted for Tau's existing skill system — skills could declare their downstream consumer to calibrate response depth.

## Finding 10: Memory Architecture

### Four-Type XML-Structured Taxonomy

Claude Code's memory system uses a closed four-type taxonomy defined with per-type XML schema:

| Type       | Scope           | When to Save                                |
| ---------- | --------------- | ------------------------------------------- |
| `user`     | Always private  | User's role, goals, preferences             |
| `feedback` | Private or team | Corrections AND confirmations of approach   |
| `project`  | Private or team | Who is doing what, why, by when             |
| `domain`   | Always team     | Technical knowledge, architecture, patterns |

Each type has `<description>`, `<when_to_save>`, `<how_to_use>`, and `<examples>` fields. The closed taxonomy prevents memory sprawl by constraining categorization.

**Source**: `repos/claude-code/src/memdir/memoryTypes.ts:37-106`

### Bidirectional Learning

The most counterintuitive memory instruction: "Record from failure AND success." The prompt warns that if the agent only saves corrections, it will "avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious." Corrections are salient; confirmations are quieter — the prompt tells the model to actively watch for them.

**Source**: `repos/claude-code/src/memdir/memoryTypes.ts:60-61`

### Body Structure Template

Each feedback memory follows a fixed format: `Rule → Why → How to apply`. The explicit rationale: "Knowing _why_ lets you judge edge cases instead of blindly following the rule."

### Temporal Normalization

"Always convert relative dates in user messages to absolute dates when saving (e.g., 'Thursday' → '2026-03-05'), so the memory remains interpretable after time passes."

**Source**: `repos/claude-code/src/memdir/memoryTypes.ts:79`

### Explicit Exclusion with Override Gate

A "What NOT to save" section lists five categories (code patterns, git history, debugging solutions, things in CLAUDE.md, ephemeral task details). The critical detail: "These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was _surprising_ or _non-obvious_ about it — that is the part worth keeping."

**Source**: `repos/claude-code/src/memdir/memoryTypes.ts:183-195`

### "Before Recommending" Verification Protocol

When a memory names a specific function, file, or flag, it's a claim that it existed _when the memory was written_. Before recommending it: check files exist, grep for functions, verify before the user acts. The aphorism: "The memory says X exists" is not the same as "X exists now."

An eval comment reveals that the section header wording matters enormously: "Before recommending" (action cue) tested 3/3 vs 0/3 for the abstract "Trusting what you recall."

**Source**: `repos/claude-code/src/memdir/memoryTypes.ts:240-256`

### Trust Hierarchy

`MEMORY_DRIFT_CAVEAT`: "Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory."

### Dream Consolidation

An offline "dream" process consolidates daily append-only memory logs into durable topic files using a four-phase workflow: Orient (read existing memories) → Gather (find new signal from logs/transcripts) → Consolidate (merge into topic files, converting relative dates, deleting contradictions) → Prune (keep index under 25KB). The design separates write (fast, append-only) from organize (slow, reflective).

**Source**: `repos/claude-code/src/services/autoDream/consolidationPrompt.ts:10-65`

### Tau Gap

Tau's `.tau/AGENTS.md` is a flat file without type taxonomy, bidirectional learning instructions, temporal normalization, exclusion gates, or verification protocols. If Tau adopts a structured memory system, the closed taxonomy + "record successes too" + "verify before recommending" patterns would prevent the most common memory failure modes.

## Finding 11: Context Compaction

### Analysis-as-Scratchpad

When context runs out, a compaction subagent summarizes the conversation. It uses an `<analysis>` XML block as a reasoning scratchpad — the model drafts its chronological analysis there, then produces a structured `<summary>`. The `<analysis>` block is stripped before the summary reaches context, giving the model reasoning space without polluting the output.

**Source**: `repos/claude-code/src/services/compact/prompt.ts:31-44`

### No-Tools Preamble with Failure Consequence

The compaction prompt opens with aggressive tool suppression: "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools." The consequence is explicit: "Tool calls will be REJECTED and will waste your only turn — you will fail the task." A comment confirms this was added because on Sonnet 4.6+ with adaptive thinking, the model sometimes attempted tool calls despite weaker trailer instructions. Placing the constraint FIRST (before the summary prompt) matters because position affects compliance.

**Source**: `repos/claude-code/src/services/compact/prompt.ts:19-26`

### Nine-Section Structured Summary

The compaction output follows a fixed nine-section schema. The most critical section is "Optional Next Step" which includes a drift-prevention guard: "ensure that this step is DIRECTLY in line with the user's most recent explicit requests" and "Do not start on tangential requests or really old requests that were already completed."

### Verbatim Quote Anchoring

"Include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation." Forces the summary to anchor next-step interpretation in the user's exact words rather than the model's paraphrase.

**Source**: `repos/claude-code/src/services/compact/prompt.ts:77`

### Three Compact Variants

Three compaction modes adapt to where the summary will sit in the conversation:

- **BASE** — full conversation summary (section 8: "Current Work", section 9: "Optional Next Step")
- **PARTIAL (from)** — only recent messages after retained context
- **PARTIAL (up_to)** — prefix summary preceding kept newer messages (section 8: "Work Completed", section 9: "Context for Continuing Work")

### Post-Compaction Continuity

The post-compaction message bans five common failure modes: "Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with 'I'll continue' or similar."

**Source**: `repos/claude-code/src/services/compact/prompt.ts:337-374`

### Tau Gap

Tau does not have a context compaction system. When implementing one, the analysis-as-scratchpad pattern, verbatim quote anchoring, and the five-ban post-compaction continuity message are the highest-value patterns to adopt — they prevent the most common drift and regression failures.

## Finding 12: Verification Agent — Rationalization Inoculation

### Adversarial Role Assignment

The verification agent's system prompt opens with an inversion: "Your job is not to confirm the implementation works — it's to try to break it." This overrides the model's default cooperative tendency.

**Source**: `repos/claude-code/src/tools/AgentTool/built-in/verificationAgent.ts:10-12`

### Named Failure Patterns

The prompt documents exactly how the model tends to fail: (1) **verification avoidance** — reading code, narrating what it would test, writing "PASS," and moving on; (2) **being seduced by the first 80%** — seeing a polished UI or passing test suite and not noticing half the buttons do nothing. The explicit framing: "The first 80% is the easy part. Your entire value is in finding the last 20%."

### Preemptive Excuse Blocking

The most sophisticated prompting technique in the codebase. Rather than saying "be thorough," it enumerates the model's specific avoidance tactics and blocks each one:

- "The code looks correct based on my reading" → reading is not verification. Run it.
- "The implementer's tests already pass" → the implementer is an LLM. Verify independently.
- "This is probably fine" → probably is not verified. Run it.
- "Let me start the server and check the code" → no. Start the server and hit the endpoint.
- "I don't have a browser" → did you actually check for browser automation tools?
- "This would take too long" → not your call.

"If you catch yourself writing an explanation instead of a command, stop. Run the command."

**Source**: `repos/claude-code/src/tools/AgentTool/built-in/verificationAgent.ts:54-61`

### Strategy-by-Change-Type Matrix

Instead of generic instructions, a lookup table provides specific verification approaches per change category: Frontend (start dev server → browser automation → screenshot), Backend (start server → curl endpoints → verify response shapes), CLI (run with representative inputs → verify stdout/stderr/exit codes), and six more.

### Recurrent Constraint Injection

A `criticalSystemReminder_EXPERIMENTAL` field re-injects constraints at every turn: "CRITICAL: This is a VERIFICATION-ONLY task. You CANNOT edit, write, or create files IN THE PROJECT DIRECTORY." This prevents drift in long conversations where the model might forget its constraints.

**Source**: `repos/claude-code/src/tools/AgentTool/built-in/verificationAgent.ts:150-151`

### Contrastive Output Format

The prompt shows a bad example (code reading without running) immediately before the good example (actual curl command with output). The bad example mirrors the model's default behavior, making the contrast sharper.

### Machine-Parseable Verdict

The final line must be `VERDICT: PASS`, `VERDICT: FAIL`, or `VERDICT: PARTIAL` — designed for regex parsing by the parent agent. "PARTIAL is for environmental limitations only — not for 'I'm unsure whether this is a bug.'"

### Tau Gap

Tau does not have a verification agent. The rationalization inoculation pattern (enumerating specific excuses and blocking them) is directly applicable to any agentic prompt where the model tends to take shortcuts — including Tau's testing workflow and visual inspection instructions.

## Finding 13: Subagent Context Engineering

### Context Stripping

Read-only subagents (Explore, Plan) have CLAUDE.md and git status stripped from their context. The comment quantifies the savings: "Dropping claudeMd here saves ~5-15 Gtok/week across 34M+ Explore spawns." Git status adds another ~1-3 Gtok/week. Both are feature-flagged for rollback.

**Source**: `repos/claude-code/src/tools/AgentTool/runAgent.ts:386-410`

### Fork Economics

The Agent tool prompt teaches the model to reason about delegation costs: "Forks are cheap because they share your prompt cache. Don't set `model` on a fork — a different model can't reuse the parent's cache." This economic framing gives the model a cost-based decision framework rather than heuristic rules.

**Source**: `repos/claude-code/src/tools/AgentTool/prompt.ts:80-96`

### Turn-Budget Optimization

The memory extraction subagent gets a limited turn budget. The prompt teaches a two-turn batch strategy: "Turn 1 — issue all Read calls in parallel for every file you might update; Turn 2 — issue all Write/Edit calls in parallel." This maximizes efficiency under the constraint.

**Source**: `repos/claude-code/src/services/extractMemories/prompts.ts:29-43`

### Anti-Fabrication Directives

Two named rules prevent subagent result confabulation:

- **"Don't peek"** — don't read the fork's output file during execution; the completion notification arrives via the system
- **"Don't race"** — never fabricate or predict fork results; if the user asks before results arrive, say "the fork is still running" — give status, not a guess

**Source**: `repos/claude-code/src/tools/AgentTool/prompt.ts:88-93`

### Meta-Prompting Instructions

The Agent tool prompt includes instructions for _how to write good subagent prompts_: "Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation." The key principle: "Never delegate understanding" — parent agents must synthesize before delegating.

### Thinking Disabled for Subagents

Subagents have thinking tokens disabled by default (`thinkingConfig: { type: 'disabled' }`) to control output token costs. Fork children inherit thinking config for cache hits.

**Source**: `repos/claude-code/src/tools/AgentTool/runAgent.ts:680-684`

### Tau Gap

Tau does not currently use subagent delegation, but the context stripping pattern (removing irrelevant context from specialized agents) and the anti-fabrication directives are applicable to any multi-step workflow. The quantified savings (~5-15 Gtok/week from CLAUDE.md stripping alone) demonstrate that context engineering at scale requires measuring token costs per feature.

## Finding 14: Communication Channel Contracts

### BriefTool/SendUserMessage Visibility Contract

The most architecturally significant tool prompt defines a hard visibility boundary: "Text outside this tool is visible in the detail view, but most won't open it — the answer lives here." The named failure mode: "the real answer lives in plain text while SendUserMessage just says 'done!' — they see 'done!' and miss everything."

**Source**: `repos/claude-code/src/tools/BriefTool/prompt.ts:6-10`

### Ack-Then-Work-Then-Result Pattern

For longer tasks: "ack first in one line ('On it — checking the test output'), then work, then send the result. Without the ack they're staring at a spinner." Between ack and result, send checkpoints only "when something useful happened — a decision you made, a surprise you hit, a phase boundary. Skip the filler ('running tests...')."

### Inter-Agent Visibility Boundary

For multi-agent communication: "Your plain text output is NOT visible to other agents — to communicate, you MUST call SendMessage." This corrects the model's default assumption that all output is visible to all participants.

**Source**: `repos/claude-code/src/tools/SendMessageTool/prompt.ts:22-48`

### Meta-Instruction Boundary

System instructions that should not leak into generated content are marked: "IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT include any references to 'documentation updates', 'magic docs', or these update instructions in the document content."

**Source**: `repos/claude-code/src/services/MagicDocs/prompts.ts:9`

### Tau Gap

Tau's chat responses are rendered directly — there is no separate visibility channel. However, the ack-then-work-then-result pattern is directly applicable to Tau's streaming responses: acknowledging the task before beginning work improves perceived responsiveness. The meta-instruction boundary pattern is relevant for any generated content (CAD code, parameter files).

## Finding 15: Audience-Aware Prompt Branching

### Completely Different Prompts Per User Segment

The `EnterPlanModeTool` has two entirely different prompt versions: external users get verbose instructions listing seven conditions when to use plan mode; internal (Anthropic) users get a shorter version that says "When in doubt, prefer starting work and using AskUserQuestion for specific questions over entering a full planning phase." The internal version flips one of the external examples from GOOD to BAD.

**Source**: `repos/claude-code/src/tools/EnterPlanModeTool/prompt.ts:23-163`

### Graduated Token Budgets

Internal users who have muscle memory get short skill pointers; external users get full inline instructions. The Bash tool's git section is substantially shorter for internal users because they're trusted to know git conventions.

### Skill Listing Budget

The SkillTool prompt allocates exactly 1% of the model's context window for skill listings, with a per-entry hard cap of 250 characters. Descriptions are progressively truncated to fit: full → trimmed → names-only.

**Source**: `repos/claude-code/src/tools/SkillTool/prompt.ts:21-29`

### Tau Gap

Tau serves the same system prompt to all users regardless of expertise. As the user base grows, audience-aware branching — serving terser prompts to experienced users — could reduce token costs while maintaining quality for new users.

## Finding 16: Precedent-Based Disambiguation

### Case Law for Recurring Ambiguities

The security review command (`src/commands/security-review.ts`) includes a "PRECEDENTS" section with 12 numbered rulings that resolve recurring edge cases:

- "UUIDs can be assumed to be unguessable"
- "Environment variables and CLI flags are trusted values"
- "A user being able to define their own MCP servers is by-design"

This acts as case law — rather than trying to encode every edge case in rules, precedents resolve ambiguities that the model would otherwise hallucinate answers for. The precedents also include a confidence threshold: ">80% confident of actual exploitability" and 17 explicit categories to NOT report.

**Source**: `repos/claude-code/src/commands/security-review.ts:162-176`

### Tau Gap

Tau's system prompt does not include precedent sections. For CAD-specific tasks, precedents could resolve recurring ambiguities — e.g., "boolean unions with touching faces are valid," "thin walls under 0.5mm are intentional when the user specifies them."

## Finding 17: Runtime-Validated Pre-Conditions

### Belt-and-Suspenders Constraint Enforcement

Claude Code enforces critical constraints at both the prompt level AND the runtime level. The FileEditTool prompt says "You must use your Read tool at least once in the conversation before editing" — and the runtime actually validates this, returning an error if violated. The Explore agent prompt says files are read-only — and the `disallowedTools` array actually removes write tools.

This dual enforcement prevents the model from circumventing prompt-level instructions through tool-call creativity. Prompt-level instructions set expectations; runtime validation enforces them.

### Graduated Sandbox Override

The Bash tool's sandbox section defines specific evidence patterns that justify disabling the sandbox (e.g., "Operation not permitted" errors, access denied to specific paths). Rather than a binary on/off, the prompt teaches the model to diagnose whether a failure is sandbox-related before escalating.

**Source**: `repos/claude-code/src/tools/BashTool/prompt.ts:231-252`

### Tau Gap

Tau's tool descriptions include behavioral instructions but does not systematically validate pre-conditions at the runtime level. Adding runtime validation for the most critical constraints (e.g., read-before-edit, no writes outside project directory) would provide defense-in-depth.

## Finding 18: Meta-Prompting

### Agent Generation Factory

An `AGENT_CREATION_SYSTEM_PROMPT` instructs the model to generate agent configurations — identifier, system prompt, usage examples. The meta-prompt prescribes quality principles: "Be specific rather than generic," "Include concrete examples when they would clarify behavior," "Build in quality assurance and self-correction mechanisms."

**Source**: `repos/claude-code/src/components/agents/generateAgent.ts:26-97`

### Session-to-Skill Extraction

The `skillify` bundled skill reads the conversation's session memory and all user messages, then guides a four-step extraction: Analyze Session → Interview User (up to 4 rounds of structured questions) → Write SKILL.md → Confirm and Save. The calibration instruction: "Don't over-ask for simple processes!"

**Source**: `repos/claude-code/src/skills/bundled/skillify.ts:22-156`

### Self-Healing Instructions in Generated Artifacts

The init-verifiers command generates SKILL.md files that contain embedded self-correction: "If verification fails because this skill's instructions are outdated... use AskUserQuestion to confirm and then Edit this SKILL.md with a minimal targeted fix." The generated artifact itself contains meta-instructions for future self-repair.

**Source**: `repos/claude-code/src/commands/init-verifiers.ts:204-207`

### Tau Gap

Tau does not auto-generate skills or agents from conversation context. The session-to-skill extraction pattern could enable Tau users to capture effective CAD workflows as reusable skills. The self-healing pattern could be embedded in Tau's per-kernel examples — if an example produces errors, the system could self-correct.

## Tau Comparison

### Side-by-Side Architecture

| Aspect                        | Claude Code                                                                    | Tau                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **Prompt structure**          | `string[]` with static/dynamic boundary                                        | ✅ `getCadSystemPrompt()` returns `{ static, dynamic }` with multi-block `SystemMessage` (R1)        |
| **Cache strategy**            | Global cache for static prefix, uncached dynamic suffix, cache break detection | Workspace-scoped `ephemeral` cache on static block; global scope deferred; no cache break detection  |
| **User context channel**      | First user message (`<system-reminder>`)                                       | ✅ Memory as `HumanMessage` with `<system-reminder>` wrapper (R2)                                    |
| **Section registry**          | Named, cached, with `DANGEROUS_uncached` marking                               | ✅ `createSectionRegistry` wired into `getCadSystemPrompt()` with 15 named sections (R5)             |
| **Anti-gold-plating**         | Three explicit rules, eval-validated                                           | ✅ Three rules in `<constraints>` section (R3)                                                       |
| **Tool descriptions**         | `prompt()` method, self-contained, 370-line Bash                               | LangChain `description` strings                                                                      |
| **Tool preference**           | Explicit "X (NOT Y)" hierarchy with escalation paths                           | Implicit via `<workflow>` ordering                                                                   |
| **Result size defense**       | Three-tier (per-tool, per-result, per-turn)                                    | Per-tool trimming only                                                                               |
| **Git status**                | Truncated at 2K chars with self-service fallback                               | ✅ End-to-end: `contextPayloadSchema` → `chat.service.ts` → prompt, 2K truncation with fallback (R6) |
| **Model self-awareness**      | Model name, ID, cutoff, family                                                 | ✅ Model ID + context window + knowledge cutoff wired end-to-end (R7)                                |
| **Eval-driven iteration**     | Comments cite specific eval results                                            | ✅ Inline `EVAL(benchmark-2026-04-01)` annotations on prompt sections (R4)                           |
| **Length anchors**            | Numeric ("≤25 words") vs qualitative                                           | ✅ `<output_efficiency>` with numeric ≤25/≤100 word limits (R10)                                     |
| **Coordinator mode**          | Phase-table, anti-delegation, continue-vs-spawn                                | Not present                                                                                          |
| **Memory architecture**       | Four-type taxonomy, bidirectional learning, dream consolidation                | Flat `.tau/AGENTS.md`                                                                                |
| **Context compaction**        | Nine-section schema, verbatim quote anchoring, three variants                  | ✅ Nine-section summary + drift guard + `<analysis>` scratchpad + verbatim anchoring (R13, R15)      |
| **Verification**              | Rationalization inoculation, recurrent constraint injection                    | ✅ Rationalization inoculation in `<visual_inspection>` (R12); no recurrent constraint injection     |
| **Subagent context**          | Context stripping (~5-15 Gtok/week savings), fork economics                    | Not present                                                                                          |
| **Communication channels**    | Hard visibility boundaries, ack-then-work-then-result                          | ✅ Ack-then-work-then-result in dynamic prompt (R16)                                                 |
| **Audience branching**        | Completely different prompts per user segment                                  | Same prompt for all users                                                                            |
| **Pre-condition enforcement** | Prompt + runtime dual validation                                               | Prompt-only                                                                                          |
| **Meta-prompting**            | Agent/skill generation, self-healing artifacts                                 | Not present                                                                                          |

### What Tau Already Does Well

1. **Single source of truth** — Tool descriptions in tool files, workflow in system prompt
2. **Progressive disclosure** — Skills metadata injected, full content on-demand via `read_file`
3. **Kernel-specific prompts** — Per-kernel `<code_standards>`, `<canonical_example>`, error patterns
4. **Prompt caching** — 2-breakpoint strategy at system + last message
5. **Transcript-based context** — `.tau/transcripts/{chatId}.jsonl` with grep instructions

## Recommendations

### Original Recommendations (R1–R11)

| #      | Action                                                                                                                                                                                                                                                                                                | Priority | Effort | Impact                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------- |
| ✅ R1  | **Split system prompt into static/dynamic array** with boundary marker — move kernel-invariant sections (role, workflow, visual inspection, error handling) to static prefix, kernel-specific content (`<code_standards>`, `<canonical_example>`) to dynamic suffix                                   | P0       | Medium | High — enables cross-kernel cache sharing                     |
| ✅ R2  | **Move memory injection to user message channel** — inject `.tau/AGENTS.md` content as first user message with `<system-reminder>` wrapper and "may or may not be relevant" caveat instead of appending to system message                                                                             | P0       | Low    | High — prevents memory edits from busting system prompt cache |
| ✅ R3  | **Add three anti-gold-plating rules** to the static system prompt: don't add unasked features, don't add speculative error handling, don't create premature abstractions                                                                                                                              | P0       | Low    | High — addresses the most common agentic coding failure mode  |
| ✅ R4  | **Add eval annotations** to all prompt changes — every system prompt modification must cite before/after eval scores (even if the eval is manual observation). Convention header and inline `EVAL(benchmark-2026-04-01)` annotations on constraints, visual inspection, and dynamic behavior sections | P1       | Low    | Medium — transforms prompting from art to engineering         |
| ✅ R5  | **Implement dynamic section registry** — named, cached sections with explicit `cacheBreak` classification, replacing monolithic `getCadSystemPrompt()`. `getCadSystemPrompt()` refactored to use `createSectionRegistry` with 15 named sections partitioned by `cacheBreak`                           | P1       | Medium | Medium — enables per-section cache invalidation and debugging |
| ✅ R6  | **Add git status injection** with 2K char truncation and "use shell with git status for more detail" fallback. End-to-end wiring: `contextPayloadSchema` → `chat.service.ts` → `getCadSystemPrompt` with git-aware fallback text                                                                      | P1       | Low    | Medium — agent lacks awareness of project state               |
| ✅ R7  | **Add model self-awareness** — tell the agent its model name, context window, and knowledge cutoff in the dynamic env section. `knowledgeCutoff` field added to schema, populated for all cloud models, wired end-to-end into `<environment>`                                                         | P1       | Low    | Medium — enables model-aware decisions                        |
| ❌ R8  | **Add tool preference hierarchy** — explicit "use read_file instead of shell cat, use edit_file instead of shell sed" in system prompt or bash tool description                                                                                                                                       | P2       | Low    | Medium — prevents unnecessary shell tool usage                |
| ❌ R9  | **Add per-turn aggregate result size cap** — limit total tool result size across parallel calls per turn, not just per-tool                                                                                                                                                                           | P2       | Low    | Medium — prevents context pollution from parallel tool calls  |
| ✅ R10 | **Add numeric length anchors** — `<output_efficiency>` section with "≤25 words between tool calls" and "≤100 words final response" limits added to static prompt                                                                                                                                      | P2       | Low    | Low-Medium — measurable token reduction                       |
| ✅ R11 | **Adopt `<system-reminder>` universal container** — `inject-snapshot-context.ts` updated from `<editor_context>` to `<system-reminder>`; all tests updated                                                                                                                                            | P3       | Low    | Low — simplifies future context type additions                |

### New Recommendations (R12–R21)

| #      | Action                                                                                                                                                                                                                                                                                                                                                 | Priority | Effort | Impact                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ---------------------------------------------------------------------- |
| ✅ R12 | **Add rationalization inoculation to visual inspection** — enumerate specific model avoidance tactics in the visual inspection prompt: "the render looks approximately right" → re-render and compare, "the user hasn't complained" → the user can't see the render yet, "the geometry is too complex to verify" → check vertex count and bounding box | P0       | Low    | High — prevents the most common verification failure mode (Finding 12) |
| ✅ R13 | **Add verbatim quote anchoring to context management** — `POST_COMPACTION_CONTINUITY` updated with explicit "anchor your next action in the user's exact words" instruction                                                                                                                                                                            | P1       | Low    | High — prevents task drift after context compaction (Finding 11)       |
| ✅ R14 | **Add "never delegate understanding" to multi-step workflow prompts** — when the agent invokes tools or skills sequentially, require synthesized specifications with file paths and line numbers rather than vague "based on the above" references                                                                                                     | P1       | Low    | Medium — prevents lazy delegation in multi-tool workflows (Finding 9)  |
| ✅ R15 | **Implement context compaction with analysis-as-scratchpad** — compaction prompt updated with `<analysis>`/`<summary>` output format, `formatCompactSummary` utility strips analysis and unwraps summary, wired into `compaction.service.ts`                                                                                                           | P1       | Medium | High — Tau currently has no compaction strategy (Finding 11)           |
| ✅ R16 | **Add ack-then-work-then-result pattern** to streaming responses — acknowledge the task in the first stream chunk before beginning work; send checkpoints only when they carry information, not filler like "running tests..."                                                                                                                         | P1       | Low    | Medium — improves perceived responsiveness (Finding 14)                |
| ❌ R17 | **Add recurrent constraint injection** for critical behavioral rules — re-inject the most important constraints (e.g., "do not modify the user's existing files without showing the change first") at regular intervals in long conversations to prevent drift                                                                                         | P2       | Low    | Medium — prevents constraint forgetting in long sessions (Finding 12)  |
| ❌ R18 | **Implement pre-condition runtime validation** — validate read-before-edit, no-writes-outside-project, and other critical constraints at the tool runtime level, not just in prompt instructions                                                                                                                                                       | P2       | Medium | Medium — defense-in-depth for critical operations (Finding 17)         |
| ❌ R19 | **Add memory verification protocol** — when the agent's memory or prior context names specific files, functions, or parameters, verify they still exist before recommending actions based on them                                                                                                                                                      | P2       | Low    | Medium — prevents stale-memory-based hallucinations (Finding 10)       |
| ❌ R20 | **Add precedent section for CAD-specific ambiguities** — enumerate common edge cases (thin walls, boolean operations on touching faces, degenerate geometry) as precedents so the model doesn't hallucinate answers                                                                                                                                    | P2       | Low    | Low-Medium — reduces CAD-specific hallucination (Finding 16)           |
| ❌ R21 | **Add cache break detection** — track dimensions that affect cache invalidation (kernel, mode, testing state) and log when breaks occur with root cause attribution, enabling data-driven prompt optimization                                                                                                                                          | P3       | Medium | Medium — enables measuring cache efficiency (Finding 5)                |

## References

- Source: `repos/claude-code/src/constants/prompts.ts` (system prompt construction)
- Source: `repos/claude-code/src/utils/api.ts` (context assembly pipeline)
- Source: `repos/claude-code/src/utils/claudemd.ts` (CLAUDE.md loading)
- Source: `repos/claude-code/src/coordinator/coordinatorMode.ts` (coordinator orchestration)
- Source: `repos/claude-code/src/memdir/memoryTypes.ts` (memory taxonomy)
- Source: `repos/claude-code/src/memdir/memdir.ts` (memory directory layout)
- Source: `repos/claude-code/src/services/compact/prompt.ts` (context compaction)
- Source: `repos/claude-code/src/tools/AgentTool/built-in/verificationAgent.ts` (verification)
- Source: `repos/claude-code/src/tools/AgentTool/runAgent.ts` (subagent context engineering)
- Source: `repos/claude-code/src/tools/AgentTool/prompt.ts` (fork economics, meta-prompting)
- Source: `repos/claude-code/src/tools/BashTool/prompt.ts` (tool steering, sandbox)
- Source: `repos/claude-code/src/tools/BriefTool/prompt.ts` (communication channel)
- Source: `repos/claude-code/src/tools/SkillTool/prompt.ts` (skill budget)
- Source: `repos/claude-code/src/commands/security-review.ts` (precedent-based disambiguation)
- Source: `repos/claude-code/src/services/api/promptCacheBreakDetection.ts` (cache detection)
- Source: `repos/claude-code/src/skills/bundled/` (bundled skill patterns)
- Source: `repos/claude-code/src/components/agents/generateAgent.ts` (meta-prompting)
- Tau: `apps/api/app/api/chat/prompts/cad-agent.prompt.ts` (system prompt)
- Tau: `apps/api/app/api/chat/middleware/client-context.middleware.ts` (context injection)
- Tau: `apps/api/app/api/chat/middleware/prompt-caching.middleware.ts` (cache strategy)
- Policy: `docs/policy/context-engineering-policy.md`
- Related: `docs/research/context-injection-architecture.md`
- Related: `docs/research/claude-code-subagent-architecture.md`
