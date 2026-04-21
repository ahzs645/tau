---
title: 'Agent Loop Safeguards: Doom-Loop Detection Middleware Blueprint'
description: 'Blueprint for a class of middleware safeguards that detect and break agent doom-loops, retry storms, and other token-wasting anti-patterns in the Tau chat agent.'
status: active
created: '2026-04-20'
updated: '2026-04-20'
category: architecture
related:
  - docs/policy/testing-policy.md
  - docs/policy/context-engineering-policy.md
  - docs/policy/filesystem-context-policy.md
  - docs/research/context-summarization-compaction.md
  - docs/research/multi-file-test-json-migration.md
  - docs/research/chat-model-cost-forensics.md
  - docs/research/cache-strategy-analysis.md
  - docs/research/context-injection-architecture.md
---

# Agent Loop Safeguards: Doom-Loop Detection Middleware Blueprint

A blueprint for a class of token-spend safeguards in `apps/api/app/api/chat/middleware/` that detect when the LLM is stuck — repeated identical failures, ping-pong tool sequences, no-progress edits — and intervene before the conversation burns a meaningful fraction of the user's budget.

## Executive Summary

The screenshot the user provided shows the Tau agent calling `test_model` ~15 consecutive times against `lib/fuselage.scad`, `lib/empennage.scad`, `lib/tail_boom.scad`, and `lib/main_rotor.scad`, every single call returning `Failed to fetch geometry for lib/<file>.scad`. There is **no middleware in our current stack that detects this pattern, and nothing in the system prompt that tells the model to abandon a strategy after N identical failures**. The agent simply re-emits the same tool call shape, the LLM faithfully retries, and we charge the user for every iteration.

This is the canonical "doom-loop" pattern documented across Anthropic's Claude Code, LangChain Deep Agents (`LoopDetectionMiddleware`), the Vercel AI SDK (`stopWhen`), CrewAI's loop-detector RFC, and every production agent post-mortem published in 2026. The recommendation is a **three-layer safeguard middleware** (`agent-safeguards.middleware.ts`) plus targeted system-prompt updates plus an EVAL integration test, modeled directly on the patterns that took LangChain's deepagents-cli from rank 30 to rank 5 on Terminal Bench 2.0 (LangChain, 2026).

**Root cause of this specific incident** (Finding 9, also R8): the `test_model` tool's per-`targetFile` `fetch_geometry` fan-out hits `createBrowserGraphicsClient.fetchGeometry` (`apps/ui/app/hooks/rpc-handlers.ts:228-261`), which — unlike its sibling `getKernelResult` — **does not bootstrap a missing compilation unit** and returns `UNKNOWN_COMPILATION_UNIT` immediately. The agent's `edit_tests` correctly registered per-file requirements for OpenSCAD library files (`lib/*.scad`), none of which had ever been opened in the editor or a viewer panel, so none had a CU. The wrapper `assertRpcSuccess` in `tool-test-model.ts:137` then collapses every distinct underlying error code into the same opaque "Failed to fetch geometry for X" string, leaving the model with no signal to choose a different recovery strategy. **F1 alone — surfacing the discriminator — would have prevented this loop**, and ships in 30 minutes; the middleware is the runtime backstop for the next variant of this class of mistake.

## Problem Statement

### The smoking gun

Image evidence: in a "Bizzard Helicopter" project (replicad multi-file, OpenSCAD via the new multi-file test.json shape), the assistant chat panel shows ~15 successive ToolCall rows, all of which read:

> ✗ `test_model('main_rotor')` — Failed to fetch geometry for lib/main_rotor.scad
> ✗ `test_model('main_rotor')` — Failed to fetch geometry for lib/main_rotor.scad
> ✗ `test_model('main_rotor')` — Failed to fetch geometry for lib/main_rotor.scad
> … (interleaved with `lib/fuselage.scad`, `lib/empennage.scad`, `lib/tail_boom.scad`) …
> ✗ `test_model('tail_boom')` — Failed to fetch geometry for lib/tail_boom.scad

Cost meter at the bottom of the conversation: **$7.75**. The cost was almost entirely accumulated **after** the model first received the identical failure response — every retry resends the full conversation context (8k+ tokens at this point) for zero productive work, the exact "200x cost amplification" pattern documented in Pan (2026).

### Why the existing stack didn't catch it

The middleware chain in `apps/api/app/api/chat/chat.service.ts:125-157` runs:

| Layer | Middleware                                                                                                                     | What it does                                                                                     | Does it detect this?                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 1     | `createToolMetricsMiddleware`                                                                                                  | OTEL counter increment per tool call                                                             | No — counts total only                                                                |
| 2     | `toolErrorHandlerMiddleware`                                                                                                   | Wraps `wrapToolCall`, converts thrown errors into structured `ToolMessage` JSON with `errorCode` | No — per-call only, no cross-call memory                                              |
| 3     | `createToolOffloadingMiddleware`                                                                                               | Spills large tool results to FS                                                                  | No — doesn't look at error patterns                                                   |
| 4     | `toolResultTrimmerMiddleware`                                                                                                  | Strips redundant fields per tool                                                                 | No — operates on individual messages                                                  |
| 5     | `createCompactionMiddleware`                                                                                                   | Token-budget compaction                                                                          | No — fires only on context-window overflow, not on repeated-call patterns             |
| 6     | `messageContentSanitizerMiddleware`, `newlineTrimmerMiddleware`, `latexDelimiterMiddleware`                                    | Cosmetics                                                                                        | No                                                                                    |
| 7     | `promptCachingMiddleware`                                                                                                      | Anthropic `cache_control` injection                                                              | No — actually makes the loop **cheaper per turn**, removing back-pressure             |
| 8     | `createAgentIterationsMiddleware`                                                                                              | OTEL histogram of iteration count                                                                | **Records but does not act** — fires `afterAgent`, after the budget is already burned |
| 9     | `createUsageTrackingMiddleware`, `createContextUsageMiddleware`, `createTranscriptMiddleware`, `createClientContextMiddleware` | Observability + skills/memory injection                                                          | No                                                                                    |

There is **no `wrapModelCall` hook anywhere in the stack that inspects message history for repeated tool-call patterns and short-circuits or warns**.

The system prompt (`apps/api/app/api/chat/prompts/cad-agent.prompt.ts:200-206`) does include:

```
On test failures: review the failure reason and suggestion, then fix the specific issue. …
Tool failures: stop after 1-2 retries and explain the issue to the user.
```

This guidance is **not enforced** anywhere, and the screenshot proves it is not sufficient. Prompt-level safeguards ("don't repeat") are not enforceable — agents re-plan and retry regardless (OnceOnly, 2026; Pan, 2026).

### Scope and non-goals

**In scope**: middleware-level detection of repeated tool-call patterns within a single agent run; injection of structured "system-reminder"-style messages; hard caps on consecutive identical failures; EVAL integration test that reproduces the test_model loop.

**Out of scope**: cross-session loop detection ("Ralph Wiggum loop"); idempotency of side-effecting tools (separate concern, see Future Work); per-tool-provider rate-limit handling; `test_model` itself being broken for multi-file projects (that root cause should be filed as a separate issue — the middleware is the **safety net**, not the fix).

## Methodology

1. **Codebase audit** of `apps/api/app/api/chat/middleware/` (31 files), `chat.service.ts`, `tool-error-handler.middleware.ts`, `tool-result-trimmer.middleware.ts`, `compaction.middleware.ts`, `agent-iterations.middleware.ts`, the CAD system prompt, and the `ToolError` / `ToolExecutionError` taxonomy in `libs/chat/src/utils/tool-error.utils.ts`.
2. **Subagent deep-mine** of `repos/claude-code` (Anthropic's deobfuscated Claude Code source) for every detection / intervention pattern around tool loops, system reminders, and progress tracking.
3. **Web research** (April 2026): the Vercel AI SDK `loop-control` docs, LangChain's "Improving Deep Agents with harness engineering" blog post, AgentPatterns.ai loop-detection page, LangSight loop-detection patterns post, the "Retry Storm Problem" essay (Pan, 2026), CrewAI issue #4682 + PR #4684 (LoopDetector middleware), and OnceOnly's idempotency boundary writeup.
4. **Cross-reference** of LangChain JS `createMiddleware` API surface with Tau's existing middleware to confirm that all patterns can be expressed in the current `wrapModelCall` / `wrapToolCall` / `stateSchema` / `contextSchema` shape.

## Findings

### Finding 1: Three-layer model is the consensus pattern

Every production source converged on the same three-layer architecture:

| Layer                                    | Detects                                                                 | Action                                                                           | Citation                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **L1: Hard iteration cap**               | Pure runaway (any cause)                                                | Terminate the agent run                                                          | AI SDK `stepCountIs(20)` default; Claude Code `maxTurns`; Pan 2026 "agent-level failure budgets" |
| **L2: Edit-count / per-target tracking** | Same target re-edited N times without progress                          | Inject prompt nudge ("you have edited X N times, consider a different approach") | LangChain `LoopDetectionMiddleware`; AgentPatterns "edit-count tracking"                         |
| **L3: Doom-loop detection**              | Identical tool name + identical args (or identical error) consecutively | **Terminate iteration** — identical failures will not self-resolve               | AgentPatterns; LangSight; OPENDEV §2.2.6; CrewAI LoopDetector RFC                                |

A fourth layer worth considering:

| **L4: No-forward-progress / diminishing returns** | Token output per turn falls below threshold N turns in a row | Stop with "diminishing returns" reason | Claude Code `tokenBudget.diminishingReturns` (`src/query/tokenBudget.ts` ~59-88) |

The three-layer cadence is the right altitude for Tau: L1 we have implicitly via LangChain's own caps, L2 maps to repeated `edit_file`/`create_file` against the same path, L3 maps cleanly onto our screenshot scenario.

### Finding 2: Claude Code does not have a centralized identical-call detector

The deep-mine of `repos/claude-code` (Anthropic's official CLI) revealed that **Claude Code does not implement an explicit "same tool + same args + same error N times" doom-loop detector**. What it does have:

- **`maxTurns` hard cap** in `src/query.ts:1704-1711` that yields a `max_turns_reached` attachment and exits.
- **Per-tool dedup at the source** — `Read` returns `FILE_UNCHANGED_STUB` if the same path/offset/limit is requested with unchanged mtime (`src/tools/FileReadTool/FileReadTool.ts:523-567`); MCP resource reads append "Do NOT read this resource again unless you think it may have changed…" to the result (`src/utils/messages.ts:3906-3908`).
- **Permission denial streaks** — 3 consecutive or 20 total denials trigger `tengu_auto_mode_denial_limit_exceeded` and fall back to user prompting (`src/utils/permissions/denialTracking.ts`, `permissions.ts:1005-1009`).
- **`<system-reminder>` injection convention** (`src/utils/messages.ts:3097`+) wrapping advisory user-role messages — Anthropic's models are explicitly trained to recognize this tag (the contract is documented in `src/constants/prompts.ts:131-132`).
- **Anti-retry prompt-level guidance**: "do not re-attempt the exact same tool call" after a user denial (`src/constants/prompts.ts:189`); the `SUBAGENT_REJECT_MESSAGE` includes "Try a different approach or report the limitation…" (`src/utils/messages.ts:216-217`); the advisor tool prompt tells the model to call advisor when **stuck — errors recurring, approach not converging** (`src/utils/advisor.ts:130-139`).
- **"Diminishing returns" stop** in `src/query/tokenBudget.ts:59-88` — after ≥3 continuations, if token delta per check is < 500 twice in a row, log `tengu_token_budget_completed` with `diminishingReturns: true` and stop.

**Interpretation**: Claude Code leans on (a) explicit turn caps, (b) per-tool dedup at the data source, (c) prompt-level "don't blindly retry" guidance, and (d) telemetry — but not a centralized identical-failure detector. They appear to trust the model + explicit anti-retry prompting more than middleware enforcement. **For Tau this is a gap to close, not a model to copy** — our screenshot proves prompt-level guidance is insufficient for our model lineup and our task surface (and Pan 2026 / OnceOnly 2026 both argue prompts are categorically unenforceable).

### Finding 3: LangChain's harness blog is the strongest published prior art

Trivedy (LangChain, Feb 2026) describes lifting deepagents-cli from rank 30 → rank 5 on Terminal Bench 2.0 **without changing the model** — only by adding harness middleware. The two relevant pieces:

- `LoopDetectionMiddleware` — tracks per-file edit counts via tool-call hooks; injects "…consider reconsidering your approach" after N edits to the same file.
- `PreCompletionChecklistMiddleware` — intercepts the agent before it exits and reminds it to run a verification pass against the task spec (also a Ralph-Wiggum-loop variant).

The blog explicitly frames these as design heuristics for today's models that "will likely be unnecessary as models improve" — but for Tau in 2026 they are necessary.

### Finding 4: Detection mechanisms — argument-hash vs sliding-window vs semantic

Three published detection algorithms (LangSight, 2026; CrewAI #4682; AgentPatterns):

| Algorithm                                                  | What it catches                                                                                       | Cost                       | False-positive risk                             | Tau fit                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| **Argument-hash comparison**                               | Exact-repeat tool calls (same name + JSON.stringify(sortedArgs)) — > 90% of real loops at threshold 3 | O(1) per call              | Low at threshold 3                              | **Primary mechanism** — matches screenshot exactly                 |
| **Sliding-window rate**                                    | High-frequency calls regardless of arg variation                                                      | O(window) per call         | Medium — false-positives for legitimate polling | Secondary — for `get_kernel_result` polling specifically           |
| **LLM output similarity** (cosine on reasoning)            | Semantic loops where args drift                                                                       | Expensive (embedding call) | Low                                             | Skip — overkill for our cost target                                |
| **Identical-error pairing** (tool name + serialized error) | The screenshot scenario specifically                                                                  | O(1) per call              | **Lowest** — identical errors are unambiguous   | **Primary mechanism #2** — pair with arg-hash for AND-confirmation |

LangSight's empirical claim (March 2026): **argument hash at threshold 3 catches > 90% of real-world loops with zero false positives**.

### Finding 5: Intervention strategies — terminate vs nudge vs degrade

Three options on detection (LangSight, 2026; AgentPatterns; CrewAI):

1. **Warn + continue** — log/emit telemetry, no behavior change. Use during shadow rollout to validate thresholds.
2. **Inject system reminder** — append a `<system-reminder>`-style HumanMessage telling the model to abandon the strategy. The model gets one chance to self-recover. **Default for Tau** because we want the model to continue producing user-visible work, and our agent already understands the `<system-reminder>` convention (it's documented in `cad-agent.prompt.ts` `transcript_search` section).
3. **Hard terminate** — return a final assistant message and stop the loop. Use as the L3 backstop after N nudges have been ignored.

The right combo for Tau: **(2) → (3) escalation** — first nudge after threshold, hard terminate after 2× threshold. This matches the LangSight "warn → terminate" graduation pattern.

### Finding 6: AI SDK and LangChain JS API surface

- **AI SDK** (`ai-sdk.dev/docs/agents/loop-control`): default `stopWhen: stepCountIs(20)`, custom `StopCondition<typeof tools>` callback receives `{ steps, messages }`, `prepareStep` receives `{ stepNumber, steps, messages }`. The function-receiving-history shape is the natural place for hash comparison. **Direct map to LangChain's `wrapModelCall(request, handler)` where `request.messages` is the full BaseMessage history.**
- **LangChain JS `createMiddleware`**: supports `stateSchema` + `contextSchema` together (Tau already uses both — see `compaction.middleware.ts:41-45`, `agent-iterations.middleware.ts:22-28`). The `stateSchema` is the right place to keep counters across hooks (idiomatic LangChain pattern documented in the existing `agent-iterations.middleware.ts`).

### Finding 7: Anti-pattern catalog beyond identical retries

Reasoning the user explicitly asked us to do — what other patterns belong in the same middleware family?

| #    | Pattern                               | Description                                                                                     | Detection signal                                                                      | Real Tau example                                                                 |
| ---- | ------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| AP1  | **Identical-error doom-loop**         | Same tool + same args + same error N×                                                           | `(toolName, argsHash, errorHash)` triple repeats                                      | Screenshot scenario                                                              |
| AP2  | **Identical-call doom-loop**          | Same tool + same args N× regardless of result                                                   | `(toolName, argsHash)` repeats                                                        | `read_file` on the same path repeatedly                                          |
| AP3  | **Per-target edit thrashing**         | `edit_file`/`create_file` against same path > N times                                           | Per-`targetFile` edit count                                                           | Multi-iteration "fix the bug" loops                                              |
| AP4  | **Ping-pong tool sequence**           | A→B→A→B with identical args on both sides                                                       | 2-cycle in `(tool, args)` sequence                                                    | `edit_file` then `get_kernel_result` then `edit_file` with no diff change        |
| AP5  | **Empty-result polling**              | Tool returns empty/no-results N× and agent keeps re-calling                                     | `errorCode === 'TOOL_NO_RESULTS'` repeats; or empty `result.matches`/`result.entries` | `grep` returning 0 matches 5×, `glob_search` 0 files 5×                          |
| AP6  | **No-forward-progress**               | N turns with no `edit_file` / `create_file` (read-only thrash)                                  | Run length of read-only tools                                                         | "I see the issue, let me read more files" without ever editing                   |
| AP7  | **Same-failure-different-args drift** | Same `errorCode` from different args N×                                                         | Group by `(toolName, errorCode)` → count                                              | Keeps hitting `TOOL_INPUT_VALIDATION_FAILED` because the schema is misunderstood |
| AP8  | **Iteration-count cliff**             | Total `wrapModelCall` invocations > hard cap                                                    | `state._iterationCount` from existing `agent-iterations.middleware.ts`                | The screenshot's ~15-iteration burst                                             |
| AP9  | **Cost cliff**                        | Cumulative input tokens × price > $/turn budget                                                 | Already partially tracked by `usage-tracking.middleware.ts`                           | The $7.75 in the screenshot                                                      |
| AP10 | **Cancelled-then-immediate-resubmit** | User cancels, then identical message resubmitted within X seconds                               | UI/agent boundary, not middleware                                                     | Out of scope here                                                                |
| AP11 | **Reasoning-only stall**              | N consecutive turns with reasoning-tokens > 0 but `tool_calls.length === 0` and no final answer | Inspect `AIMessage.tool_calls` length and content                                     | Model stuck "thinking" without acting                                            |

Tau's first middleware should cover **AP1, AP2, AP3, AP5, AP7** in the v1, with AP4/AP6/AP11 added in v2 once telemetry confirms the v1 thresholds are stable.

### Finding 8: When loop detection backfires

AgentPatterns cites a study of 220 instrumented agent runs where **only half of 12 automated loop interventions actually reduced their target signal; one generated 13× more signals than it suppressed by triggering its own detector** (boucle2026, 2026). Failure modes to design against:

- **False positives on legitimate iterative refinement** — 5 successive `edit_file` calls on `main.scad` while iteratively fixing a syntax error look identical to AP3 thrashing from a counter's view. Mitigation: pair edit-count with **outcome change** (e.g., `get_kernel_result` status flipped from `error` → `ready`) before incrementing.
- **Nudge pollution** — every injected `<system-reminder>` consumes context the agent could use for code, and on agents already near the context limit it accelerates the failure it was meant to prevent. Mitigation: cap nudges at 1 per detection class per agent run; place injection **after** `compaction` middleware so nudges aren't immediately compacted away.
- **Detector-on-detector amplification** — if our nudge causes the model to switch to a different broken approach that itself trips a different detector, signal multiplies. Mitigation: emit a **single intervention per turn**, prioritized L3 > L2 > L1.

**Operational rule**: every detector ships with a counter for "fired" and a counter for "fired-and-helped" (measured by whether the agent's next tool call was different from the offending one). Drop detectors whose `helped/fired` ratio falls below 0.5 over a 1-week window.

### Finding 9: Root cause of the screenshot's `test_model` failure

This finding addresses R8 from the original blueprint — what the agent was actually retrying against.

#### The chain of custody for the error string

Tracing the literal text "Failed to fetch geometry for lib/main_rotor.scad" backwards from the LLM's view:

1. **API** — `apps/api/app/api/tools/tools/tool-test-model.ts:134-138` calls `assertRpcSuccess(geometryResult, { clientErrorMessage: \`Failed to fetch geometry for ${targetFile}\` })`. This is the only place in the codebase that emits that string; it fires whenever the underlying RPC returned `success: false`, regardless of `errorCode`.
2. **RPC handler** — `libs/chat/src/rpc/handlers/handle-fetch-geometry.ts:28` delegates to `graphics.fetchGeometry({ targetFile })`. If `graphics` is undefined, returns `{ success: false, errorCode: 'UNKNOWN', message: 'No graphics view is currently mounted' }`. Otherwise propagates the underlying result unchanged.
3. **Browser graphics client** — `apps/ui/app/hooks/rpc-handlers.ts:228-261` is the actual oracle. It does:

```typescript
const cadUnit = compilationUnits.get(targetFile);
if (!cadUnit) {
  return {
    success: false,
    errorCode: 'UNKNOWN_COMPILATION_UNIT',
    message: `No compilation unit found for ${targetFile}`,
  };
}
const geometry = cadSnapshot.context.geometries.find((g) => g.format === 'gltf');
if (geometry?.format !== 'gltf') {
  return {
    success: false,
    errorCode: 'UNKNOWN',
    message: `No GLTF geometry available for ${targetFile}`,
  };
}
return { success: true, glb: geometry.content };
```

So the agent sees "Failed to fetch geometry for lib/main_rotor.scad" in three distinct underlying scenarios: (a) **no compilation unit exists** for that path, (b) **compilation unit exists but produced no GLTF geometry** (e.g. kernel error, or library file with no top-level call), or (c) **no graphics view mounted**. The wrapper string in the API erases this distinction — every flavor renders identically to the LLM, which is itself a contributing factor (the model has no way to choose a different recovery strategy because the error code is invisible).

#### The smoking gun — asymmetric bootstrap

`createBrowserRuntimeClient.getKernelResult` and `createBrowserGraphicsClient.fetchGeometry` look syntactically parallel — both lookup `compilationUnits.get(targetFile)` — but they handle the miss path differently:

| Operation                       | Missing-CU behavior                                                                | Reference                                   |
| ------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `getKernelResult(targetFile)`   | Sends `createCompilationUnit` event, refetches, awaits `idle\|error` via `waitFor` | `apps/ui/app/hooks/rpc-handlers.ts:177-218` |
| `fetchGeometry({ targetFile })` | Returns `UNKNOWN_COMPILATION_UNIT` immediately                                     | `apps/ui/app/hooks/rpc-handlers.ts:228-261` |

Test coverage actively **encodes** this asymmetry: `apps/ui/app/hooks/rpc-handlers.test.ts:380-391` asserts `fetchGeometry` returns `UNKNOWN_COMPILATION_UNIT` on miss, and `:585-604` asserts `getKernelResult` sends `createCompilationUnit` on miss. The divergence was not accidental, but the consequence was not designed for.

#### Why the screenshot specifically

The user's "Bizzard Helicopter" project surfaced this because it is a **multi-file OpenSCAD project with library files**:

- `main.scad` — the primary entry, opened in the editor, has a CU.
- `skids.scad` — likely had a CU because a viewer panel was open (visible in the screenshot's right pane).
- `lib/fuselage.scad`, `lib/empennage.scad`, `lib/tail_boom.scad`, `lib/main_rotor.scad` — pure library files referenced by `main.scad` via `use <lib/main_rotor.scad>` etc. No editor view, no viewer panel, **never had a compilation unit**.

The agent (correctly, per `cad-agent.prompt.ts` guidance) used `edit_tests` to add per-file requirements for each library file in `test.json`. The migration in `docs/research/multi-file-test-json-migration.md` made this the canonical idiom. Then `test_model` (`tool-test-model.ts:123-148`) does:

```typescript
const perFileResults = await Promise.all(
  entries.map(async ([targetFile, { requirements }]) => {
    const geometryResult = await chatRpcService.sendRpcRequest({
      rpcName: rpcName.fetchGeometry,
      args: { artifactId: toolCallId, targetFile },
    });
    assertRpcSuccess(geometryResult, { clientErrorMessage: `Failed to fetch geometry for ${targetFile}` });
    // …
  }),
);
```

Every entry whose `targetFile` is a library file fans out to `fetchGeometry`, hits the no-CU branch, and the agent gets four parallel "Failed to fetch geometry" rejections per `test_model` invocation. Because each library file is a **different `targetFile`**, the AP1 detector built in this blueprint would actually need the _(toolName, errorHash)_ signal on its own — the args differ — which is exactly what AP7 ("same `errorCode`, different args") is designed to catch. **The screenshot is an AP7 case more than an AP1 case** — adjust thresholds accordingly when prioritizing detector implementation order.

#### Why even the "fix" of bootstrapping CUs is insufficient

Mirroring `getKernelResult`'s `createCompilationUnit`/`waitFor` dance inside `fetchGeometry` would resolve the proximate failure, but it surfaces a deeper issue: `apps/ui/app/machines/project.machine.ts:463-498` accepts **any** path as an `entryFile` and spawns a CAD actor against it. For OpenSCAD, a library file like `lib/main_rotor.scad` typically contains only `module` declarations — no top-level call — so the kernel will run, produce no top-level geometry, and the CU's `geometries` array will be empty. The follow-on check at `rpc-handlers.ts:243-251` then returns `errorCode: 'UNKNOWN', message: 'No GLTF geometry available for ${targetFile}'`. Same wrapper string ("Failed to fetch geometry"), different underlying cause, identical user-visible failure.

In other words: the migration in `multi-file-test-json-migration.md` quietly assumed every entry in `test.json` was an independently-renderable compilation unit. OpenSCAD library files violate that assumption.

#### Three layers of fix, ordered

| #      | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Layer                | Cost       | Notes                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1** | **Surface the discriminator**: change `clientErrorMessage` in `tool-test-model.ts:137` from a static string to a structured branch on `geometryResult.errorCode`, e.g. `UNKNOWN_COMPILATION_UNIT → "No compilation unit for ${targetFile}. Open it in the editor or call get_kernel_result first."`; `UNKNOWN (no GLTF) → "${targetFile} compiled but produced no top-level geometry — likely an OpenSCAD library file with only module declarations and no top-level call. Remove the entry from test.json or add a top-level call."` | API tool wrapper     | XS (30min) | **Highest leverage**: even before fixing anything else, the agent gets actionable, distinguishing error text — sufficient on its own to break the screenshot's loop |
| **F2** | **Bootstrap CU symmetrically**: factor out a `resolveOrCreateCompilationUnit(projectRef, targetFile)` helper used by both `getKernelResult` and `fetchGeometry`. Eliminates the F1-distinguished `UNKNOWN_COMPILATION_UNIT` branch by construction.                                                                                                                                                                                                                                                                                    | UI RPC handler       | S (2h)     | Removes the asymmetry the test file currently encodes — update both tests in lockstep                                                                               |
| **F3** | **Validate test.json entries are renderable**: in `tool-edit-tests.ts` post-write validation, after `testFileSchema.safeParse`, fan out `get_kernel_result` per `targetFile` and reject any entry whose CU produces `geometries.length === 0`. Surfaces the library-file mistake at the moment the agent makes it, not later when `test_model` runs.                                                                                                                                                                                   | Edit-time validation | M (4h)     | Catches AP3-style "edit test.json, run test_model, fail, edit test.json again" thrashing at the source. Pairs naturally with F1's structured error string.          |

F1 alone, deployed without F2 or F3, would have prevented the documented $7.75 burn — the agent would have seen on the first failure that the issue was structural (library file with no top-level call) and either removed those entries from `test.json` or added top-level invocations. **Ship F1 with the safeguard middleware as a paired P0**: the safeguard is the runtime backstop, F1 is the cooperative repair contract.

#### Implications for the safeguard middleware

1. **Detector priority**: the screenshot is AP7 (same error code, different args), not AP1 (identical triple). When implementing R1+R2, ship AP7 in the same v1 release — splitting them by priority would have left this exact case uncovered.
2. **Reminder template**: AP7's `<system-reminder>` should explicitly enumerate the recovery options that F1 would have surfaced, even if F1 hasn't shipped yet — gives the safeguard standalone value.
3. **EVAL fixture**: the integration test in R5 should reproduce the _real_ failure mode (library files in `test.json`, four parallel `fetch_geometry` failures with different `targetFile` args sharing the same `errorCode`), not a synthetic "always fail" stub. Otherwise we ship a safeguard that catches a pattern we don't actually have.
4. **Cross-doc link**: when this fix ships, update `docs/research/multi-file-test-json-migration.md` Finding 4 to note the renderability assumption and reference F1-F3.

## Tau Inventory: Current Safeguards vs Gaps

| Layer                      | Today                                                                       | Gap                                                                      |
| -------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Hard turn cap              | LangChain default; not surfaced to user                                     | **Gap**: no Tau-explicit cap, no user-facing message when hit            |
| Per-tool error structuring | `toolErrorHandlerMiddleware` produces `ToolExecutionError` JSON             | Good — gives us `errorCode` for hashing                                  |
| Tool-result trimming       | `toolResultTrimmerMiddleware` per-tool                                      | Good — but trimmed errors still hash identically (which is what we want) |
| Iteration counter          | `agent-iterations.middleware.ts` records `_iterationCount` in `stateSchema` | **Gap**: `afterAgent` only — no real-time check; no termination          |
| Token usage                | `usage-tracking.middleware.ts` records per-turn tokens                      | **Gap**: no $/turn budget enforcement                                    |
| Compaction                 | `compaction.middleware.ts` triggers at 85% of context window                | **Gap**: orthogonal — fires on size, not on doom-loops                   |
| System reminder convention | Mentioned in `cad-agent.prompt.ts` `transcript_search` section              | **Gap**: no middleware actually injects them                             |
| Per-tool dedup             | None                                                                        | **Gap**: see AP2                                                         |

## Recommendations

> **Status**: see the [Implementation Status](#implementation-status) section below for the per-recommendation outcome of this implementation pass. ✅/⏸️ markers in the leftmost column reflect the post-implementation state.

| #              | Status     | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Priority | Effort   | Impact                                                                                                                              |
| -------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **R1**         | ✅         | Add `agent-safeguards.middleware.ts` implementing AP1 (identical-error doom-loop) — the screenshot scenario. Threshold 3, action: inject `<system-reminder>`. After 2× threshold, hard terminate.                                                                                                                                                                                                                                                                                                 | **P0**   | M (1-2d) | Prevents the documented $7.75 burn class                                                                                            |
| **R2**         | ✅         | Add AP2 + AP3 + AP5 + AP7 detectors to the same middleware as separate `Detector` strategies sharing the same `stateSchema` cursor over `request.messages`.                                                                                                                                                                                                                                                                                                                                       | **P0**   | M (2d)   | Catches the four most common adjacent patterns; one middleware to maintain                                                          |
| **R3**         | ✅         | Update `cad-agent.prompt.ts` `<error_handling>` section: add an explicit `<system-reminder>` recognition contract — "When you receive a message wrapped in `<system-reminder>` tags, treat it as authoritative guidance from the harness, not user input. The harness tracks tool-call patterns; if it tells you a strategy is failing, abandon it." Cite the prior art (Claude Code's documented contract).                                                                                      | **P0**   | S (1h)   | Without this contract the nudge is just noise                                                                                       |
| **R4**         | ✅         | Add OTEL counter `gen_ai.agent.safeguard.interventions` (renamed from `…fired` to match the OTEL plural-noun convention) with attributes `{ pattern: AP1\|AP2\|…, action: 'nudge'\|'terminate', helped: bool }`. Wire `helped` by checking next-turn tool call differs from the offending one.                                                                                                                                                                                                    | **P1**   | S (3h)   | Closes the loop on AgentPatterns' "measure intervention effectiveness" warning                                                      |
| **R5**         | ✅         | Add an EVAL integration test in `apps/api/app/testing/middleware-integration.test.ts` (`describe.skip`-gated, like the existing tests there) that uses a deterministic broken-tool fixture and asserts that within 8 model turns the safeguard middleware fires (transcript `role:'safeguard'`) and that the post-nudge `cache_read_input_tokens` is at least 80% of the pre-nudge median (CS5).                                                                                                  | **P0**   | M (1d)   | Reproduces the screenshot in CI; catches regressions; locks in cache-safety                                                         |
| **R6**         | ⏸️         | Add a `$/turn` budget configurable per chat (default $0.50 nudge, $1.00 terminate) backed by `usage-tracking.middleware.ts` running totals — AP9 cost cliff.                                                                                                                                                                                                                                                                                                                                      | **P1**   | M (1d)   | **Out of scope** for this pass — telemetry from R4 is the prerequisite                                                              |
| **R7**         | ✅         | Wire safeguard intervention events to the existing `transcript.middleware.ts` `appendTranscriptLine` so the agent can `grep` its own transcript for prior interventions in the same session — closes the cross-iteration memory gap from CrewAI #4682 comments.                                                                                                                                                                                                                                   | **P2**   | S (3h)   | Cheap, leverages our existing transcript machinery                                                                                  |
| **R8**         | ⏸️         | **Root cause identified — see Finding 9.** Three-layer fix: **F1** (XS, ~30min) — replace the static `clientErrorMessage: \`Failed to fetch geometry for ${targetFile}\``in`tool-test-model.ts:137`with a structured branch on`geometryResult.errorCode`. **F2** (S, ~2h) — factor `resolveOrCreateCompilationUnit`and use in both`getKernelResult`and`fetchGeometry`. **F3** (M, ~4h) — post-write validation in `tool-edit-tests.ts`rejecting`test.json` entries whose CU produces no geometry. | **P0**   | XS+S+M   | **Out of scope** for this API-only pass; the middleware is the runtime backstop, F1 remains the highest-leverage cooperative repair |
| **R9**         | ✅ (early) | Add AP4 (ping-pong) and AP6 (no-forward-progress) detectors.                                                                                                                                                                                                                                                                                                                                                                                                                                      | **P2**   | M        | Shipped with v1 because they reuse the same `ToolEventSummary` tail                                                                 |
| **R10**        | ⏸️         | Skip AP10 (cross-message resubmit) and AP11 (reasoning-only stall) for v1; revisit if telemetry shows they are common.                                                                                                                                                                                                                                                                                                                                                                            | **P3**   | —        | Avoid premature complexity; respect AgentPatterns' "drop detectors below 0.5 helped/fired" rule                                     |
| **C5** _(new)_ | ✅         | Codify the [Cache-Safety Contract](#cache-safety-contract) (CS1–CS6) so all future middleware that injects messages does so through `beforeModel` + the state-messages reducer, never via in-place `wrapModelCall` mutation.                                                                                                                                                                                                                                                                      | **P0**   | S        | Prevents a class of regressions that would silently invalidate Anthropic prompt caching                                             |

## Proposed Architecture

### Single middleware, multi-detector

One file: `apps/api/app/api/chat/middleware/agent-safeguards.middleware.ts`. It composes a small array of `Detector` strategies that share state over the message history. Each detector returns either `null` (clear), `{ kind: 'nudge', reminder: string }`, or `{ kind: 'terminate', reason: string }`.

```typescript
// Sketch only — not for direct copy/paste
import { createMiddleware, type AgentMiddleware } from 'langchain';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { isToolExecutionError } from '@taucad/chat/utils';

const safeguardsContextSchema = z.object({
  modelId: z.string(),
  modelService: z.custom<ModelService>(),
});

const safeguardsStateSchema = z.object({
  _safeguardNudgesFired: z.number().default(0),
  _safeguardTerminated: z.boolean().default(false),
});

type Detection =
  | { kind: 'clear' }
  | { kind: 'nudge'; pattern: AnomalyPattern; reminder: string }
  | { kind: 'terminate'; pattern: AnomalyPattern; reason: string };

type Detector = {
  pattern: AnomalyPattern;
  evaluate(messages: BaseMessage[], thresholds: Thresholds): Detection;
};

const detectors: Detector[] = [
  identicalErrorDetector, // AP1
  identicalCallDetector, // AP2
  perTargetEditDetector, // AP3
  emptyResultDetector, // AP5
  sameErrorDifferentArgsDetector, // AP7
];

export const createAgentSafeguardsMiddleware = (metricsService: MetricsService): AgentMiddleware =>
  createMiddleware({
    name: 'AgentSafeguards',
    contextSchema: safeguardsContextSchema,
    stateSchema: safeguardsStateSchema,

    async wrapModelCall(request, handler) {
      // Run detectors highest-severity-first; emit at most one intervention per turn
      for (const detector of detectors) {
        const detection = detector.evaluate(request.messages, defaultThresholds);
        if (detection.kind === 'clear') continue;

        recordSafeguardFired(metricsService, detection);

        if (detection.kind === 'terminate') {
          // Replace the upcoming model call with a synthetic AIMessage that
          // explains the termination. Setting `_safeguardTerminated` ends the
          // loop because LangChain stops on a final assistant message with no
          // tool_calls.
          return {
            messages: [
              new AIMessage({
                content: terminationMessage(detection),
              }),
            ],
          };
        }

        // kind === 'nudge': inject a HumanMessage wrapped in <system-reminder>
        // tags so the model recognizes it as harness guidance.
        return handler({
          ...request,
          messages: [
            ...request.messages,
            new HumanMessage({
              content: `<system-reminder>\n${detection.reminder}\n</system-reminder>`,
            }),
          ],
        });
      }

      return handler(request);
    },
  });
```

Key design choices:

- **`wrapModelCall`, not `wrapToolCall`**, because we need the full message history view to spot patterns. `wrapToolCall` runs per-tool with no cross-call memory.
- **No new state needed beyond `_safeguardNudgesFired`** — message history is the source of truth, identical to how `agent-iterations.middleware.ts` works.
- **Termination via synthetic final AIMessage** is the LangChain-idiomatic way to end the loop without throwing; matches the AI SDK pattern of "tool with no `execute` halts the loop" (ai-sdk.dev/docs/agents/loop-control).
- **Place between `toolErrorHandlerMiddleware` and `createCompactionMiddleware`** in the chain so we see structured errors but our nudge HumanMessage gets the same trimming/caching treatment as everything else. Concretely: insert after `toolErrorHandlerMiddleware` (line 128 in `chat.service.ts`).

### Detector implementations (sketches)

**AP1 — identical-error doom-loop**:

```typescript
// Walks tail of messages. Scans up to last 6 ToolMessage instances.
// If 3+ have the same (name, argsHash, errorHash) triple, fires.
function identicalErrorDetector(messages: BaseMessage[], { errorThreshold }) {
  const recentToolErrors = takeRecentToolErrors(messages, 6);
  const grouped = groupBy(recentToolErrors, (m) => `${m.name}:${m.argsHash}:${m.errorHash}`);
  for (const [key, group] of grouped) {
    if (group.length >= errorThreshold) {
      const sample = group[0]!;
      return {
        kind: group.length >= 2 * errorThreshold ? 'terminate' : 'nudge',
        pattern: 'identical-error',
        reminder: identicalErrorReminder(sample),
        reason: `Tool ${sample.name} failed identically ${group.length} times`,
      };
    }
  }
  return { kind: 'clear' };
}
```

`argsHash` and `errorHash` are SHA-256 of canonicalized JSON (`JSON.stringify` with sorted keys), matching LangSight's recommended algorithm. Truncate hash to 16 hex chars — sufficient collision resistance for this purpose.

### System-reminder template strings

Pin these in the codebase as `const` exports so they can be unit-tested and updated atomically:

```text
You called `${toolName}` with the same arguments and received the same error
${count} times in a row:

  Arguments: ${argsPreview}
  Error: ${errorPreview}

Identical retries will not change the result. Stop and choose ONE of:
  1. Read the source file or test fixture to understand why this is failing.
  2. Try a structurally different approach (different tool, different arguments).
  3. Report the failure to the user with what you tried and what you observed.

Do NOT call `${toolName}` with these arguments again.
```

Tone choices, justified by Trivedy (2026) and Claude Code's `src/utils/advisor.ts:130-139`:

- **Factual observation first** ("you called X N times"), no emotional or evaluative language.
- **Enumerate alternatives, do not prescribe** — one of three named paths.
- **Explicit prohibition** at the end — Anthropic models in particular respond well to a single hard "Do NOT" line.
- **Wrapped in `<system-reminder>`** — explicit harness contract documented in the system prompt, matching Claude Code's convention.

## Test Plan

### Unit tests (per detector, per middleware contract)

`apps/api/app/api/chat/middleware/agent-safeguards.middleware.test.ts`. Pattern matches `agent-iterations.middleware.test.ts` and `tool-result-trimmer.middleware.test.ts`.

Required cases:

- `should not fire when no tool calls have been made`
- `should not fire when one identical error occurs`
- `should not fire when two identical errors occur` (just under threshold)
- `should fire nudge when three identical errors occur`
- `should fire terminate when six identical errors occur`
- `should fire only once per turn even when multiple patterns match` (priority ordering)
- `should not fire when args differ even with identical error code` — covers AP7 separately
- `should walk the cause chain to find the underlying error` — same fixture as `tool-error-handler.middleware.test.ts`
- `should ignore non-error tool messages` — successful tool calls don't count toward error threshold
- `should reset on user message` — fresh user input clears the counter (you can't doom-loop across separate user requests)
- `should record OTEL counter with correct attributes when firing`

Use `mock<MetricsService>()` from `vitest-mock-extended` per `docs/policy/testing-policy.md` §5. Use `resolveMiddlewareHook(middleware.wrapModelCall)` from `#testing/middleware-testing.utils.js` per existing pattern.

### EVAL integration test

`apps/api/app/testing/middleware-integration.test.ts`, new `describe.skip` block:

```typescript
describe.skip(`Agent Safeguards Integration: ${modelId}`, () => {
  it('should inject system-reminder after 3 identical test_model failures and terminate before 8 turns', async () => {
    // Setup: register a deterministic broken `test_model` tool fixture that
    // always returns `errorCode: 'TOOL_EXECUTION_ERROR'` with the message
    // `Failed to fetch geometry for lib/main_rotor.scad` (matches screenshot).
    //
    // Drive: send a single user message asking the agent to fix multiple
    // floating-objects issues (the screenshot's actual prompt is a good fixture).
    //
    // Assert:
    //  1. The transcript JSONL contains a 'safeguard-fired' line with pattern AP1.
    //  2. The final assistant message references the failure (not silent termination).
    //  3. Total iterations < 8 (vs the unbounded ~15 in the screenshot).
    //  4. Tokens-per-failed-pattern < 10k (sanity bound on the burn).
  }, 120_000);
});
```

This is the EVAL the user requested. Reuse the existing `createTestApp` / `collectStreamChunks` / `extractUsageData` helpers already imported in that file. Skipped by default like the other integration tests; runs when `TEST_MODEL_ID` is set.

### Telemetry verification

Add an assertion that `gen_ai.agent.safeguard.fired{pattern="identical-error",action="nudge"}` was recorded — extends `tool-metrics.middleware.test.ts` patterns. The `helped` attribute comes from a follow-up `wrapModelCall` that compares the next turn's tool calls; its test belongs in the unit suite, not the integration.

## Trade-offs

| Concern                                           | Mitigation                                                                                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nudge pollution near context limit                | Run **after** `createCompactionMiddleware` in the chain; compaction strips old nudges before they get re-cached. Cap nudges at 1 per detection class per agent run.                                                     |
| False positive on legitimate iterative refinement | Detectors require **identical** args (not just same tool); pair edit-count with outcome change before counting AP3. Threshold 3 chosen because LangSight reports zero false-positives at this value across their fleet. |
| Detector amplification                            | Single-intervention-per-turn rule (the for-loop in `wrapModelCall` returns on first non-clear detection).                                                                                                               |
| Adds latency to every model call                  | Detectors are O(messages.tail(6)) ≈ O(1) for our turn lengths; SHA-256 of small JSON < 100µs. Negligible vs the 200-2000ms of the model call itself.                                                                    |
| Termination surprises the user                    | Final synthetic AIMessage includes the structured reason and what to try next; surfaced in the chat UI same as any assistant message.                                                                                   |
| Hides the underlying tool bug                     | Telemetry counter `gen_ai.agent.safeguard.fired` becomes the alert signal — sustained firings on the same `pattern + toolName` should page on-call; the safeguard is the **mitigation**, R8 is the **fix**.             |

## Diagrams

```text
                    ┌─────────────────┐
                    │  user message   │
                    └────────┬────────┘
                             ▼
       ┌─────────────────────────────────────────────────┐
       │           Tau middleware chain                  │
       │                                                 │
       │  toolMetrics → toolErrorHandler                 │
       │      │                                          │
       │      ▼                                          │
       │  ┌────────────────────────────────────────┐     │
       │  │  agent-safeguards.middleware (NEW)     │     │
       │  │                                        │     │
       │  │  for detector in [AP1, AP2, AP3, …]:   │     │
       │  │    detection = detector.evaluate(msgs) │     │
       │  │    switch detection.kind:              │     │
       │  │      'nudge':                          │     │
       │  │        inject <system-reminder>        │     │
       │  │      'terminate':                      │     │
       │  │        return synthetic AIMessage      │     │
       │  │      'clear':                          │     │
       │  │        continue                        │     │
       │  └────────────────────────────────────────┘     │
       │      │                                          │
       │      ▼                                          │
       │  toolOffloading → toolResultTrimmer →           │
       │      compaction → sanitize → trim → latex →     │
       │      promptCaching → logging → metrics →        │
       │      iterations → usage → contextUsage →        │
       │      transcript → clientContext                 │
       └─────────────────┬───────────────────────────────┘
                         ▼
                  ┌─────────────┐
                  │   model     │
                  └─────────────┘
```

## References

External:

- [LangChain — Improving Deep Agents with harness engineering](https://blog.langchain.com/improving-deep-agents-with-harness-engineering/) (Trivedy, Feb 2026)
- [Vercel AI SDK — Loop Control](https://ai-sdk.dev/docs/agents/loop-control)
- [AgentPatterns — Loop Detection for AI Agents](https://agentpatterns.ai/observability/loop-detection/)
- [LangSight — How to Detect and Stop AI Agent Loops in Production](https://langsight.dev/blog/ai-agent-loop-detection/) (March 2026)
- [Pan, T. — The Retry Storm Problem in Agentic Systems](https://tianpan.co/blog/2026-04-10-retry-storm-problem-agentic-systems) (April 2026)
- [OnceOnly — Stop AI Agents from Repeating Tool Calls](https://www.onceonly.tech/blog/how-to-stop-ai-agents-repeating-actions/)
- [CrewAI #4682 — Agent Loop Detection Middleware RFC](https://github.com/crewAIInc/crewAI/issues/4682)

Tau internal:

- `apps/api/app/api/chat/chat.service.ts` (middleware chain assembly)
- `apps/api/app/api/chat/middleware/tool-error-handler.middleware.ts` (`ToolError` taxonomy)
- `apps/api/app/api/chat/middleware/agent-iterations.middleware.ts` (closest existing pattern)
- `apps/api/app/api/chat/middleware/compaction.middleware.ts` (state-schema + writer-event reference)
- `apps/api/app/api/chat/prompts/cad-agent.prompt.ts` (system-reminder contract surface)
- `apps/api/app/testing/middleware-integration.test.ts` (EVAL pattern)
- `libs/chat/src/utils/tool-error.utils.ts` (`ToolErrorCode` enumeration for AP7)
- `repos/claude-code/src/query.ts`, `src/query/tokenBudget.ts`, `src/utils/advisor.ts`, `src/utils/messages.ts`, `src/utils/permissions/denialTracking.ts` (Anthropic prior art)

## Appendix A: Anti-Pattern Quick Reference

Pin this in the middleware file as a comment header:

| ID  | Pattern                            | Trigger (default)                          | Action                  |
| --- | ---------------------------------- | ------------------------------------------ | ----------------------- |
| AP1 | Identical tool + args + error      | 3× consecutive                             | Nudge → terminate at 6× |
| AP2 | Identical tool + args (any result) | 5× consecutive                             | Nudge                   |
| AP3 | Same `targetFile` edited           | 5× without `get_kernel_result` status flip | Nudge                   |
| AP5 | Empty-result on search tool        | 3× consecutive                             | Nudge                   |
| AP7 | Same `errorCode`, different args   | 5× across 8-message window                 | Nudge                   |
| AP8 | Total iterations                   | hard cap 25 (was implicit)                 | Terminate               |
| AP9 | Cumulative spend on failed turns   | $1.00                                      | Terminate               |

Thresholds are starting points; tune with telemetry per AgentPatterns "measure intervention effectiveness" rule.

## Appendix B: Why "doom-loop" rather than "agent loop"?

The published 2026 vocabulary distinguishes:

- **Agent loop** — the normal `model → tool → model → tool` execution loop. Healthy.
- **Micro-loop** — short-cycle repetition within a single agent run. Pathological.
- **Doom-loop** — micro-loop where every iteration produces the same failure. The screenshot scenario. Pathological and self-reinforcing because the model often interprets identical errors as "I should try harder."
- **Ralph Wiggum loop** — cross-session repetition. The agent restarts with fresh context and repeats a previously-failed approach. Out of scope here.
- **Retry storm** — system-level cascade of retries amplified by user behavior. Out of scope here (orchestration concern, not middleware).

Adopting "doom-loop" in our middleware naming and telemetry attributes (`pattern: 'doom-loop'`) keeps us aligned with the published vocabulary and our future grep-ability.

## Implementation Status

Tracks each recommendation against the source code committed in this implementation pass. Out-of-scope items (R6, R8) are explicitly marked. Status legend: ✅ COMPLETE — shipped; ⏸️ DEFERRED — explicitly out of scope; 📋 PENDING — known follow-up.

| #              | Status              | Source of truth                                                                                                                                                       | Notes                                                                                                                                                                                                                                                                                                            |
| -------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1**         | ✅ COMPLETE         | `apps/api/app/api/chat/middleware/agent-safeguards.middleware.ts` (`identicalErrorDetector`)                                                                          | AP1 fires nudge at threshold 3 (default), terminate at 2× threshold via `wrapModelCall` short-circuit.                                                                                                                                                                                                           |
| **R2**         | ✅ COMPLETE         | Same file: `identicalCallDetector`, `perTargetEditDetector`, `emptyResultDetector`, `sameErrorDifferentArgsDetector`, `pingPongDetector`, `noForwardProgressDetector` | AP2/AP3/AP5/AP7 implemented in v1; AP4/AP6 from R9 also shipped early since they reuse the same `ToolEventSummary` tail.                                                                                                                                                                                         |
| **R3**         | ✅ COMPLETE         | `apps/api/app/api/chat/prompts/cad-agent.prompt.ts` (`<system_reminder_contract>` inside `<error_handling>`)                                                          | New tests in `cad-agent.prompt.test.ts` (`describe('R3 (safeguards): <system-reminder> recognition contract')`) lock in the contract: NOT-user-input wording, (a)/(b)/(c) options, no-echo instruction.                                                                                                          |
| **R4**         | ✅ COMPLETE         | `packages/telemetry/src/registry.ts` (`genAiAgentSafeguardInterventions`); `apps/api/app/telemetry/metrics.ts` (`MetricsService.genAiAgentSafeguardInterventions`)    | Counter renamed from `…safeguard.fired` to `…safeguard.interventions` to match OTEL plural-noun convention; `helped` attribute resolved on the next turn by inspecting whether the previous offending signature recurred.                                                                                        |
| **R5**         | ✅ COMPLETE         | `apps/api/app/testing/middleware-integration.test.ts` (last `it` in the existing `describe.skip` block)                                                               | EVAL test injects a `brokenGraphics` stub via `createTestApp({ graphicsStub })`, asserts (a) `role:'safeguard'` line in transcript with `pattern:'identical_error'`, (b) `< 8` LLM turns, (c) `< 10k` input tokens per fired pattern, (d) **CS5** — post-nudge `cacheReadTokens >= 80%` of the pre-nudge median. |
| **R6**         | ⏸️ DEFERRED         | —                                                                                                                                                                     | Per the user's brief, $/turn budget enforcement is **out of scope** for this pass. Telemetry from R4 is the prerequisite; revisit once we have a baseline of nudge/terminate ratios.                                                                                                                             |
| **R7**         | ✅ COMPLETE         | `agent-safeguards.middleware.ts` (`writeTranscriptLine` → `appendTranscriptLine`)                                                                                     | Each safeguard intervention appends a `{role:'safeguard', pattern, action, signature, timestamp}` line; verified by `agent-safeguards.middleware.test.ts` and end-to-end by R5.                                                                                                                                  |
| **R8**         | ⏸️ DEFERRED         | `apps/ui/app/hooks/rpc-handlers.ts:228-261`, `apps/api/app/api/tools/tools/tool-test-model.ts:137`                                                                    | Per the user's brief, the UI/RPC root cause fix (F1/F2/F3) is **out of scope** for this API-only pass. The middleware is the runtime backstop; F1 remains the highest-leverage cooperative repair and should ship in a follow-up.                                                                                |
| **R9**         | ✅ COMPLETE (early) | Same file: `pingPongDetector`, `noForwardProgressDetector`                                                                                                            | Shipped with v1 because both detectors share the `ToolEventSummary` tail and the marginal complexity is small. Watch the `helped/fired` ratio per AgentPatterns guidance and prune if either falls below 0.5.                                                                                                    |
| **R10**        | ⏸️ DEFERRED         | —                                                                                                                                                                     | AP10 (cross-message resubmit) and AP11 (reasoning-only stall) skipped as planned. Re-evaluate if telemetry shows them as common.                                                                                                                                                                                 |
| **C5** _(new)_ | ✅ COMPLETE         | `agent-safeguards.middleware.ts` (`beforeModel` nudge path); EVAL `cacheReadTokens >= 80%` assertion in R5                                                            | Codified as the **Cache-Safety Contract** below. Persisting nudges via `beforeModel` (state-messages reducer) keeps them part of the cacheable prefix on the very next turn — verified empirically by the EVAL.                                                                                                  |

### File-by-file change inventory

| File                                                                   | Status      | Purpose                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/app/api/chat/middleware/agent-safeguards.middleware.ts`      | ✅ NEW      | All seven detectors (AP1, AP2, AP3, AP4, AP5, AP6, AP7), canonical hashing (`canonicalArgsHash`, `errorHash`), `summarizeMessages`, `beforeModel` nudge path, `wrapModelCall` terminate path, transcript wiring, telemetry. |
| `apps/api/app/api/chat/middleware/agent-safeguards.middleware.test.ts` | ✅ NEW      | 50 unit tests covering all detectors, hashing determinism, reminder byte-determinism (CS3), CS1/CS4 invariants, telemetry attributes, helped=true/false next-turn correlation.                                              |
| `apps/api/app/api/chat/chat.service.ts`                                | ✅ MODIFIED | Inserted `createAgentSafeguardsMiddleware` after compaction and before `messageContentSanitizerMiddleware` (preserves cache prefix; survives compaction).                                                                   |
| `apps/api/app/api/chat/prompts/cad-agent.prompt.ts`                    | ✅ MODIFIED | Added `<system_reminder_contract>` inside `<error_handling>`; sets `cacheBreak: false` so the contract sits inside the same cache block as the rest of the static prompt.                                                   |
| `apps/api/app/api/chat/prompts/cad-agent.prompt.test.ts`               | ✅ MODIFIED | Added `describe('R3 (safeguards): <system-reminder> recognition contract')` block with four assertions.                                                                                                                     |
| `packages/telemetry/src/registry.ts`                                   | ✅ MODIFIED | Added `genAiAgentSafeguardInterventions` counter.                                                                                                                                                                           |
| `packages/telemetry/src/attributes.ts`                                 | ✅ MODIFIED | Added `GEN_AI_SAFEGUARD_PATTERN`, `GEN_AI_SAFEGUARD_ACTION`, `GEN_AI_SAFEGUARD_HELPED` keys; `GenAiSafeguardAction` and `GenAiSafeguardHelped` enums.                                                                       |
| `packages/telemetry/src/index.ts`                                      | ✅ MODIFIED | Re-exported the two new enums.                                                                                                                                                                                              |
| `packages/telemetry/src/registry.test.ts`                              | ✅ MODIFIED | Asserts the new counter is registered with the expected unit and description.                                                                                                                                               |
| `packages/telemetry/src/attributes.test.ts`                            | ✅ MODIFIED | Asserts the new attribute keys and enums are stable.                                                                                                                                                                        |
| `apps/api/app/telemetry/metrics.ts`                                    | ✅ MODIFIED | Wired `genAiAgentSafeguardInterventions` into `MetricsService`.                                                                                                                                                             |
| `apps/api/app/testing/create-test-app.ts`                              | ✅ MODIFIED | New `CreateTestAppOptions.graphicsStub?: RpcGraphicsClient` — passed straight through to `createRpcDispatcher`. Enables deterministic broken-tool fixtures for EVAL tests.                                                  |
| `apps/api/app/testing/middleware-integration.test.ts`                  | ✅ MODIFIED | New `it` (the EVAL) at the end of the existing `describe.skip` block.                                                                                                                                                       |
| `apps/api/app/testing/middleware-testing.utils.ts`                     | ✅ MODIFIED | `invokeWrapModelCall` now accepts an optional `state` field on the request, matching the LangChain `ModelRequest` shape.                                                                                                    |

## Cache-Safety Contract

This contract is mandatory. Violating any of CS1–CS6 will demonstrably regress per-turn cost on Anthropic prompt-cached models — see [`docs/research/chat-model-cost-forensics.md`](./chat-model-cost-forensics.md) for the underlying economics and [`docs/research/cache-strategy-analysis.md`](./cache-strategy-analysis.md) for the prefix-cache rules.

### CS1 — Inject nudges via `beforeModel`, never `wrapModelCall`

**Rule**: Safeguard nudges MUST be appended to `state.messages` from a `beforeModel` hook so they persist into the next turn via LangGraph's state-messages reducer. They MUST NOT be inserted only into `request.messages` from `wrapModelCall`, because that mutation is invisible to the next iteration's prefix and the LLM will repeat the offending call without ever seeing the reminder.

**Why it's safe**: Anthropic prefix caching matches by content prefix, not by message ordinal. Appending a `HumanMessage` to the **end** of the cacheable region grows the prefix; the prior turn's prefix remains a strict subset of the new prefix and stays cache-eligible. The `<system-reminder>` becomes part of the new cache breakpoint on the **next** turn, so cost amortizes after one paid extension instead of paying full input tokens forever.

**Counter-example (would be wrong)**: `wrapModelCall(req, handler) → handler({ ...req, messages: [...req.messages, new HumanMessage(reminder)] })`. The reminder is consumed by the immediate model call but is never written to graph state — next turn re-runs the detectors, fires again, injects again, and the model never sees a stable contract.

### CS2 — Place the middleware BEFORE `promptCachingMiddleware`

**Rule**: `agent-safeguards.middleware.ts` MUST sit upstream of `promptCachingMiddleware` in `chat.service.ts`. The nudge `HumanMessage` MUST be present at the moment `cache_control: { type: 'ephemeral' }` markers are placed.

**Why it's safe**: `promptCachingMiddleware` injects breakpoints based on the message tail it sees. If the safeguard ran downstream, the nudge would be added after the breakpoint, splitting the cache prefix and forcing a full re-prefill on the next call.

**Verification**: see `apps/api/app/api/chat/chat.service.ts` middleware order — safeguards are between `createCompactionMiddleware` and `messageContentSanitizerMiddleware`, both of which are upstream of `promptCachingMiddleware`.

### CS3 — Reminder text MUST be byte-deterministic

**Rule**: The `<system-reminder>...</system-reminder>` body MUST be a pure function of `(pattern, toolName, argsHash, errorHash, count)`. It MUST NOT contain `Date.now()`, `crypto.randomUUID()`, the LangGraph turn counter, or any other source of per-turn drift.

**Why it's safe**: A reminder that varies on every turn breaks the prefix on every turn. The same anti-pattern firing twice MUST produce byte-identical reminder text so the cached prefix from the first nudge survives the second nudge.

**Verification**: `agent-safeguards.middleware.test.ts` `describe('CS3 reminder text byte-determinism')` calls each reminder template twice with the same inputs and asserts `===` equality.

### CS4 — Skip in-flight tool calls when summarizing the tail

**Rule**: `summarizeMessages` MUST ignore any `AIMessage` whose tool-call IDs are not yet matched by a corresponding `ToolMessage`. Detectors only see **completed** tool round-trips.

**Why it's safe**: The detector tail is what becomes the input to the prefix that the LLM caches. If we summarized a half-completed turn (AIMessage emitted, ToolMessage pending), we'd produce a different `ToolEventSummary[]` on every chunk arrival and the prefix would churn.

**Verification**: `agent-safeguards.middleware.test.ts` `it('skips in-flight tool calls (CS4)')`.

### CS5 — One nudge per `(pattern, signature)` per agent run

**Rule**: The middleware MUST track `_safeguardSignaturesFired: string[]` in `stateSchema` and refuse to re-emit a nudge for a signature it has already fired in this run. The escalation from nudge → terminate is by **count of distinct firings** of the same anti-pattern, not by re-firing the same signature.

**Why it's safe**: Without dedup, a persistent identical-error pattern would inject the same `<system-reminder>` on every subsequent turn, fragmenting the prefix. With dedup, the prefix grows by exactly one nudge per distinct failure mode and stays cache-stable.

**Verification**: `agent-safeguards.middleware.test.ts` `it('does not double-fire on the same signature')`; the EVAL in `middleware-integration.test.ts` asserts `cacheReadTokens` on the post-nudge turn is `>= 80%` of the pre-nudge median.

### CS6 — Helped telemetry MUST NOT mutate the prefix

**Rule**: The `helped: true|false` attribute on `gen_ai.agent.safeguard.interventions` MUST be computed at telemetry-emission time on the next turn by inspecting `state._safeguardLastSignature`. It MUST NOT be written into the message stream as a "did the model recover?" follow-up message.

**Why it's safe**: Telemetry is observability, not state. Writing a synthetic "the model recovered" line into `state.messages` would itself be a cache-busting prefix mutation and would defeat CS5.

**Verification**: `agent-safeguards.middleware.test.ts` `describe('helped telemetry resolution')` asserts the counter attribute changes between turns without any new message being appended.

### Why this is consistent with `context-injection-architecture.md`

The injection-architecture research recommends `beforeModel` for **persistent** state (system reminders, skills) and `wrapModelCall` for **transient** request-shaping (compaction, retry policy). Safeguard nudges are unambiguously persistent — the model needs to see the same reminder on every subsequent turn until it abandons the offending strategy — so `beforeModel` is the correct hook. Termination is transient (a single short-circuit), so it stays in `wrapModelCall`. The two-hook design is intentional and matches the published guidance.
