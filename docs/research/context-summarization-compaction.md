---
title: 'Context Summarization and Compaction for Agentic CAD'
description: 'Analysis of context compression techniques for long-horizon coding agents, comparing LLM summarization, verbatim compaction, observation masking, and hybrid approaches. Evaluates Morph Compact integration for Tau CAD agent.'
status: draft
created: '2026-03-24'
updated: '2026-03-24'
category: comparison
related:
  - docs/policy/context-engineering-policy.md
---

# Context Summarization and Compaction for Agentic CAD

Investigation into world-class context summarization and compaction practices for maximizing long-horizon performance of Tau's CAD agent, with specific evaluation of Morph Compact for verbatim compaction.

## Executive Summary

Context compression is essential for long-running agentic sessions. Our CAD agent accumulates file reads, kernel outputs, geometry analysis results, and multi-turn reasoning that fills context windows well before tasks complete. Seven distinct compression methods have emerged in 2025–2026, each with different fidelity/compression trade-offs. For coding agents — and particularly CAD agents that rely on exact file paths, parameter values, and error traces — **verbatim compaction** (deletion-based, zero hallucination) paired with **observation masking** (zero-cost placeholder replacement) offers the strongest fidelity guarantee. Morph Compact implements verbatim compaction at 33,000 tok/s with 50–70% reduction and a 1M token context window. We recommend a hybrid strategy: observation masking for stale tool outputs, Morph Compact with query-conditioned compression for active context, and `<keepContext>` tags for critical architectural state.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [The Seven Compression Methods](#the-seven-compression-methods)
- [Finding 1: Context Rot is the Primary Failure Mode](#finding-1-context-rot-is-the-primary-failure-mode)
- [Finding 2: Summarization Causes the Re-Reading Loop](#finding-2-summarization-causes-the-re-reading-loop)
- [Finding 3: Verbatim Compaction Breaks the Re-Reading Loop](#finding-3-verbatim-compaction-breaks-the-re-reading-loop)
- [Finding 4: Observation Masking is a Free Baseline](#finding-4-observation-masking-is-a-free-baseline)
- [Finding 5: Autonomous Compression Timing Outperforms Thresholds](#finding-5-autonomous-compression-timing-outperforms-thresholds)
- [Finding 6: Prevention Beats Compression](#finding-6-prevention-beats-compression)
- [Finding 7: Agent Hand-Off is the Radical Alternative](#finding-7-agent-hand-off-is-the-radical-alternative)
- [Industry Landscape](#industry-landscape)
- [Morph Compact: Technical Evaluation](#morph-compact-technical-evaluation)
- [Recommendations for Tau CAD Agent](#recommendations-for-tau-cad-agent)
- [Trade-offs](#trade-offs)
- [References](#references)

## Problem Statement

Tau's CAD agent (`chat.controller.ts` → LangGraph agent) runs multi-step sessions that accumulate substantial context:

- **File reads**: Source code files, CAD kernel outputs (OpenSCAD, Replicad, JSCAD)
- **Tool outputs**: Geometry analysis results, file tree snapshots, RPC responses
- **Kernel results**: GLB renders, error traces with line numbers and parameter values
- **Conversation history**: Multi-turn reasoning, iterative design refinement

Current state: no context compression is implemented. The `prepareMessages` method in `chat.controller.ts` converts UI messages to LangChain format and injects snapshot context, but does not compress or summarize. As sessions grow, the agent hits context limits (200K tokens for Claude models) and — more critically — performance degrades well before limits due to context rot.

The context engineering policy (`docs/policy/context-engineering-policy.md`) describes sliding windows, compression techniques, and context compaction as advanced patterns but does not prescribe a specific implementation. This investigation evaluates the options.

## Methodology

1. **Literature review**: 30+ sources from Anthropic, LangChain, Cursor, JetBrains, Factory.ai, Sourcegraph, Morph, Chroma, Microsoft Research, and academic papers (2023–2026).
2. **Product analysis**: CLI coding agents, Cursor Composer, OpenAI Codex, LangChain Deep Agents, JetBrains Junie, Sourcegraph Amp, Morph SDK.
3. **Benchmark evaluation**: Factory.ai's 36K message eval, ACON's three-benchmark suite, JetBrains' SWE-bench study, Chroma's 18-model context rot study.
4. **Morph API analysis**: Full documentation review of Compact SDK, API endpoints, `<keepContext>` tags, query-conditioned compression, and integration patterns.
5. **Architecture mapping**: Analysis of Tau's `chat.controller.ts`, LangGraph agent pipeline, and existing context engineering policy.

## The Seven Compression Methods

Seven distinct approaches to context compression have emerged, each operating at a different level of abstraction.

| #   | Method                    | Mechanism                                       | Compression      | Hallucination Risk | Speed                | Cost          |
| --- | ------------------------- | ----------------------------------------------- | ---------------- | ------------------ | -------------------- | ------------- |
| 1   | LLM Summarization         | Rewrites into structured sections               | 70–90%           | Medium             | Slow (full LLM call) | High          |
| 2   | Opaque Compression        | Model-internal server-side reduction            | ~99%             | Unknown            | Variable             | Vendor-locked |
| 3   | Verbatim Compaction       | Deletes noise, preserves surviving text exactly | 50–70%           | Zero               | 33,000 tok/s         | Low           |
| 4   | Token Pruning (LLMlingua) | Removes low-entropy tokens                      | 2–20×            | Low                | 3–6× faster than LLM | Low           |
| 5   | Observation Masking       | Replaces stale tool outputs with placeholders   | ~100% per output | Zero               | Free                 | Zero          |
| 6   | ACON Adaptive Control     | Failure-driven guideline optimization           | 26–54%           | Low                | Distillable          | Medium        |
| 7   | Multi-Agent Isolation     | Separate context window per sub-agent           | Architectural    | Zero               | Parallel             | Higher total  |

### 1. LLM Summarization

An LLM rewrites conversation history into organized sections. The dominant CLI coding-agent pattern generates structured summaries of 7,000–12,000 characters covering analysis completed, files modified, key decisions, and pending tasks (Anthropic, 2025). Factory.ai's anchored iterative approach merges new information into a persistent summary state rather than regenerating from scratch, scoring 4.04/5 on accuracy — but multi-session retention was only 37% (Factory.ai, 2025).

### 2. Opaque Compression

OpenAI Codex's `/responses/compact` produces a server-side compressed representation achieving 99.3% compression. Not inspectable, not portable, and scored 3.35/5 in Factory.ai's evaluation — below structured summarization. The opacity means failures are undiagnosable (Factory.ai, 2025).

### 3. Verbatim Compaction

Morph Compact deletes low-signal tokens while preserving every surviving line character-for-character identical to the original. 33,000 tok/s, 50–70% reduction, 1M token context window, zero hallucination risk. The lower compression ratio compared to summarization is the trade-off: you keep less context, but what you keep is guaranteed accurate (Morph, 2026).

### 4. Token Pruning (LLMlingua)

Microsoft's LLMlingua (EMNLP 2023) scores tokens by information entropy and removes low-information ones. Up to 20× compression but operates below the semantic level — a pruned file path might lose its line number. LLMlingua-2 (ACL 2024) runs 3–6× faster using bidirectional Transformer encoders (Li et al., 2023; Pan et al., 2024).

### 5. Observation Masking

Replaces old tool outputs with placeholders: `[File read: src/auth.ts, 247 lines]`. JetBrains tested this in Junie on SWE-bench and found it matched full LLM summarization quality at zero compute cost. The key insight: once the model has acted on information, it often doesn't need the raw data in subsequent turns (JetBrains Research, NeurIPS 2025).

### 6. ACON Adaptive Control

Microsoft Research's ACON (arxiv 2510.00615) analyzes paired trajectories where full context succeeds but compressed context fails, iteratively improving compression guidelines. Achieves 26–54% token reduction while preserving 95%+ accuracy. Can distill into smaller models (Chen et al., 2025).

### 7. Multi-Agent Isolation

Decompose tasks so each sub-agent gets a clean context window. Anthropic demonstrated 90.2% improvement with an Opus lead agent delegating to Sonnet sub-agents on research tasks. Each sub-agent processes only task-relevant information and returns a condensed summary (Anthropic, 2025).

## Finding 1: Context Rot is the Primary Failure Mode

Context rot — measurable performance degradation as input context grows — affects all frontier models. Chroma's 2025 study tested 18 models (GPT-4.1, Claude 4, Gemini 2.5, Qwen 3) and confirmed universal degradation with increased input length, even on simple retrieval tasks.

**Root causes:**

- **Attention dilution**: Transformer attention scales quadratically (n² pairwise relationships). At 100K tokens, 10 billion pairwise relationships compete for attention.
- **Lost in the middle**: U-shaped attention — models attend strongly to positions 0–15% and 85–100%, with 30%+ accuracy drops at positions 40–60% (Liu et al., "Lost in the Middle", 2023).
- **Noise scaling**: Longer context introduces redundancy and subtle contradictions that degrade signal-to-noise ratio.

**Implication for Tau**: Context rot means the agent's performance degrades continuously as sessions grow, not just at the limit. A CAD agent at 60% capacity with 40% noise tokens already performs worse than the same agent with clean context. Compression should be continuous, not just triggered at capacity limits.

## Finding 2: Summarization Causes the Re-Reading Loop

The re-reading loop is the most expensive failure mode of summarization-based compression:

1. Agent searches for code, finds results → context fills
2. Summarization compresses search results → paraphrases file paths and line numbers
3. Agent needs exact file path for next edit → can't find it in summary
4. Agent re-searches → new results refill context
5. Summarization triggers again → cycle repeats

Cognition measured that agents spend 60% of their time searching. Part of this is re-searching for information that was summarized away. Summarization-based compression causes 13–15% longer agent trajectories compared to verbatim approaches (Morph, 2026).

**Relevance to CAD**: Our agent relies on exact file names, kernel parameter values, geometry error traces with coordinates, and specific line numbers in user code. Summarization would paraphrase `cylinder(r=5.2, h=10.3, center=true)` into "a cylinder shape" — destroying the parametric precision the agent needs.

## Finding 3: Verbatim Compaction Breaks the Re-Reading Loop

Verbatim compaction preserves surviving content exactly, eliminating re-reading:

```
# After SUMMARIZATION:
"Found a bug in the CAD kernel output related to boolean operations."
→ Lost: exact error message, file path, parameter values, line numbers

# After VERBATIM COMPACTION:
Error at line 12: OpenSCAD: CSG operation failed - objects do not intersect.
  cylinder(r=5.2, h=10.3) and cube([8, 8, 8], center=true)
Agent note: Need to adjust cylinder radius to 6.0 for proper intersection.
→ Kept: exact error, parameters, fix instruction. Removed: irrelevant file reads.
```

**Morph Compact specifics:**

- **Speed**: 33,000 tok/s (100K tokens in <2 seconds)
- **Compression**: 50–70% typical reduction
- **Fidelity**: Every surviving line byte-for-byte identical to input
- **Context window**: 1M tokens
- **Query-conditioned**: Optional `query` parameter focuses compression on task-relevant content

## Finding 4: Observation Masking is a Free Baseline

JetBrains' observation masking replaces stale tool outputs with placeholders. On SWE-bench, it matched full LLM summarization quality while costing zero compute. A hybrid approach combining masking with summarization achieved 7% and 11% cost reductions compared to either alone (JetBrains Research, NeurIPS 2025).

**Relevance to Tau**: Our LangGraph agent produces tool calls with large outputs (file reads, geometry analysis, kernel compilation results). Masking older outputs while preserving the tool call record itself (so the agent remembers what it did) is the simplest first step.

**Limitation**: Masking is irreversible. If the agent needs to re-reference a masked output, it must re-execute the tool call. This works for agents that rarely backtrack but breaks in iterative debugging.

## Finding 5: Autonomous Compression Timing Outperforms Thresholds

LangChain's Deep Agents SDK exposes a tool that lets the agent trigger context compression itself, rather than relying on fixed thresholds (LangChain, 2026). The agent compresses at clean task boundaries:

- After finishing a deliverable
- After extracting conclusions from large context
- Before consuming large new context
- Before starting a complex multi-step process

Deep Agents implements a three-tier compression cascade:

1. **Offload large tool results** (>20K tokens → filesystem with 10-line preview)
2. **Offload large tool inputs** (at 85% capacity → replace old write/edit calls with file pointers)
3. **Summarization** (when offloading is exhausted → structured LLM summary with filesystem preservation)

**Key insight**: Thresholds are suboptimal because there are good and bad times to compress. Compacting mid-refactor loses state; compacting at a task boundary is ideal. The "bitter lesson" applies: give agents more control over their own context rather than tuning thresholds by hand.

## Finding 6: Prevention Beats Compression

Morph's FlashCompact thesis: the most effective compression is the compression you never need to run. Three sources account for most context waste in coding agents:

| Source       | Waste                                            | Prevention                                                                                   |
| ------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| **Search**   | Grep returns 500 lines for a 10-line function    | WarpGrep returns only relevant snippets (0.73 F1 in 3.8 steps vs grep's 0.19 F1 in 12 steps) |
| **Edits**    | Full file rewrites echo entire file into context | Fast Apply uses compact diffs (10,500 tok/s, 98% accuracy)                                   |
| **Residual** | Tool outputs, error traces, dead-end exploration | Verbatim compaction cleans up what remains (33,000 tok/s)                                    |

The combined effect: 3–4× longer context life. Auto-compact fires 3–4× less often.

**Relevance to Tau**: Our agent already uses tool calls for file operations and kernel execution. Preventing context waste at the source — by compacting tool outputs before they enter conversation history — would keep the context cleaner throughout the session.

## Finding 7: Agent Hand-Off is the Radical Alternative

Sourcegraph retired compaction in Amp entirely, replacing it with "Handoff" — when context fills up, a new agent instance is spawned with a structured task summary instead of compressing the existing conversation (Sourcegraph, 2026). This reframes context exhaustion as a coordination problem, not a compression problem.

**Rationale**: Compaction stacks summary upon summary, encouraging long meandering threads. Handoff forces focused, goal-oriented threads.

**Hybrid approach** (recommended by Morph): Use verbatim compaction for the first compression cycle. If the agent needs a second compaction, hand off to a fresh agent. Best of both worlds.

**Relevance to Tau**: This could map to our existing multi-agent patterns, but adds complexity. Worth considering as a future enhancement after basic compaction is proven.

## Industry Landscape

### Product Implementations

| Product                   | Approach                                            | Trigger                                            | Key Details                                                                                                                 |
| ------------------------- | --------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **CLI coding agents**     | Three-layer: micro-compaction, auto-compact, manual | Auto at ~95% capacity; manual any time             | Structured summaries 7K–12K chars; custom focus instructions; provider-specific compaction API betas                        |
| **Cursor Composer**       | RL-trained self-summarization                       | Fixed token-length trigger                         | Self-summarization trained via RL reduces compaction errors 50%; 5× token efficiency; Composer 2 scores 61.3 on CursorBench |
| **OpenAI Codex**          | Opaque server-side compression                      | Every turn (inline)                                | `/responses/compact` endpoint; 99.3% compression; not inspectable; vendor-locked                                            |
| **LangChain Deep Agents** | Three-tier cascade + autonomous tool                | 85% of model window; autonomous at task boundaries | Offloads tool results >20K tokens; filesystem preservation; summarization as last resort                                    |
| **JetBrains Junie**       | Observation masking + hybrid                        | After tool processing                              | Matches summarization quality at zero cost; NeurIPS 2025; hybrid adds 7–11% savings                                         |
| **Sourcegraph Amp**       | Handoff (retired compaction)                        | Context exhaustion                                 | Spawns new agent with structured task summary; reframes as coordination problem                                             |
| **Morph**                 | Verbatim compaction + prevention                    | Inline/continuous or threshold                     | 33K tok/s; query-conditioned; `<keepContext>` tags; zero hallucination; 1M window                                           |

### Academic Research

| Paper                            | Key Contribution                                                     | Year           |
| -------------------------------- | -------------------------------------------------------------------- | -------------- |
| Liu et al., "Lost in the Middle" | 30%+ accuracy drop for mid-context information                       | 2023           |
| Li et al., LLMlingua             | Token-level pruning via information entropy, up to 20×               | 2023           |
| Pan et al., LLMlingua-2          | Bidirectional encoder token classification, 3–6× faster              | 2024           |
| Chroma, "Context Rot"            | All 18 frontier models degrade with input length                     | 2025           |
| Chen et al., ACON                | Failure-driven adaptive compression, 26–54% reduction                | 2025           |
| JetBrains Research               | Observation masking matches summarization on SWE-bench               | 2025 (NeurIPS) |
| Factory.ai                       | 36K message compression benchmark; anchored iterative summarization  | 2025           |
| SWE-Pruner                       | Self-adaptive 0.6B neural skimmer for code context; 23–54% reduction | 2025           |
| Yuksel, PAACE                    | Plan-aware context engineering; next-k-task relevance                | 2025           |
| Cursor                           | RL-trained self-summarization; 50% fewer compaction errors           | 2026           |

### Key Metrics from Benchmarks

| Benchmark                    | Method                               | Score/Result                               |
| ---------------------------- | ------------------------------------ | ------------------------------------------ |
| Factory.ai 36K msgs          | Factory structured summary           | 3.70/5 overall, 4.04/5 accuracy            |
| Factory.ai 36K msgs          | Anthropic summary                    | 3.44/5 overall, 3.74/5 accuracy            |
| Factory.ai 36K msgs          | OpenAI opaque                        | 3.35/5 overall, 3.43/5 accuracy            |
| Factory.ai multi-session     | Summarization retention              | 37% (63% information loss)                 |
| ACON (AppWorld, OfficeBench) | Adaptive compression                 | 26–54% token reduction, 95%+ accuracy      |
| JetBrains SWE-bench          | Observation masking vs summarization | Masking matched summarization at zero cost |
| Cursor CursorBench Hard 80K  | Self-summary vs compaction           | 47.9 vs 46.7 (self-summary wins)           |

## Morph Compact: Technical Evaluation

### API Surface

Morph Compact exposes three OpenAI-compatible endpoints:

1. **`POST /v1/compact`** — Native Morph format with full control
2. **`POST /v1/responses`** — OpenAI Responses API format
3. **`POST /v1/chat/completions`** — OpenAI Chat Completions drop-in

### Key Parameters

| Parameter                  | Type                | Default       | Purpose                                          |
| -------------------------- | ------------------- | ------------- | ------------------------------------------------ |
| `input`                    | string \| message[] | —             | Text or `{role, content}` array                  |
| `query`                    | string              | auto-detected | Focus query for relevance-based pruning          |
| `compression_ratio`        | float               | 0.5           | Fraction to keep (0.3 = aggressive, 0.7 = light) |
| `preserve_recent`          | int                 | 2             | Keep last N messages uncompressed                |
| `compress_system_messages` | bool                | false         | System messages preserved by default             |
| `include_line_ranges`      | bool                | true          | Track which lines were removed                   |
| `include_markers`          | bool                | true          | Insert `(filtered N lines)` markers              |

### Query-Conditioned Compression

The `query` parameter is the most powerful feature for CAD agent use. It tells the model which lines matter for the next LLM call:

- `query="boolean operation error"` → keeps error traces, drops successful renders
- `query="cylinder dimensions"` → keeps parametric values, drops unrelated geometry
- `query="file structure"` → keeps file tree and paths, drops code content

Without `query`, the model auto-detects from the last user message. Explicit queries give substantially tighter compression.

### `<keepContext>` Tags

Critical sections can be wrapped in `<keepContext>` / `</keepContext>` tags to survive compression regardless of compression ratio. This is essential for:

- Architectural decisions that must persist across the entire session
- Active error traces being debugged
- CAD parameters under iterative refinement
- Current file/line references the agent needs

Tags must be on their own line and open/close within the same message. Kept content counts against the compression ratio budget.

### Response Format

The response includes `compacted_line_ranges` (which lines were removed) and optional `kept_line_ranges` (lines preserved via `<keepContext>`), enabling diffability and debugging of compression decisions.

### SDK Integration

```typescript
import { MorphClient } from '@morphllm/morphsdk';

const morph = new MorphClient({ apiKey: process.env.MORPH_API_KEY });

const result = await morph.compact({
  input: conversationHistory,
  query: 'CAD geometry boolean operations',
  compressionRatio: 0.5,
  preserveRecent: 3,
});
```

Or via the standard OpenAI SDK:

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.MORPH_API_KEY,
  baseURL: 'https://api.morphllm.com/v1',
});

const response = await client.chat.completions.create({
  model: 'morph-compactor',
  messages: [{ role: 'user', content: longContext }],
});

const compacted = response.choices[0].message.content;
```

### Fit for Tau

| Tau Requirement                         | Morph Compact Fit                                                   |
| --------------------------------------- | ------------------------------------------------------------------- |
| Preserve exact file paths               | Zero hallucination — surviving paths are verbatim                   |
| Preserve CAD parameter values           | Verbatim output — `cylinder(r=5.2)` stays exactly `cylinder(r=5.2)` |
| Preserve error traces with line numbers | Lines either survive intact or are removed entirely                 |
| Fast enough for inline use              | 33,000 tok/s — 100K tokens in <2 seconds                            |
| Query-focused compression               | `query` parameter focuses on task-relevant content                  |
| Protect critical state                  | `<keepContext>` tags for architectural decisions                    |
| OpenAI SDK compatible                   | Drop-in via `baseURL` override                                      |
| LangChain/LangGraph compatible          | Standard API format; can integrate as middleware                    |

## Recommendations for Tau CAD Agent

| #   | Action                                                                                    | Priority | Effort  | Impact                                                                             |
| --- | ----------------------------------------------------------------------------------------- | -------- | ------- | ---------------------------------------------------------------------------------- |
| R1  | Implement observation masking for stale tool outputs in LangGraph agent                   | P0       | Low     | High — free context savings, zero compute, matches SWE-bench summarization quality |
| R2  | Add Morph Compact as threshold-based compaction (80% capacity trigger)                    | P0       | Medium  | High — prevents context rot with zero hallucination                                |
| R3  | Use `query` parameter conditioned on the user's current message/task                      | P1       | Low     | High — focuses compression on task-relevant content                                |
| R4  | Wrap critical state in `<keepContext>` tags (active file refs, CAD params, error traces)  | P1       | Low     | Medium — protects precision-critical information                                   |
| R5  | Set `preserve_recent: 3` to keep latest turns uncompressed                                | P1       | Trivial | Medium — recent turns contain active intent                                        |
| R6  | Evaluate inline compaction for large tool outputs (>500 tokens) before they enter context | P2       | Medium  | High — prevents context waste at the source                                        |
| R7  | Add autonomous compaction tool so the agent can self-compress at task boundaries          | P2       | Medium  | Medium — agent-driven timing outperforms fixed thresholds                          |
| R8  | Store pre-compaction context as recoverable virtual file (Will Larson pattern)            | P3       | Low     | Low — safety net for aggressive compression                                        |
| R9  | Evaluate agent hand-off as a future alternative when second compaction is needed          | P3       | High    | Medium — clean context for fresh sub-agents                                        |

### Recommended Implementation Order

**Phase 1 — Baseline** (R1, R2, R3, R4, R5):
Add observation masking to the LangGraph agent pipeline. Integrate Morph Compact as a compaction step triggered at 80% context capacity. Pass the user's current query to focus compression. Wrap critical CAD state in `<keepContext>` tags.

**Phase 2 — Inline Prevention** (R6):
Compact large tool outputs before they enter conversation history. This requires Morph Compact's speed (33,000 tok/s) to avoid adding latency to each tool call.

**Phase 3 — Agent-Driven** (R7, R8):
Expose compaction as a LangGraph tool so the agent can self-compress at task boundaries. Store pre-compaction snapshots for recovery.

**Phase 4 — Future** (R9):
Evaluate agent hand-off for sessions requiring multiple compaction cycles.

## Trade-offs

### Verbatim Compaction vs. LLM Summarization

| Dimension                   | Verbatim Compaction                      | LLM Summarization                        |
| --------------------------- | ---------------------------------------- | ---------------------------------------- |
| **Compression ratio**       | 50–70% (lower)                           | 70–90% (higher)                          |
| **Hallucination risk**      | Zero                                     | Medium (paraphrases code, paths, values) |
| **Speed**                   | 33,000 tok/s                             | Model-dependent (slow)                   |
| **Re-reading loops**        | Prevents them (exact content)            | Causes them (lost details)               |
| **Cost**                    | ~$0.30/1M input, $1.50/1M output         | Full model inference cost                |
| **Inspectability**          | Full (diff against original)             | Full (readable summary)                  |
| **Multi-session retention** | N/A (stateless, but preserves precision) | 37% (Factory.ai)                         |

**Verdict**: For Tau's CAD agent, verbatim compaction is strongly preferred. The lower compression ratio is acceptable because context fidelity — exact parameters, file paths, error messages — directly determines task success.

### Threshold vs. Inline vs. Autonomous Timing

| Strategy                      | When                                     | Pros                           | Cons                                                             |
| ----------------------------- | ---------------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| **Threshold** (80%)           | At capacity limit                        | Simple, predictable            | Context already degraded before trigger                          |
| **Inline** (per tool output)  | On every large output                    | Context stays clean throughout | Requires fast compaction (>3K tok/s); adds latency per tool call |
| **Autonomous** (agent-driven) | At task boundaries                       | Best timing decisions          | Adds tool complexity; requires model to learn when to compress   |
| **Hybrid**                    | Inline for tools + threshold for history | Best of both worlds            | Most complex to implement                                        |

**Verdict**: Start with threshold-based (Phase 1), evolve to inline (Phase 2), then autonomous (Phase 3).

### Morph Compact vs. Self-Hosted Summarization

| Dimension             | Morph Compact                           | Self-hosted (e.g. Claude summarization)       |
| --------------------- | --------------------------------------- | --------------------------------------------- |
| **Latency**           | <2s for 100K tokens                     | 5–15s for full model call                     |
| **Fidelity**          | Verbatim                                | Lossy                                         |
| **Vendor dependency** | Morph API (OpenAI-compatible, portable) | Own infrastructure                            |
| **Cost**              | Per-token Morph pricing                 | Own model inference cost                      |
| **Complexity**        | API call                                | Summarization prompt engineering + evaluation |

**Verdict**: Morph Compact is preferred for initial implementation due to speed, fidelity, and simplicity. Self-hosted summarization can supplement for cross-session summaries where approximate recall is acceptable.

## References

### Primary Sources

1. Anthropic (Sep 2025) — [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
2. Chroma (2025) — [Context Rot: How Increasing Input Tokens Impacts LLM Performance](https://research.trychroma.com/context-rot)
3. Chen et al. (2025) — [ACON: Optimizing Context Compression for Long-horizon LLM Agents](https://arxiv.org/abs/2510.00615)
4. Cursor (2026) — [Training Composer for Longer Horizons (Self-Summarization)](https://cursor.com/blog/self-summarization)
5. Cursor (Feb 2026) — [Dynamic Context Discovery](https://cursor.com/blog/dynamic-context-discovery)
6. Factory.ai (2025) — [Evaluating Context Compression](https://factory.ai/news/evaluating-compression); [Compressing Context](https://factory.ai/news/compressing-context)
7. JetBrains Research (NeurIPS 2025) — [Efficient Context Management for LLM-Powered Agents](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)
8. LangChain (2026) — [Autonomous Context Compression](https://blog.langchain.com/autonomous-context-compression/)
9. LangChain (2026) — [Context Management for Deep Agents](https://blog.langchain.com/context-management-for-deepagents/)
10. LangChain (Mar 2026) — [Deep Agents: Structured Runtime for Planning, Memory, and Context Isolation](https://www.marktechpost.com/2026/03/15/langchain-releases-deep-agents/)
11. Li et al. (EMNLP 2023) — [LLMlingua: Compressing Prompts for Accelerated Inference](https://arxiv.org/abs/2310.05736)
12. Liu et al. (2023) — [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172)
13. Morph (2026) — [Compact SDK Documentation](https://docs.morphllm.com/sdk/components/compact)
14. Morph (2026) — [Compaction vs Summarization](https://morphllm.com/compaction-vs-summarization)
15. Morph (2026) — [Context Compression for LLMs: 7 Methods Compared](https://morphllm.com/context-compression)
16. Pan et al. (ACL 2024) — [LLMlingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression](https://arxiv.org/abs/2403.12968)
17. Sourcegraph (2026) — [Amp: Handoff (No More Compaction)](https://ampcode.com/news/handoff)
18. SWE-Pruner (2025) — [Self-Adaptive Context Pruning for Coding Agents](https://arxiv.org/abs/2601.16746v2)
19. Yuksel (Dec 2025) — PAACE: Plan-Aware Automated Context Engineering
20. Will Larson (2026) — [Context Management for LLM Agents](https://lethain.com/context-management/)
21. Mei et al. (Jul 2025) — [A Survey of Context Engineering for LLMs](https://huggingface.co/papers/2507.13334)
22. Jiang & Nam (Dec 2025) — [Empirical Study on Developer-Provided Context](https://arxiv.org/abs/2512.18925)

### Tau Internal References

- `docs/policy/context-engineering-policy.md` — Current context engineering policy
- `apps/api/app/api/chat/chat.controller.ts` — Chat controller (integration point)
