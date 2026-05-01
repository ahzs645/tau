---
title: 'Agent Screenshot RPC Resize Audit'
description: 'Follow-up tracking doc for the agent-side screenshot RPC chain: agent-tool-issued screenshots are not currently routed through resizeImageForChat and are out of scope of the chat-image chokepoint shipped in chat-image-resize-coverage-audit.'
status: draft
created: '2026-04-24'
updated: '2026-04-24'
category: audit
related:
  - docs/research/chat-image-resize-coverage-audit.md
  - docs/research/image-context-management-gap-analysis.md
---

# Agent Screenshot RPC Resize Audit

Tracking doc for the **agent-tool screenshot pathway** — the RPC chain that lets the LangGraph agent capture viewport / view screenshots through `apps/ui/app/hooks/rpc-handlers.ts` and surface them as tool-result chat parts. This pathway was deliberately excluded from `docs/research/chat-image-resize-coverage-audit.md` (R6) and is captured here so it does not slip through the cracks.

## Scope and Non-Goals

**In scope**: Screenshots captured by the **agent** via RPC (tool calls like `capture_screenshot`) and persisted as tool-result chat parts in `MyUIMessage`.

**Out of scope**: User-initiated screenshots/uploads (those 12 entry points are covered end-to-end by the `imageProcessing` chokepoint in `apps/ui/app/hooks/draft.machine.ts`). Image storage / context-management strategy (tracked separately in `image-context-management-gap-analysis.md` and `image-storage-architecture.md`).

## Problem Statement

The chat-image resize chokepoint shipped in `chat-image-resize-coverage-audit.md` covers every **user-facing** image entry point — anything that flows through `addDraftImage` / `addEditDraftImage` is normalised to ≤ `MAX_DATA_URL_LENGTH` (≈ 1 MB) before persistence.

The agent-side RPC chain bypasses that chokepoint entirely. When a tool call like `capture_screenshot` returns image bytes:

1. `apps/ui/app/hooks/rpc-handlers.ts:328` (and the analogous handler at `:387`) drives `screenshotRequestMachine` to capture the requested view(s).
2. The resulting raw data URL(s) are returned to the agent as the tool-call result.
3. The result is persisted into the tool-result `MyUIMessage` part and sent back through the LLM context window on every subsequent turn.

Anthropic re-resizes server-side to 1568px regardless, so the _quality_ impact is nil — but every oversized payload still costs:

- IndexedDB / Postgres write amplification on the persisted chat row.
- Wire bytes between the agent and the API for every tool-result re-emission.
- LangGraph context-window padding when chat compaction replays the tool result.

The leak is silent: the agent loop functions correctly, no error fires.

## Out of scope of chat-image-resize-coverage-audit, tracked here

The agent RPC chain is structurally independent from the `<ChatTextarea>` user-input chokepoint:

- **Different boundary** — RPC is API-to-UI (agent → tool result), not user-to-machine (DOM event → draft).
- **Different surface area** — driven by the LangGraph tool registry in `libs/chat/`, not by the 12 UI entry points.
- **Different consumers** — the resized output goes into tool-result chat parts, which are read back into the agent context, not into `draftImages`.

Folding it into the user-facing chokepoint would have either (a) required threading the draft machine through every RPC handler (architecturally wrong — RPC has no draft-machine instance) or (b) duplicated the chokepoint logic. The audit explicitly chose to scope the user-facing chain first and track the RPC chain separately.

## Recommendations

| #   | Action                                                                                                                                                                                                              | Priority | Effort | Impact                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------ |
| R1  | Wrap the RPC screenshot results in `apps/ui/app/hooks/rpc-handlers.ts` (lines 328 + 387) through `resizeImageForChat()` before resolving the tool-call promise. Keep the call site close to the screenshot machine. | P1       | Low    | Closes the silent agent-tool wire-size leak.     |
| R2  | Consider a separate, larger byte cap for agent-facing screenshots (e.g. 2 MB instead of 1 MB) since Anthropic re-resizes server-side and the agent benefits from higher fidelity in the per-call analysis pass.     | P3       | Low    | Tunes cost vs. fidelity for the agent loop only. |

R1 is the substantive item. R2 is a downstream tuning question that should not block R1.

## Implementation Notes

The cleanest place to inject the resize is inside the RPC handler immediately after `screenshotRequestMachine` resolves and immediately before returning the data URL to the LangGraph tool call. This keeps the chokepoint at the same boundary as the user-facing draft machine (right at the producer of the data URL) without coupling the RPC to a long-lived state machine.

A focused regression test along the lines of `apps/ui/app/components/chat/chat-image-resize-contract.test.tsx` should mirror the pattern: drive the RPC handler with an oversized synthetic screenshot, assert the returned tool-result data URL is `<= MAX_DATA_URL_LENGTH`. The export of `MAX_DATA_URL_LENGTH` from `apps/ui/app/utils/resize-image.ts` (added during the user-facing chokepoint implementation) makes this trivial.

## References

- `docs/research/chat-image-resize-coverage-audit.md` — the user-facing chokepoint (12 entry points; shipped).
- `docs/research/image-context-management-gap-analysis.md` — broader image-in-context architecture.
- `apps/ui/app/hooks/rpc-handlers.ts` — current RPC implementation.
- `apps/ui/app/machines/screenshot-request.machine.ts` — underlying capture engine.
- `apps/ui/app/utils/resize-image.ts` — `resizeImageForChat()` + `MAX_DATA_URL_LENGTH`.
