---
title: 'Transcript Search Architecture'
description: 'Comparison of Cursor and Tau transcript formats, grep strategies, and recommendations for making Tau chat history agent-searchable'
status: draft
created: '2026-03-24'
updated: '2026-03-24'
category: comparison
related:
  - docs/research/cursor-filesystem-architecture.md
  - docs/policy/filesystem-policy.md
  - docs/research/context-summarization-compaction.md
---

# Transcript Search Architecture

Comparison of how Cursor IDE and Tau CAD store and search conversation transcripts, with recommendations for making Tau's chat history fit for agent-powered grep, self-reflection, and continual learning.

## Executive Summary

Cursor stores full conversation content in grep-friendly JSONL files and instructs agents to search them via keyword grep + windowed reads. Tau stores two separate files — a metadata-only transcript (200-char previews, no user messages) and a compaction offload (overwrites, not appends). Neither Tau file is suitable for the agent to search its own history. We recommend unifying into a single append-only JSONL with full content, matching Cursor's proven schema, and adding transcript search awareness to the CAD agent prompt.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Finding 1: Cursor Transcript Schema](#finding-1-cursor-transcript-schema)
- [Finding 2: Tau Transcript Schema](#finding-2-tau-transcript-schema)
- [Finding 3: Schema Differences Matrix](#finding-3-schema-differences-matrix)
- [Finding 4: How Cursor Agents Search Transcripts](#finding-4-how-cursor-agents-search-transcripts)
- [Finding 5: Cursor Search Tooling — Grep Plus Semantic Search](#finding-5-cursor-search-tooling--grep-plus-semantic-search)
- [Finding 6: CAD Agent Prompt Gaps](#finding-6-cad-agent-prompt-gaps)
- [Finding 7: Agentic Transcript Search Best Practices (March 2026)](#finding-7-agentic-transcript-search-best-practices-march-2026)
- [Recommendations](#recommendations)
- [Code Examples](#code-examples)
- [References](#references)

## Problem Statement

Tau's chat agent cannot search its own conversation history. Two structural issues prevent this:

1. **Sparse transcripts**: The `transcript.middleware.ts` writes metadata-only lines (200-char content previews, tool call names, content lengths) — insufficient for meaningful keyword search.
2. **Overwrite offloads**: The `compaction.middleware.ts` writes evicted messages via `create_file` (overwrite semantics), losing prior batches of evicted content.
3. **Missing user messages**: The transcript middleware only captures `model_response` and `tool_result` events — user messages are never recorded.
4. **No agent awareness**: The CAD agent system prompt (`cad-agent.prompt.ts`) contains no instructions for searching transcripts or referencing past conversations.

This investigation compares Cursor's proven transcript architecture with Tau's current implementation to identify concrete changes needed.

## Methodology

1. **Cursor transcript analysis**: Read JSONL files from `~/.cursor/projects/Users-rifont-git-tau/agent-transcripts/` — 275+ conversations, 50+ MB total
2. **Schema extraction**: Parsed first 5 lines of multiple transcripts to extract the JSON schema per line
3. **System prompt mining**: Extracted Cursor's `<agent_transcripts>` system prompt injection and conversation summary `Transcript location:` instructions from our own transcripts
4. **Tau middleware audit**: Read `transcript.middleware.ts`, `compaction.middleware.ts`, and their tests to extract exact output schemas
5. **Agent prompt review**: Read `cad-agent.prompt.ts` to audit transcript/history awareness
6. **Web research**: Fetched Cursor's agent best practices blog and semantic search research paper (March 2026)
7. **Transcript mining**: Searched 275+ transcripts for patterns where Cursor instructs agents about grep/search strategies

## Finding 1: Cursor Transcript Schema

Cursor stores conversations as JSONL in `agent-transcripts/<uuid>/<uuid>.jsonl`, with subagent transcripts in `subagents/<uuid>.jsonl`.

### Record Schema

```json
{
  "role": "user" | "assistant",
  "message": {
    "content": [
      {
        "type": "text",
        "text": "<full message content>"
      }
    ]
  }
}
```

### Key Properties

| Property               | Value                                                                |
| ---------------------- | -------------------------------------------------------------------- |
| **Top-level keys**     | `role`, `message` (exactly 2 keys)                                   |
| **Content model**      | Array of content blocks (matches Anthropic/OpenAI multimodal format) |
| **Content types**      | `text` observed; image references via file paths to `assets/`        |
| **Tool calls**         | **Excluded** from transcripts (not stored in JSONL)                  |
| **User messages**      | **Included** — full user queries with injected system context        |
| **Assistant messages** | **Included** — full model output text                                |
| **Growth model**       | Append-only; new messages appended to end of file                    |
| **Typical size**       | 8 KB – 700+ KB per conversation                                      |
| **Line independence**  | Each line is a complete JSON object, independently parseable         |

### What's Excluded

Tool calls and tool results are explicitly excluded from Cursor transcripts. The conversation summary injected into continued conversations states: "Files contain one structured json event per line including user/assistant messages. Currently tool calls and results are excluded."

This is a deliberate design choice — tool outputs are often large (file contents, terminal output, search results) and would make transcripts too large for grep. The agent gets tool context from the live conversation, not from transcript replay.

### Subagent Hierarchy

```
agent-transcripts/
  <parent-uuid>/
    <parent-uuid>.jsonl          # Main conversation (383 lines, 694 KB observed)
    subagents/
      <subagent-uuid>.jsonl      # Subagent conversation (18 files, 1-50 KB each)
```

Parent transcripts are cited to users as `[<title>](<uuid>)`. Subagent transcripts are internal — agents are instructed to "NEVER cite subagent transcripts/IDs."

## Finding 2: Tau Transcript Schema

Tau maintains two separate JSONL files per chat, written by different middleware:

### A. Transcript Events (`.tau/transcripts/{chatId}.jsonl`)

Written by `transcript.middleware.ts` via `append_file` RPC.

**Model response events:**

```json
{
  "timestamp": "2026-03-24T10:30:00.000Z",
  "type": "model_response",
  "contentPreview": "<first 200 chars of content>",
  "toolCalls": ["editFile", "getKernelResult"],
  "hasUsage": true
}
```

**Tool result events:**

```json
{
  "timestamp": "2026-03-24T10:30:01.000Z",
  "type": "tool_result",
  "toolName": "editFile",
  "toolCallId": "tc_abc123",
  "contentLength": 4521
}
```

### B. Conversation History Offload (`.tau/conversation_history/{chatId}.jsonl`)

Written by `compaction.middleware.ts` via `create_file` RPC (overwrite semantics).

```json
{
  "type": "HumanMessage",
  "content": "<full message content>",
  "timestamp": "2026-03-24T10:30:00.000Z"
}
```

### Key Issues

| Issue                                                 | Impact                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| **No user messages** in transcripts                   | Cannot grep for what the user asked                                            |
| **200-char previews only**                            | Cannot search full model reasoning                                             |
| **Overwrite offload**                                 | Prior compaction batches lost on re-compaction                                 |
| **LangChain constructor names** as type discriminator | `m.constructor.name` can be wrong after deserialization (prototype chain loss) |
| **No content in tool_result**                         | Only `contentLength` stored — cannot search tool outputs                       |
| **Separate files**                                    | Must search two locations; neither is complete                                 |

## Finding 3: Schema Differences Matrix

| Dimension              | Cursor                                  | Tau Transcripts                         | Tau History Offload                        |
| ---------------------- | --------------------------------------- | --------------------------------------- | ------------------------------------------ |
| **File path**          | `agent-transcripts/<uuid>/<uuid>.jsonl` | `.tau/transcripts/{chatId}.jsonl`       | `.tau/conversation_history/{chatId}.jsonl` |
| **Write model**        | Append-only                             | Append-only                             | **Overwrite** (create_file)                |
| **User messages**      | Full content                            | **Not stored**                          | Full content (evicted only)                |
| **Assistant messages** | Full content                            | **200-char preview**                    | Full content (evicted only)                |
| **Tool calls**         | Excluded                                | Names only (`toolCalls[]`)              | Excluded                                   |
| **Tool results**       | Excluded                                | Length only (`contentLength`)           | Excluded                                   |
| **Role/type field**    | `role: "user"\|"assistant"`             | `type: "model_response"\|"tool_result"` | `type: "HumanMessage"\|"AIMessage"\|...`   |
| **Content model**      | `message.content[{type, text}]`         | Flat fields                             | Flat `content` field                       |
| **Timestamp**          | Not stored (implicit from append order) | `timestamp` (ISO)                       | `timestamp` (ISO)                          |
| **Line grepability**   | High — full text enables keyword search | **Low** — truncated previews            | Medium — full content but incomplete       |
| **Completeness**       | All turns captured                      | Model + tool events only                | Only evicted messages                      |
| **Subagents**          | Separate files in `subagents/`          | Not implemented                         | Not implemented                            |

## Finding 4: How Cursor Agents Search Transcripts

Cursor injects transcript search instructions in two places:

### 1. System Prompt — `<agent_transcripts>` Block

Injected at the start of every conversation:

```
Agent transcripts (past chats) live in /path/to/agent-transcripts.
They have names like <uuid>.jsonl, cite them to the user as
[<title for chat <=6 words>](<uuid excluding .jsonl>).
NEVER cite subagent transcripts/IDs; you can only cite parent uuids.
Don't discuss the folder structure.
```

This gives the agent awareness of past chats and a citation format, but no search instructions.

### 2. Conversation Summary — `Transcript location:` Block

When a long conversation is summarized (context compaction), the summary includes:

```
### Transcript location:
This is the full JSONL transcript of your past conversation with the user:
/path/to/agent-transcripts/<uuid>/<uuid>.jsonl

If anything about the task or current state is unclear (missing context,
ambiguous requirements, uncertain decisions, exact wording, IDs/paths,
errors/logs), you should consult this transcript.

How to use it:
- Search first for relevant keywords (task name, filenames, IDs, errors, tool names).
- Then read a small window around the matching lines to reconstruct intent and state.
- Avoid reading linearly end-to-end; the file can be very large and some
  single lines can be huge.
- Files contain one structured json event per line including user/assistant
  messages. Currently tool calls and results are excluded.
```

### Search Strategy Extracted

The recommended pattern is:

1. **Keyword grep** → narrow to relevant lines (fast, O(1) context cost)
2. **Windowed read** → read small sections around matches (bounded context cost)
3. **Never linear scan** → avoid reading end-to-end (unbounded context cost)
4. **Search by type** → task names, filenames, IDs, errors, tool names

This is essentially `rg <keyword> transcript.jsonl` → `Read file lines N-5:N+5` — two tool calls per search, predictable context cost.

## Finding 5: Cursor Search Tooling — Grep Plus Semantic Search

From Cursor's March 2026 blog post and semantic search research:

### Dual Search Architecture

| Tool                | Speed          | Strength                                 | When Used                                 |
| ------------------- | -------------- | ---------------------------------------- | ----------------------------------------- |
| **grep** (ripgrep)  | Milliseconds   | Exact keyword matches, regex             | Known symbols, error messages, file paths |
| **Semantic search** | Hundreds of ms | Natural language queries, fuzzy matching | "Where is X handled?", "How does Y work?" |

### Performance Data

- Semantic search adds **12.5% higher accuracy** on codebase questions (6.5–23.5% depending on model)
- **2.6% improvement in code retention** on large codebases (1,000+ files)
- Custom embedding model trained on **agent session traces** — learns from how agents actually navigate code
- Two-pass retrieval: initial search → LLM reranking

### Agent Search Best Practice

From Cursor's blog: "Best practice is to use [semantic search] at the beginning of codebase explorations to fast track finding relevant files/lines. Do not use it to pin point keywords, but use it for broader semantic queries."

The combined strategy:

1. **Semantic search** for exploration ("Find the authentication flow")
2. **grep** for precision ("Find all uses of `createUser`")
3. **Read** for understanding (read specific file ranges from search results)

## Finding 6: CAD Agent Prompt Gaps

The current CAD agent prompt (`cad-agent.prompt.ts`) has no mention of:

| Missing Capability                     | Impact                                                             |
| -------------------------------------- | ------------------------------------------------------------------ |
| Transcript/history search              | Agent cannot reference past conversations or learn from prior work |
| `.tau/transcripts/` awareness          | Agent does not know these files exist                              |
| `.tau/conversation_history/` awareness | Agent cannot access compacted/evicted messages                     |
| Past chat citation                     | No `@Past Chats` equivalent                                        |
| Search strategy guidance               | No instructions for keyword-first, then windowed read              |
| Cross-session continuity               | No mechanism for the agent to recover context from prior sessions  |

The prompt includes `<research_capabilities>` for web search but no section for history search. This is a significant gap — Cursor's agent effectiveness relies heavily on its ability to search both codebases AND past conversations.

## Finding 7: Agentic Transcript Search Best Practices (March 2026)

Based on Cursor's published research, reverse-engineering analysis, and the patterns observed across 275+ transcripts:

### Core Principles

1. **Prevention beats retrieval**: Exclude tool call content from transcripts (Cursor's approach). Tool outputs are ephemeral and often large — storing them inflates transcripts without proportional search value.

2. **Full user + assistant text is non-negotiable**: Truncated previews (Tau's 200 chars) destroy grepability. The keyword you need is rarely in the first 200 characters.

3. **Append-only is required**: Overwrite semantics (Tau's conversation history) lose prior state. Every compaction event should append, not replace.

4. **One file per conversation**: Two files (transcript + history) creates confusion. One append-only JSONL per chat is the proven pattern.

5. **Line-oriented format enables line-oriented tools**: JSONL lines must be independently parseable for `grep`, `head`, `wc -l`, and `jq` to work.

6. **Bounded search, not unbounded read**: Agents must grep first (O(1) context), then read a window (O(k) context), never scan linearly (O(n) context).

### Context Cost Model

| Strategy                          | Context Cost             | When to Use                           |
| --------------------------------- | ------------------------ | ------------------------------------- |
| `grep <keyword> transcript.jsonl` | O(matches × line_length) | Keyword search — fast, bounded        |
| `Read file lines N:N+10`          | O(10 × line_length)      | Windowed read around grep match       |
| `Read file` (full)                | O(total_file_size)       | **Never for transcripts** — too large |
| `head -n 5 transcript.jsonl`      | O(5 × line_length)       | Metadata scan — check if correct chat |

### Subagent Search Delegation

For large-scale transcript mining (e.g., continual learning, cross-session analysis), delegate to subagents with:

- Isolated context windows (don't pollute the main conversation)
- Targeted prompts ("Find all instances where the user preferred X over Y")
- Summary returns (subagent returns findings, not raw transcript lines)

## Recommendations

| #   | Action                                                                    | Priority | Effort | Impact                                            |
| --- | ------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------- |
| R1  | Unify transcript + history offload into single append-only JSONL per chat | P0       | Medium | High — single searchable source of truth          |
| R2  | Store full user + assistant message content (not 200-char previews)       | P0       | Low    | High — enables meaningful keyword grep            |
| R3  | Record user messages in transcripts (currently missing)                   | P0       | Low    | High — user queries are the most-searched content |
| R4  | Exclude tool call/result content from transcripts (store metadata only)   | P0       | Low    | Medium — prevents transcript bloat                |
| R5  | Match Cursor's `{ role, message: { content: [{ type, text }] } }` schema  | P1       | Medium | Medium — interoperability, proven format          |
| R6  | Add `<transcript_search>` section to CAD agent prompt                     | P1       | Low    | High — agent awareness of search capability       |
| R7  | Switch conversation history offload from `create_file` to `append_file`   | P1       | Low    | Medium — preserves prior compaction batches       |
| R8  | Add `beforeModel` hook to transcript middleware for user message capture  | P1       | Low    | High — captures the most-searched content         |
| R9  | Implement `@Past Chats` equivalent — agent tool for cross-session search  | P2       | High   | High — enables cross-session continuity           |
| R10 | Add subagent delegation pattern for transcript mining                     | P3       | Medium | Medium — enables continual learning               |

### Implementation Priority

**Phase 1 — Schema Unification (R1–R4, R7–R8):**
Merge the two middleware output files into one. Add user message capture. Store full content for user + assistant, metadata-only for tool events. Switch to append-only. This makes the existing transcripts grep-searchable.

**Phase 2 — Agent Awareness (R5–R6):**
Align the JSONL schema with Cursor's proven format. Add transcript search instructions to the CAD agent prompt so the agent knows the files exist and how to search them efficiently.

**Phase 3 — Cross-Session Search (R9–R10):**
Build an agent tool for searching past conversations. Delegate transcript mining to subagents to avoid polluting the main conversation's context window.

## Code Examples

### Current Tau Transcript Line (Metadata Only — Not Grepable)

```json
{
  "timestamp": "2026-03-24T10:30:00.000Z",
  "type": "model_response",
  "contentPreview": "I'll create a box with...",
  "toolCalls": ["editFile"],
  "hasUsage": true
}
```

### Proposed Tau Transcript Line (Full Content — Grepable)

```json
{
  "role": "assistant",
  "message": {
    "content": [
      { "type": "text", "text": "I'll create a box with 20mm sides using OpenSCAD. Let me write the code..." }
    ]
  },
  "timestamp": "2026-03-24T10:30:00.000Z"
}
```

### Proposed User Message Line

```json
{
  "role": "user",
  "message": { "content": [{ "type": "text", "text": "Create a simple cube with 20mm sides in OpenSCAD" }] },
  "timestamp": "2026-03-24T10:30:00.000Z"
}
```

### Proposed Tool Event Line (Metadata Only)

```json
{
  "role": "tool",
  "toolName": "editFile",
  "toolCallId": "tc_abc",
  "contentLength": 4521,
  "timestamp": "2026-03-24T10:30:01.000Z"
}
```

### Proposed CAD Agent Prompt Addition

```typescript
const transcriptSection = `
<transcript_search>
Your conversation transcripts are stored as JSONL files at \`.tau/transcripts/{chatId}.jsonl\`.
Each line is a JSON object with \`role\` ("user"|"assistant"|"tool") and message content.

When you need to recall earlier context from the current conversation:
1. **Grep first**: Search for keywords (task names, file paths, error messages, tool names)
2. **Read a window**: Read 5–10 lines around each match to reconstruct context
3. **Never scan linearly**: Transcript files can be very large; do not read end-to-end

Tool results are stored as metadata only (name + content length, not full output).
Full user and assistant message text is available for keyword search.
</transcript_search>`;
```

## Diagrams

### Current State — Two Files, Incomplete

```
┌──────────────────────┐     ┌──────────────────────────┐
│ transcript.middleware │     │ compaction.middleware     │
│                      │     │                          │
│ afterModel           │     │ wrapModelCall             │
│ wrapToolCall          │     │                          │
└──────────┬───────────┘     └──────────┬───────────────┘
           │                            │
           │ append_file                │ create_file (OVERWRITE)
           ▼                            ▼
 .tau/transcripts/{id}.jsonl   .tau/conversation_history/{id}.jsonl
 ┌────────────────────┐        ┌─────────────────────────────┐
 │ model_response     │        │ HumanMessage (full)          │
 │  - 200 char preview│        │ AIMessage (full)             │
 │  - tool names      │        │ ToolMessage (full)           │
 │ tool_result         │        │                             │
 │  - content length  │        │ ⚠ Overwrites on each        │
 │                    │        │   compaction cycle            │
 │ ⚠ No user messages│        └─────────────────────────────┘
 └────────────────────┘
```

### Proposed State — Single Unified File

```
┌──────────────────────┐     ┌──────────────────────────┐
│ transcript.middleware │     │ compaction.middleware     │
│                      │     │                          │
│ beforeModel (NEW)    │     │ wrapModelCall             │
│ afterModel           │     │  └─ append evicted msgs  │
│ wrapToolCall          │     │                          │
└──────────┬───────────┘     └──────────┬───────────────┘
           │                            │
           │ append_file                │ append_file (APPEND)
           ▼                            ▼
              .tau/transcripts/{id}.jsonl
              ┌───────────────────────────┐
              │ user    → full content     │
              │ assistant → full content   │
              │ tool    → metadata only    │
              │ compaction → marker event  │
              │                           │
              │ ✓ Append-only              │
              │ ✓ All turns captured       │
              │ ✓ Grep-searchable          │
              └───────────────────────────┘
```

## References

### Primary Sources

- Cursor IDE agent-transcripts directory (275+ conversations, March 2026)
- Cursor system prompt `<agent_transcripts>` injection (extracted from transcript mining)
- Cursor conversation summary `Transcript location:` instructions
- [Best practices for coding with agents — Cursor Blog](https://cursor.com/blog/agent-best-practices) (March 2026)
- [Improving agent with semantic search — Cursor Blog](https://www.cursor.so/blog/semsearch) (March 2026)
- [Cursor Subagents Complete Guide](https://medium.com/@codeandbird/cursor-subagents-complete-guide-5853e8d39176) (March 2026)

### Tau Internal References

- `apps/api/app/api/chat/middleware/transcript.middleware.ts` — Current transcript writer
- `apps/api/app/api/chat/middleware/compaction.middleware.ts` — Conversation history offloader
- `apps/api/app/api/chat/prompts/cad-agent.prompt.ts` — CAD agent system prompt
- `docs/research/cursor-filesystem-architecture.md` — Cursor filesystem audit
- `docs/research/context-summarization-compaction.md` — Context compression techniques
- `docs/policy/filesystem-policy.md` — Filesystem architecture policy

### Design Patterns

| Pattern                       | Cursor                  | Tau Current         | Tau Proposed                           |
| ----------------------------- | ----------------------- | ------------------- | -------------------------------------- |
| **Append-only JSONL**         | Transcripts             | Transcripts only    | Both transcript + history              |
| **Full content storage**      | User + assistant        | 200-char preview    | User + assistant full                  |
| **Tool content exclusion**    | All tool I/O excluded   | Content length only | Metadata only (name, ID, length)       |
| **User message capture**      | Included                | **Missing**         | Include via `beforeModel` hook         |
| **Agent search instructions** | System prompt + summary | **Missing**         | `<transcript_search>` prompt section   |
| **Citation format**           | `[title](uuid)`         | Not implemented     | Adapt for chatId-based lookup          |
| **Subagent transcripts**      | Separate files          | Not implemented     | Future: separate `.jsonl` per subagent |
