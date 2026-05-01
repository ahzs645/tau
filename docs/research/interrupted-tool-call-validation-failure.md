---
title: 'Interrupted Tool Call Validation Failure'
description: 'Root-cause investigation of "Validation failed: messages.N.parts.M: Invalid input" after a user interrupts a streaming tool call, with recovery design that preserves Anthropic / Vertex / OpenAI provider contracts.'
status: draft
created: '2026-04-23'
updated: '2026-04-23'
category: investigation
related:
  - docs/research/chat-error-persistence-stale-display.md
  - docs/policy/context-engineering-policy.md
  - docs/policy/testing-policy.md
---

# Interrupted Tool Call Validation Failure

Investigates why every regenerate / "continue" after a user-interrupted tool call returns `Validation failed: messages.1.parts.34: Invalid input`, why no existing repair middleware is reached, and how to recover gracefully without breaking provider contracts (Anthropic, Google Vertex, OpenAI).

## Executive Summary

When a user interrupts a tool call while the LLM is still streaming the tool's input arguments (typical Stop button mid-stream), Tau's UI client transitions the affected `tool-*` part from `input-streaming` (where `input` is a Zod-`partial()` object) to `output-error` (where the strict tool input schema is required) **without rewriting the partial input**. The resulting part is persisted to IndexedDB and re-sent on every subsequent request.

The chat API's NestJS-Zod validation pipe rejects the request at the door because Tau's `uiMessagesSchema` (`libs/chat/src/schemas/message.schema.ts:86`) requires the **full strict per-tool `inputSchema`** for every state — including `output-error` — whereas the upstream AI SDK schema typed as `input: z.unknown()` and only validated input against the strict schema _opportunistically_ in `safeValidateUIMessages`. The repair middleware that already exists for orphaned tool calls (`messageContentSanitizerMiddleware`) never runs because the request fails Zod validation **before reaching the controller**.

The fix is a one-line schema relaxation backed by client-side input sanitization on the `output-error` transition (and a `rawInput` carry-over field for forensics). Provider contracts are unaffected because `convertToModelMessages` already tolerates `input: undefined | partial` on `output-error` and the existing sanitizer middleware injects synthetic `tool_result` blocks.

## Problem Statement

### Symptom

A chat with the following final message tail (Gemini 3 Pro, OpenCascade kernel):

```
assistant
  …
  ├─ tool-edit_file (output-available)
  ├─ tool-get_kernel_result (output-available, status=error)
  └─ tool-read_file (state=output-error, errorText="USER_INTERRUPTED",
                     input={ limit: 15 })   ← part #34
user "continue"
user "continue"
```

…produces an inline chat error card on every retry:

> **Processing Error**
> Validation failed: messages.1.parts.34: Invalid input
> [ Retry ]

The user can never recover because:

1. The retry replays the same persisted `messages` array.
2. The bad part is in the assistant message at index 1 (already persisted to IndexedDB by `chat-session-store.ts:429`).
3. No recovery action is offered beyond Retry.

### Why this only manifested now

The smoking-gun part is `tool-read_file` with `input: { limit: 15 }`. The Gemini stream emitted only the `limit: 15` argument before the user clicked Stop; `targetFile` (a required field on `readFileInputSchema`) was never streamed. The interrupt-finalizer flips this part to `output-error` but **keeps the partial `{ limit: 15 }`**, which fails the strict-input branch of the discriminated union.

## Methodology

1. Traced the offending payload's `parts[34]` shape (state `output-error`, partial `input`) against `uiMessagesSchema` in `libs/chat/src/schemas/message.schema.ts`.
2. Located the client-side transition that produces the offending part (`finalizeInterruptedToolParts` in `apps/ui/app/utils/chat.utils.ts`) and the persistence path that ships it to the API (`chat-session-store.ts` ↔ `chatPersistenceMachine`).
3. Walked the API entry point: `ChatController.createChat` ← `CreateChatDto` ← `createZodDto(createChatSchema)` ← `uiMessagesSchema`. Confirmed `nestjs-zod`'s pipe runs **before** `extractRequestConfig` / `prepareMessages` / any middleware.
4. Cross-checked the upstream AI SDK contract in `node_modules/ai/src/ui/validate-ui-messages.ts` (the file Tau's schema was forked from) and `node_modules/ai/src/ui/convert-to-model-messages.ts` to see how partial-input `output-error` parts flow into provider messages.
5. Verified the existing server-side sanitizers (`messageContentSanitizerMiddleware.insertSyntheticToolResults`) and the LangChain adapter (`@ai-sdk/langchain` `convertAssistantContent` / `convertToolResultPart`) handle partial inputs and orphaned tool calls.

## Findings

### Finding 1: Tau's `uiMessagesSchema` is **stricter** than upstream's on `output-error` input

Tau forked the AI SDK validator wholesale and then **re-typed `input` as the per-tool strict schema across all four tool states**:

```typescript
// libs/chat/src/schemas/message.schema.ts:86-95 (output-error branch)
z.object({
  type: z.literal(toolType),
  toolCallId: z.string(),
  state: z.literal('output-error'),
  providerExecuted: z.boolean().optional(),
  input: inputSchema,            // ← strict, required, full schema
  output: z.never().optional(),
  errorText: z.string(),
  callProviderMetadata: providerMetadataSchema.optional(),
}),
```

Upstream uses `z.unknown()` everywhere and validates the strict shape _only_ if the caller passes a `tools` map and the state is `input-available` / `output-available`. The `output-error` branch even has a deliberate guard:

```typescript
// node_modules/ai/src/ui/validate-ui-messages.ts:421-426
if (
  toolPart.state === 'input-available' ||
  toolPart.state === 'output-available' ||
  (toolPart.state === 'output-error' && toolPart.input !== undefined)
) {
  await validateTypes({ value: toolPart.input, schema: tool.inputSchema, … });
}
```

The upstream `output-error` branch additionally exposes a `rawInput: z.unknown().optional()` field (introduced precisely for this case — see Finding 6) and ships approval-related states (`approval-requested`, `approval-responded`, `output-denied`) Tau hasn't picked up.

**Conclusion**: Tau's strictness was intentional for `input-available` / `output-available` (we want the LLM to be told its inputs are wrong via the input-validation error path), but **applying the same strictness to `output-error` is incorrect by construction** — the whole point of `output-error` is to record a state where the round-trip never completed. Forcing the strict schema there means partial / interrupted / corrupted inputs can never be persisted **or replayed**.

### Finding 2: `finalizeInterruptedToolParts` re-states the part but never sanitizes the input

`apps/ui/app/utils/chat.utils.ts:409-445`:

```typescript
const updatedParts = lastMessage.parts.map((part) => {
  if (isToolPart(part) && (part.state === 'input-streaming' || part.state === 'input-available')) {
    // Assertion needed: input-streaming parts have PartialObject<Schema> for `input`,
    // but output-error expects the full Schema. The partial input is acceptable
    // for display purposes since the tool was interrupted.
    const errorText = JSON.stringify({
      errorCode: 'USER_INTERRUPTED',
      message: 'Interrupted by user.',
      toolCallId: part.toolCallId,
    });
    const interruptedPart = { ...part, state: 'output-error', errorText };
    return interruptedPart as MyMessagePart; // ← cast hides the type hole
  }
  return part;
});
```

The inline comment **acknowledges the type hole** ("input-streaming parts have PartialObject<Schema>… but output-error expects the full Schema. The partial input is acceptable for display purposes") and routes around it with `as MyMessagePart`. The only consumer that was checked was the local React renderer; the wire round-trip back through the API was never proven to accept this shape.

This is the local smoking gun. Once the assertion lies to the type system, the schema mismatch only surfaces at runtime on the next API submission.

### Finding 3: Server-side validation runs before any repair middleware

The chat controller is annotated:

```typescript
// apps/api/app/api/chat/chat.controller.ts:46-63
@UseFilters(ChatExceptionFilter)
@UseGuards(AuthGuard)
@Controller({ path: 'chat', version: '1' })
export class ChatController {
  @Post()
  public async createChat(@Body() body: CreateChatDto, …) { … }
}
```

`CreateChatDto` is `createZodDto(createChatSchema)` whose `messages` field is `uiMessagesSchema` (`apps/api/app/api/chat/chat.dto.ts:14`). NestJS-Zod's `ZodValidationPipe` runs before the controller method; on failure it throws `ZodValidationException`, which `ChatExceptionFilter` catches and renders as the user-facing `Validation failed: messages.1.parts.34: Invalid input` chat error (`apps/api/app/api/chat/chat-exception.filter.ts:35-49`).

Repair logic that _does_ understand interrupted tool calls — `messageContentSanitizerMiddleware.insertSyntheticToolResults` (`apps/api/app/api/chat/middleware/message-content-sanitizer.middleware.ts:134-191`), `toolErrorHandlerMiddleware`, etc. — runs **inside the LangGraph stream**, which is constructed only after `prepareMessages → toBaseMessages` succeeds. So none of those mitigations are reachable for a request that fails the schema gate.

This is a **defense-in-depth gap**: the server has all the right repair primitives, but the gatekeeper rejects requests carrying the very shapes those primitives were built to repair.

### Finding 4: Provider contracts (Anthropic / Vertex / OpenAI) tolerate this case once it gets past the gate

Because the request never reaches the agent, the natural worry is "would the LLM provider have rejected the partial-input message anyway?" Reading the conversion path top-down:

1. `chat.controller.ts:252` calls `toBaseMessages(messagesWithContext)` from `@ai-sdk/langchain`.
2. `toBaseMessages` (`node_modules/@ai-sdk/langchain/src/adapter.ts:44-49`) delegates to `ai`'s `convertToModelMessages` then `convertModelMessages`.
3. `convertToModelMessages` for a `tool-*` part in `output-error` state explicitly falls back to `rawInput`:

   ```typescript
   // node_modules/ai/src/ui/convert-to-model-messages.ts:175-189
   if (part.state !== 'input-streaming') {
     content.push({
       type: 'tool-call' as const,
       toolCallId: part.toolCallId,
       toolName,
       input:
         part.state === 'output-error'
           ? (part.input ?? ('rawInput' in part ? part.rawInput : undefined))
           : part.input,
       …
     });
   }
   ```

4. `convertAssistantContent` (`@ai-sdk/langchain/src/utils.ts:80-108`) constructs an `AIMessage` with `tool_calls: [{ id, name, args }]` — `args` accepts whatever object (or `undefined`).
5. The LangGraph `messageContentSanitizerMiddleware.insertSyntheticToolResults` (`apps/api/app/api/chat/middleware/message-content-sanitizer.middleware.ts:134-191`) then walks the message list and inserts a synthetic `ToolMessage` with `JSON.stringify({ errorCode: 'USER_INTERRUPTED', message: 'Tool execution was interrupted.', toolName, toolCallId })` for any unmatched `tool_call` (idempotent — keyed by `tool_call_id`).
6. `ensureTextContent` (same file, lines 17-102) makes sure assistant messages with reasoning-only blocks gain a non-empty placeholder text block, satisfying Anthropic's `messages.N: all messages must have non-empty content` constraint.

Per-provider behavior with a `tool_use`/`functionCall`/`tool_calls` block holding a partial argument JSON paired with a synthetic error `tool_result`/`functionResponse`/`tool` message:

| Provider                | Block format                                                                    | Tolerance for partial args                                      | Required pairing                                                         | Status                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Anthropic Messages API  | `tool_use` (input as JSON object) + `tool_result` (content as string/blocks)    | Accepts any JSON object as `input`; no schema check on the wire | Every `tool_use` must have a `tool_result` in the next user/tool message | ✅ Handled — synthetic `tool_result` provided by sanitizer + non-empty content guaranteed by `ensureTextContent` |
| Google Vertex / Gemini  | `functionCall` (`name`, `args`) + `functionResponse` (`name`, `response`)       | Accepts any object for `args`                                   | Every `functionCall` must have a matching `functionResponse`             | ✅ Handled — same sanitizer; `name` is preserved on the synthetic ToolMessage                                    |
| OpenAI Chat Completions | `assistant.tool_calls[].function.arguments` (stringified JSON) + `tool` message | Accepts any string as `arguments` (parsed loosely)              | Every `tool_call` id must have a `tool` message reply                    | ✅ Handled — same sanitizer                                                                                      |

**Conclusion**: relaxing the input shape on `output-error` does not break provider contracts. All three providers care about (a) shape of the wrapper block and (b) presence of a matching tool_result, both of which the existing pipeline already guarantees.

### Finding 5: The `errorText` JSON omits `toolName`, an inconsistency with `ToolUserInterruptedError`

`ToolUserInterruptedError` (`libs/chat/src/types/tool.types.ts:118-123`) is typed:

```typescript
export type ToolUserInterruptedError = {
  errorCode: 'USER_INTERRUPTED';
  message: string;
  toolName: string;
  toolCallId: string;
};
```

…but `finalizeInterruptedToolParts` writes:

```typescript
JSON.stringify({ errorCode: 'USER_INTERRUPTED', message: 'Interrupted by user.', toolCallId: part.toolCallId });
```

— `toolName` is missing. The server-side counterpart (`message-content-sanitizer.middleware.ts:171-178`) does include it. This isn't the cause of the validation failure (the schema only requires `errorText: z.string()`), but it weakens the structured-error contract used by `<StructuredToolError>` and breaks display parity between client-finalized interrupts and server-finalized interrupts. Worth fixing alongside the primary repair.

### Finding 6: Upstream's `rawInput` field is the canonical home for partial / corrupt inputs

The AI SDK's reducer (`node_modules/ai/src/ui/process-ui-message-stream.ts:560-577`) emits a `tool-input-error` chunk that carries the raw input:

```typescript
case 'tool-input-error': {
  …
  rawInput: chunk.input,
  …
}
```

…and the `output-error` branch of the validator schemas it as `rawInput: z.unknown().optional()` (`validate-ui-messages.ts:155, 260`). The intent is exactly what we need: a place to keep the partial input for forensics / display without requiring it to satisfy the strict schema.

Tau already accumulates partial input via the streaming reducer (`input` is `PartialObject<Schema>` while `state === 'input-streaming'`), so on the interrupt transition we can either:

- (Conservative) sanitize away `input` entirely so the wire shape contains only `state`, `toolCallId`, `errorText`.
- (Better) move `input` → `rawInput` and clear `input`, matching upstream semantics, so the LLM still sees the partial JSON in the reconstructed `tool_use.input`.

### Finding 7: Three orthogonal repair seams, each carrying weight

The right answer is not "fix one thing"; it is to make the schema and three sanitization seams consistent. Each seam exists for its own reason; each currently carries a partial fix:

| Seam                           | File                                                                                                                                | Today                                                                          | Gap                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Wire schema                    | `libs/chat/src/schemas/message.schema.ts:86-95` (and the empty-input variant `:142-152`, plus the `dynamic-tool` branch `:284-294`) | Strict input on every state                                                    | Reject partial / interrupted inputs at the door                                                             |
| Client finalizer               | `apps/ui/app/utils/chat.utils.ts:409-445`                                                                                           | Re-states + casts away type                                                    | Doesn't sanitize `input`, omits `toolName`                                                                  |
| Server input sanitizer         | (does not exist)                                                                                                                    | n/a                                                                            | No server fallback if a malformed part still slips through (e.g. a different client, an old persisted chat) |
| Server orphaned-call sanitizer | `apps/api/app/api/chat/middleware/message-content-sanitizer.middleware.ts:134-191`                                                  | Inserts synthetic `ToolMessage` for `tool_call` with no matching `ToolMessage` | Already correct; **never runs** for interrupted parts because schema rejects first                          |

### Finding 8: Tau's schema also lacks the new approval states (out-of-scope for this fix, but worth flagging)

Upstream `validate-ui-messages.ts:206-236, 272-286` adds `approval-requested`, `approval-responded`, `output-denied` states for human-in-the-loop tool approval. Tau's copy doesn't include them. Not the source of the current bug, but the same fork-and-tighten pattern that produced this bug will produce the next one when human-in-the-loop arrives. Track separately.

### Finding 9: Persistence path makes the bug sticky

`chat-session-store.ts:424-451` writes the sanitized (but still type-hole'd) message back to IndexedDB on `applyFinishedRequest`, `applyStoppedRequest`, and `applyResumedRequest`. Once the bad shape is on disk, every regenerate/edit/retry replays it. There is no migration path; the user has to either delete the chat or manually trim the offending message. The inline error card offers only `[ Retry ]` (`apps/ui/app/components/chat/chat-tool-error.tsx`), which deterministically fails again. This is also why the screenshot shows two queued `continue` messages — the state machine accepted them but the request was rejected each time.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Priority | Effort          | Impact                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------------- | ------------------------------------ |
| R1  | **Relax `output-error` branch in `uiMessagesSchema`** to accept `input: z.unknown().optional()` and add `rawInput: z.unknown().optional()`. Apply identically to `createToolSchemas`, `createEmptyInputToolSchemas`, and the existing `dynamic-tool` `output-error` branch (already loose via `z.unknown()`, just add `rawInput`). Aligns Tau with the AI SDK contract and unblocks every interrupted-tool replay.                                                                                                                         | **P0**   | ~15 LOC + tests | High — primary user unblock          |
| R2  | **Update `finalizeInterruptedToolParts`** to (a) move the partial `input` into `rawInput`, (b) reset `input` to `undefined`, (c) populate `toolName` in the `errorText` JSON to match `ToolUserInterruptedError`. Drop the `as MyMessagePart` escape hatch — the type hole disappears once R1 lands.                                                                                                                                                                                                                                       | **P0**   | ~20 LOC         | High — closes the leak at source     |
| R3  | **Add `messageInputSanitizerMiddleware`** to the API: walk `messages`, for any tool part in `output-error` whose `input` does not satisfy the per-tool input schema, move it to `rawInput` and clear `input`. Runs as a Zod `.transform` on `uiMessagesSchema` so it's applied **inside validation**, not after — meaning even legacy persisted chats (created before R1/R2) recover automatically without bypassing schema discipline. Symmetric to the existing `messageContentSanitizerMiddleware` defense-in-depth philosophy.         | **P0**   | ~40 LOC + tests | High — heals existing stuck chats    |
| R4  | **Add a regression test** that round-trips a `tool-read_file` part with `state: 'output-error'`, `input: { limit: 15 }`, `errorText: '…USER_INTERRUPTED…'` through `uiMessagesSchema.safeParse` and through `convertToModelMessages` → `toBaseMessages` → `messageContentSanitizerMiddleware`, asserting (a) Zod accepts the shape, (b) the resulting LangChain `AIMessage` has a `tool_calls` block, (c) a synthetic `ToolMessage` with `errorCode: 'USER_INTERRUPTED'` is appended. Wire it into `libs/chat` and `apps/api` test suites. | **P0**   | ~80 LOC         | High — locks in fix                  |
| R5  | **Surface "skip & continue" in the inline error card** for `VALIDATION_ERROR` chat errors. Today only `[ Retry ]` is offered, which is guaranteed to fail until R3 ships. Adding "Discard last assistant message and resend" gives users a manual escape valve and unblocks them on legacy IndexedDB stores even if R3 misses a corner case. Reuse the persistence machine's `retry` event with a sliced messages array.                                                                                                                   | **P1**   | ~40 LOC + UX    | Medium — defensive UX                |
| R6  | **Promote provider-contract round-trip tests** in `apps/api/app/api/chat/middleware/message-content-sanitizer.middleware.test.ts` to also cover the partial-input-on-output-error case end-to-end against fake Anthropic / Gemini / OpenAI request bodies (assert tool_use/functionCall/tool_calls + tool_result/functionResponse/tool pairing). Pre-empts regressions when the AI SDK or LangChain adapters change.                                                                                                                       | **P1**   | ~120 LOC        | Medium — provider-contract guardrail |
| R7  | **Backfill missing AI SDK states** (`approval-requested`, `approval-responded`, `output-denied`, `rawInput` everywhere) into `uiMessagesSchema` to keep the fork from drifting further. Non-functional today but pre-empts the same bug pattern when human-in-the-loop tool approval is wired up. Track in a separate PR alongside the AI SDK upgrade cadence.                                                                                                                                                                             | **P2**   | ~100 LOC        | Low (now), High (later)              |
| R8  | **Document the contract** in a short ADR / `docs/policy/` note: "tool parts in `output-error` are forensic records, not commitments to a valid prior input — keep `input` loose, prefer `rawInput`, never block message replay on schema-strict input here." Prevents a future contributor from re-tightening the schema for type-safety reasons and reintroducing this bug.                                                                                                                                                               | **P2**   | ~50 LOC         | Low — durable guardrail              |

## Trade-offs

| Approach                                                | Pros                                                                             | Cons                                                                                                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Relax schema only (R1)**                              | Smallest blast radius; matches upstream                                          | Bad shapes can still be persisted; no automatic healing for legacy chats; depends on R2 to stop creating new ones                                        |
| **Sanitize on client only (R2)**                        | Stops new bad shapes at source                                                   | Doesn't help legacy persisted chats; client must be perfectly reliable                                                                                   |
| **Sanitize in Zod transform on server (R3)**            | Heals legacy chats automatically; lives inside validation so it can't be skipped | Adds per-request cost (one schema-compatibility check per tool part in `output-error`); needs careful testing on every tool's input schema               |
| **Drop the part entirely on the server** (rejected)     | Simple                                                                           | Loses forensic info; breaks `tool_use`/`tool_result` pairing if not also paired with synthetic injection; surprising to users who saw the part in the UI |
| **Reject persistently with a clearer error** (rejected) | Smallest server change                                                           | Doesn't recover; user still stuck; "Validation failed" is not actionable                                                                                 |

Recommended composite: **R1 + R2 + R3 + R4** ship together. R1 alone is incomplete. R3 alone leaves a continued type hole on the client. The four changes together are mutually reinforcing and add roughly 150 LOC + tests.

## Code Examples

### A. Schema relaxation (R1)

```typescript
// libs/chat/src/schemas/message.schema.ts (output-error branch in createToolSchemas)
z.object({
  type: z.literal(toolType),
  toolCallId: z.string(),
  state: z.literal('output-error'),
  providerExecuted: z.boolean().optional(),
  input: z.unknown().optional(),       // ← was: inputSchema
  rawInput: z.unknown().optional(),    // ← new, mirrors AI SDK
  output: z.never().optional(),
  errorText: z.string(),
  callProviderMetadata: providerMetadataSchema.optional(),
}),
```

(Same change applied in `createEmptyInputToolSchemas` and in the existing `dynamic-tool` `output-error` branch — add `rawInput`.)

### B. Client finalizer rewrite (R2)

```typescript
// apps/ui/app/utils/chat.utils.ts
const updatedParts = lastMessage.parts.map((part) => {
  if (!isToolPart(part)) return part;
  if (part.state !== 'input-streaming' && part.state !== 'input-available') return part;

  const errorText = JSON.stringify({
    errorCode: 'USER_INTERRUPTED',
    message: 'Interrupted by user.',
    toolName: getStaticToolName(part), // ← Finding 5
    toolCallId: part.toolCallId,
  } satisfies ToolUserInterruptedError);

  return {
    type: part.type,
    toolCallId: part.toolCallId,
    state: 'output-error',
    rawInput: part.input, // ← Finding 6: forensic carry-over
    errorText,
    callProviderMetadata: part.callProviderMetadata,
  } as MyMessagePart; // cast still needed until MyTools narrows
});
```

### C. Server-side healing transform (R3)

```typescript
// libs/chat/src/schemas/message.schema.ts (apply at array level after the union)
const sanitizeInterruptedToolParts: z.ZodEffects<typeof rawUiMessagesSchema> = rawUiMessagesSchema.transform(
  (messages) =>
    messages.map((m) => ({
      ...m,
      parts: m.parts.map((p) => {
        if (!('state' in p) || p.state !== 'output-error') return p;
        if (!('input' in p) || p.input === undefined) return p;
        const inputSchema = inputSchemaForToolType(p.type);
        if (!inputSchema || inputSchema.safeParse(p.input).success) return p;
        return { ...p, rawInput: p.input, input: undefined };
      }),
    })),
);

export const uiMessagesSchema = sanitizeInterruptedToolParts;
```

`inputSchemaForToolType` is a small `Map<\`tool-\${ToolName}\`, z.ZodTypeAny>`derived from the same`createToolSchemas` calls already on this file.

### D. Round-trip regression test (R4)

```typescript
// libs/chat/src/schemas/message.schema.test.ts (excerpt)
it('accepts an interrupted tool-read_file part with partial input', () => {
  const result = uiMessagesSchema.safeParse([
    baseMessage([
      {
        type: 'tool-read_file',
        toolCallId: 'call_test',
        state: 'output-error',
        input: { limit: 15 }, // missing required targetFile
        errorText: JSON.stringify({
          errorCode: 'USER_INTERRUPTED',
          message: 'Interrupted by user.',
          toolName: 'read_file',
          toolCallId: 'call_test',
        }),
      } as MyMessagePart,
    ]),
  ]);

  expect(result.success).toBe(true);
  // After R3 transform: input moves to rawInput
  const part = result.data?.[0]?.parts[0] as Extract<MyMessagePart, { state: 'output-error' }>;
  expect(part.input).toBeUndefined();
  expect(part.rawInput).toEqual({ limit: 15 });
});
```

## Diagrams

### State transition before fix

```
LLM streaming tool args
  │
  ▼
[input-streaming]   input: { limit: 15 }   ← partial
  │
  │ user clicks Stop
  ▼
finalizeInterruptedToolParts (client)
  │   spreads ...part, flips state, adds errorText
  │   leaves input: { limit: 15 } intact
  │   casts result `as MyMessagePart`        ← TYPE HOLE
  ▼
[output-error]      input: { limit: 15 }
                    errorText: "{...USER_INTERRUPTED...}"
  │
  │ persist to IndexedDB
  ▼
useChat regenerate → POST /v1/chat
  │
  ▼
NestJS-Zod ValidationPipe (uiMessagesSchema)
  │   output-error branch requires inputSchema (targetFile required)
  │   → ZodError → ZodValidationException
  ▼
ChatExceptionFilter → "Validation failed: messages.1.parts.34: Invalid input"
  │
  └─ User sees inline error card, [Retry] reproduces the same failure
```

### State transition after fix

```
[input-streaming]   input: { limit: 15 }
  │
  │ user clicks Stop
  ▼
finalizeInterruptedToolParts                ← R2: move input → rawInput
  │
  ▼
[output-error]      input: undefined
                    rawInput: { limit: 15 }
                    errorText: "{...USER_INTERRUPTED...}"
  │
  ▼
ValidationPipe (relaxed schema R1, sanitize transform R3)
  │
  ▼
extractRequestConfig → prepareMessages → toBaseMessages
  │
  ▼
LangChain AIMessage(content="…", tool_calls=[{ id, name, args: { limit: 15 } }])
  │
  ▼
messageContentSanitizerMiddleware
  │   ensureTextContent (Anthropic non-empty content guard)
  │   insertSyntheticToolResults (USER_INTERRUPTED tool_result)
  ▼
streamText / Vertex / Anthropic / OpenAI ─── chat continues
```

## References

- Upstream AI SDK validator: `node_modules/ai/src/ui/validate-ui-messages.ts:184-271, 421-426`
- Upstream UI message conversion: `node_modules/ai/src/ui/convert-to-model-messages.ts:172-225`
- LangChain adapter: `node_modules/@ai-sdk/langchain/src/adapter.ts:44-92`, `utils.ts:45-108`
- Tau schema (forked & tightened): `libs/chat/src/schemas/message.schema.ts:86-95, 142-152, 284-294`
- Tau client finalizer: `apps/ui/app/utils/chat.utils.ts:409-445`
- Tau persistence path: `apps/ui/app/services/chat-session-store.ts:424-451`
- Tau API entry: `apps/api/app/api/chat/chat.controller.ts:46-92, 252`
- Tau exception filter: `apps/api/app/api/chat/chat-exception.filter.ts:35-49`
- Tau orphaned-call sanitizer: `apps/api/app/api/chat/middleware/message-content-sanitizer.middleware.ts:134-235`
- Related: `docs/research/chat-error-persistence-stale-display.md` (covers persistence-machine ↔ AI SDK wiring; this doc extends that work to the wire schema)

## Appendix: full part 34 payload

For posterity, the offending part as captured from the failing request body:

```json
{
  "type": "tool-read_file",
  "toolCallId": "call_ad6083d2",
  "state": "output-error",
  "input": { "limit": 15 },
  "errorText": "{\"errorCode\":\"USER_INTERRUPTED\",\"message\":\"Interrupted by user.\",\"toolCallId\":\"call_ad6083d2\"}"
}
```

Schema branch matched (and rejected): `libs/chat/src/schemas/message.schema.ts:86-95`. Failing field path: `messages.1.parts.34.input.targetFile` (required string, missing).
