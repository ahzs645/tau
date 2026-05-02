---
title: 'Interrupted Tool-Call Contract Policy'
description: 'Schema and provider-adapter rules for tool parts left in output-error after a user interrupt'
status: active
created: '2026-04-23'
updated: '2026-04-23'
related:
  - docs/research/interrupted-tool-call-validation-failure.md
  - docs/policy/testing-policy.md
  - docs/policy/cross-provider-content-contract.md
---

# Interrupted Tool-Call Contract Policy

Internal reference for how the API must model, validate, and downstream-adapt tool calls that the user interrupted before the tool's `input` finished streaming.

## Rationale

When a user clicks "Stop" mid-stream, the AI SDK leaves the open tool part in `output-error` with the partially-streamed `input` it managed to assemble. Treating that partial value as if it satisfied the tool's strict input schema cascades into a class of bugs we've hit in prod: `Validation failed: messages.N.parts.M: Invalid input` on every resubmission, the chat is permanently wedged, and the user has no way out except deleting the chat. The investigation in `docs/research/interrupted-tool-call-validation-failure.md` traced the failure to two seams the API owns: (a) the wire-level Zod schema that gates `/v1/chat`, and (b) the provider-adapter pipeline that pairs orphaned tool calls with synthetic tool results. This policy codifies the contract both seams must honor so the failure mode cannot recur.

The fix is intentionally API-only. The client-side persistence shape is whatever the AI SDK produces — the API must accept any shape the SDK can emit and downstream-adapt it for every supported provider. No client-side healing is required because (1) the `output-error` UI render path reads only `errorText`, never `input`, so partial / forensic local state is harmless to display, and (2) the API healing covers IndexedDB-resident chats, future Tau clients (CLI, SDKs), and any third-party caller equally. Pushing healing into the client would re-implement the API's responsibility in every consumer.

## Rules

### 1. `output-error` Tool Parts Are Forensic

A tool part in `state: 'output-error'` carries diagnostic context, not a contractually valid tool invocation. The strict per-tool input schema does not apply to it.

**Why**: A user interrupt by definition prevents the LLM from completing the input — locking it to the strict schema converts every interrupt into an unrecoverable validation failure.

CORRECT:

```typescript
z.object({
  type: z.literal('tool-read_file'),
  toolCallId: z.string(),
  state: z.literal('output-error'),
  input: z.unknown().optional(),
  rawInput: z.unknown().optional(),
  errorText: z.string(),
});
```

INCORRECT:

```typescript
z.object({
  type: z.literal('tool-read_file'),
  toolCallId: z.string(),
  state: z.literal('output-error'),
  input: readFileInputSchema,
  errorText: z.string(),
});
```

### 2. `rawInput` Is the Canonical Field for Partial / Forensic Arguments

`rawInput: z.unknown().optional()` is present on every tool state (not only `output-error`) so future SDK upgrades that surface forensics in other states do not require another schema change. Server-side adapters (`convertToModelMessages`, `toBaseMessages`) fall back to `rawInput` when the model needs to see what was attempted.

**Why**: Splitting forensic data into a dedicated field keeps `input` bound to the strict per-tool contract everywhere it is contractually meaningful, and matches the upstream AI SDK's `output-error` model.

### 3. Heal Inbound Payloads in `z.preprocess`

`uiMessagesSchema` wraps the strict per-part schema in a `z.preprocess` (`healInterruptedToolParts`) that walks every `output-error` tool part, runs its `input` against the static tool-input registry, and (only on `safeParse` failure) demotes the offending value to `rawInput` before validation continues.

**Why**: Persisted IndexedDB chats authored before this contract existed must keep loading. Healing inside `z.preprocess` recovers them without bypassing schema discipline downstream. Because healing runs at the API boundary, it covers every caller (web client, CLI, future SDKs, third-party integrations) without requiring each to ship its own sanitizer.

CORRECT:

```typescript
const healInterruptedToolParts = (input: unknown): unknown => {
  // walk parts, demote invalid `input` to `rawInput`
};
export const uiMessagesSchema: z.ZodType<MyUIMessage[]> = z.preprocess(healInterruptedToolParts, rawUiMessagesSchema);
```

INCORRECT — applying the demotion via a transform on a strict schema runs validation first, so the legacy payload still 400s:

```typescript
export const uiMessagesSchema = rawUiMessagesSchema.transform(healInterruptedToolParts);
```

### 4. Tool-Input Schema Registry Is the Single Source of Truth

`libs/chat/src/schemas/tool-input.registry.ts` exports a `Record<`tool-${ToolName}`, z.ZodType>` keyed by static tool part type. The healing preprocess looks up each part's schema there. Adding a new tool means adding an entry; the `Record` shape produces a TypeScript error until exhaustive.

**Why**: An inline switch inside `message.schema.ts` would silently drift the moment a new tool is added. The compile-time exhaustiveness check makes drift impossible.

### 5. Provider Adapters Must Accept Synthetic Tool Results

The Anthropic, Vertex, and OpenAI wire formats all require every `tool_use` / `functionCall` / `tool_calls` to be followed by a corresponding tool result. `messageContentSanitizerMiddleware` is the only authority that synthesises a `ToolMessage` for orphaned tool calls; the synthetic message must include:

- `tool_call_id` matching the original call
- `name` set to the tool name
- `status: 'error'`
- A JSON `content` body of `{ errorCode, toolName, toolCallId, message }`

**Why**: Skipping this pairing causes the provider to 400 with "tool call without matching tool result", which is the wire-level failure mode the original investigation surfaced.

### 6. Mirror the Full AI SDK Tool-Part Lifecycle

`uiMessagesSchema` accepts every state the upstream `validateUIMessages` schema accepts, including `approval-requested`, `approval-responded`, and `output-denied`, for both static and dynamic tool parts.

**Why**: Drifting from the upstream contract means any future tool that opts into approval UI re-introduces the same class of "valid AI SDK message blocked at our schema" wedge.

### 7. Append, Never Overwrite, on Schema Evolution

When a new tool state, error metadata field, or wire-level field appears in the AI SDK or a provider, it is added to `uiMessagesSchema` as a new branch or `.optional()` field. Never narrow an existing field, never split a state into multiple incompatible branches without a healer, and never ship a schema change that would 400 a chat that previously parsed.

**Why**: IndexedDB chat persistence is the user's work. A schema regression that rejects previously-parseable chats cannot be recovered from outside the API.

## Decision Table — Where Each Concern Lives

| Concern                                          | Location                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| Wire-level Zod schema for chat messages          | `libs/chat/src/schemas/message.schema.ts` (`uiMessagesSchema`)                    |
| Strict per-tool input schemas                    | `libs/chat/src/schemas/message.schema.ts` (`createToolSchemas`)                   |
| Static tool-input schema lookup                  | `libs/chat/src/schemas/tool-input.registry.ts`                                    |
| Heal legacy / interrupted payloads on inbound    | `libs/chat/src/schemas/message.schema.ts` (`healInterruptedToolParts` preprocess) |
| Synthetic tool-result pairing for provider wires | `apps/api/app/api/chat/middleware/message-content-sanitizer.middleware.ts`        |
| Server validation error code                     | `apps/api/app/api/chat/chat-exception.filter.ts` (`VALIDATION_ERROR`)             |

## Anti-Patterns

- Tightening the `output-error` `input` schema to "match the success path" — this is the original regression, do not reintroduce it.
- Adding client-side sanitisers that duplicate the API's healing — every new client would have to re-implement the same logic, and the API still has to heal anyway for non-Tau callers, so the duplication is pure cost.
- Putting partial / forensic data on `input` instead of `rawInput`.
- Skipping the synthetic tool-result pairing because "the provider usually tolerates it" — at least one provider (Anthropic) consistently 400s.
- Adding a per-tool special case to `messageContentSanitizerMiddleware` — middleware is provider-agnostic and tool-agnostic by contract.

## Summary Checklist

- [ ] `output-error` schema accepts `input: z.unknown().optional()` and `rawInput: z.unknown().optional()`
- [ ] `rawInput: z.unknown().optional()` is present on every tool state (not just `output-error`)
- [ ] `uiMessagesSchema` is wrapped in `z.preprocess(healInterruptedToolParts, …)`
- [ ] `tool-input.registry.ts` is exhaustive over `ToolName` (compile-time enforced)
- [ ] Sanitizer middleware emits a `ToolMessage` with `tool_call_id`, `name`, `status: 'error'`, and JSON content for every orphaned tool call
- [ ] Schema accepts `approval-requested` / `approval-responded` / `output-denied` for static and dynamic tool parts
- [ ] Round-trip integration test (`apps/api/app/api/chat/interrupted-tool-roundtrip.test.ts`) and provider integration tests still pass

## References

- Research: `docs/research/interrupted-tool-call-validation-failure.md`
- Related: `docs/policy/testing-policy.md`
- Upstream: `node_modules/ai/src/ui/validate-ui-messages.ts`
