---
title: 'Complex Task Agent Gap Analysis'
description: 'Gap analysis of Tau agent prompt, context, and agentic architecture for complex, detail-demanding engineering CAD tasks versus state-of-the-art text-to-CAD systems and modern multi-agent orchestration patterns.'
status: active
created: '2026-04-02'
updated: '2026-04-02'
category: comparison
related:
  - docs/policy/context-engineering-policy.md
---

# Complex Task Agent Gap Analysis

Gap analysis of where Tau's agent falls short when tasked with complex, detail-demanding engineering work — contrasted against state-of-the-art text-to-CAD research (CADSmith, ProCAD), modern multi-agent orchestration patterns, and established engineering decomposition practices — with actionable recommendations to close each gap.

## Executive Summary

When given a complex reference image of a rocket engine assembly, Tau's agent produced a structurally recognizable but geometrically imprecise model: simplified bell curves instead of dimensioned profiles, uniform cylinders instead of corrugated/ribbed sections, absent plumbing routing, and no quantitative verification that dimensions matched the reference. Analysis reveals seven systemic gaps: (1) no specification decomposition phase before code generation, (2) no geometric verification loop, (3) no hierarchical task decomposition for assemblies, (4) no dimensional constraint propagation, (5) insufficient visual verification feedback, (6) prompt-level anti-gold-plating rules that conflict with detail-demanding tasks, and (7) no engineering domain knowledge injection. These gaps are addressable through prompt, context, and agentic architecture changes without requiring new ML models.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Finding 1: No Specification Decomposition Phase](#finding-1-no-specification-decomposition-phase)
- [Finding 2: No Geometric Verification Loop](#finding-2-no-geometric-verification-loop)
- [Finding 3: No Hierarchical Task Decomposition](#finding-3-no-hierarchical-task-decomposition)
- [Finding 4: No Dimensional Constraint Propagation](#finding-4-no-dimensional-constraint-propagation)
- [Finding 5: Insufficient Visual Verification Feedback](#finding-5-insufficient-visual-verification-feedback)
- [Finding 6: Anti-Gold-Plating Rules Conflict with Engineering Detail](#finding-6-anti-gold-plating-rules-conflict-with-engineering-detail)
- [Finding 7: No Engineering Domain Knowledge Injection](#finding-7-no-engineering-domain-knowledge-injection)
- [Finding 8: Context Window Exhaustion on Complex Assemblies](#finding-8-context-window-exhaustion-on-complex-assemblies)
- [Finding 9: Single-Agent Monolithic Execution](#finding-9-single-agent-monolithic-execution)
- [Finding 10: No Design Intent Persistence](#finding-10-no-design-intent-persistence)
- [State of the Art Comparison](#state-of-the-art-comparison)
- [Recommendations](#recommendations)
- [References](#references)

## Problem Statement

A user provided a detailed reference image of a liquid rocket engine assembly and asked the agent to "design this, miss no details." The agent produced a result (image 1) that is structurally recognizable but falls critically short of the reference (image 2) in multiple dimensions:

| Aspect               | Reference (img2)                                                                                    | Agent Output (img1)                                             | Gap                  |
| -------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------- |
| **Nozzle bell**      | Precise Rao/parabolic bell contour with regenerative cooling channels visible                       | Smooth spline approximation, no cooling channels                | Dimensional + detail |
| **Injector head**    | Multi-layer assembly with distinct corrugated red section, bolted blue flange, grooved gimbal mount | Simplified stacked cylinders, uniform slot cuts                 | Topological detail   |
| **Turbopump**        | Complex multi-stage pump with visible volute housing, turbine blading, inlet/outlet flanges         | Single sphere + cylinder stack                                  | Missing features     |
| **Plumbing**         | Precise 3D routed pipes with elbow fittings, manifold connections, flex joints                      | Bezier sweep attempts (failed silently), simplified torus rings | Missing features     |
| **Actuators**        | Hydraulic pistons with clevis mounts, cylinder bodies, piston rods, gimbal ball joints              | Basic cylinders with manual rotation math                       | Missing features     |
| **Overall fidelity** | ~30+ distinct components with visible fasteners, brackets, structural rings                         | ~15 simplified shapes, no fasteners or brackets                 | 50%+ feature loss    |

The transcript reveals the agent's workflow: create a plan file → implement files sequentially → compile → fix errors → screenshot once → declare done. No iterative refinement based on visual comparison to the reference occurred. No dimensional verification was attempted. The agent never returned to refine after seeing the first render.

## Methodology

1. Analyzed the full 2,900-line design transcript to catalog every agent decision, error, and shortcut
2. Compared agent output (image 1) against reference (image 2) across 12 engineering quality dimensions
3. Surveyed coordinator-style multi-agent orchestration patterns from production agent harnesses, focusing on phase decomposition, adversarial verification, and durable cross-worker context
4. Reviewed state-of-the-art text-to-CAD research: CADSmith (CMU, 2026), ProCAD (arXiv 2602.03045), FutureCAD, Pointer-CAD, Leo AI assemblies
5. Reviewed Tau's prompt system (`cad-agent.prompt.ts`), tool definitions (13 tools), context injection pipeline, and `@taucad/testing` geometry analysis
6. Researched engineering topology decomposition, design intent preservation, and manufacturing-grade CAD practices

## Finding 1: No Specification Decomposition Phase

### The Problem

The agent jumps directly from the reference image to code generation. The "plan.md" it creates is a high-level outline (45 lines), not a dimensioned specification. Critical engineering details are left as prose descriptions ("features vertical/horizontal ribbing") rather than quantified constraints (rib count, rib width, rib depth, angular spacing).

### Evidence from Transcript

The agent's plan contains entries like:

> "Includes structural rings and the uppermost mounting interface"

This is a description, not a specification. There are no dimensions, no tolerances, no constraint relationships between parts. When the agent later implements the injector, it invents dimensions (`p.injectorRadius: 250`, `p.injectorHeight: 250`) with no derivation from the reference image.

### State of the Art: ProCAD's Clarifying Agent

ProCAD (arXiv 2602.03045) introduces a dedicated **Clarifying Agent** that audits the prompt before code generation. When specifications are ambiguous or incomplete, it asks targeted clarification questions. This reduces mean Chamfer distance by 79.9% and invalidity ratio from 4.8% to 0.9%.

### State of the Art: CADSmith's Planner Agent

CADSmith decomposes the generation problem into five specialized agents, with the **Planner Agent** producing a structured JSON specification: component list with sub-part descriptions, target bounding box dimensions in millimeters, geometric constraints (hole counts, diameters, symmetry properties), and notes for downstream agents. The Planner does not generate CAD code — its role is to decompose design intent into an unambiguous specification.

### Tau Gap

Tau's system prompt does not instruct the agent to produce a dimensioned specification before coding. There is no structured specification format. The `<workflow>` section jumps from "understand the task" to "write code." For image-based tasks, there is no instruction to systematically extract dimensions, count features, identify constraint relationships, or produce a structured decomposition before implementation.

## Finding 2: No Geometric Verification Loop

### The Problem

The agent compiles code, checks that it renders without errors, takes one screenshot, and stops. There is no quantitative verification that the output geometry matches the reference. The transcript shows:

1. `get_kernel_result` → "Status: ready" (compilation succeeded)
2. `test_model` → passes (but test only checks `meshCount >= 5` and `boundingBox.z ≈ 2030`)
3. `screenshot` → one multi-angle capture
4. Agent declares completion

No Chamfer distance, no IoU, no bounding box comparison to reference dimensions, no volume check, no face count verification.

### State of the Art: CADSmith's Dual-Loop Validation

CADSmith implements two nested correction loops:

- **Inner loop** (up to 3 iterations): Resolves execution errors (syntax, API misuse) using a RAG-augmented Error Refiner with a knowledge base of 25 common failure patterns
- **Outer loop** (up to 5 iterations): Programmatic geometric validation combining exact OpenCASCADE kernel measurements (bounding box, volume, face/edge/vertex counts, solid validity) with independent VLM Judge assessment (Claude Opus evaluating three-view renders)

This dual feedback achieves: 100% execution rate (vs 95% baseline), median IoU 0.9629 (vs 0.8085), mean Chamfer Distance 0.74 (vs 28.37).

### Tau Gap

Tau's `test_model` tool exposes only: `boundingBox`, `meshCount`, `vertexCount`, `connectedComponents`, `watertight`. These are necessary but not sufficient for engineering verification. Missing capabilities:

- **Per-component dimensional checks** (individual part bounding boxes, not just assembly)
- **Volume comparison** against expected values
- **Surface area / face count** verification
- **Comparison against reference** (image-based or mesh-based)
- **Iterative refinement loop** — the agent has no prompt instruction to re-enter implementation after verification fails
- **Independent verification** — the same model that generates code also evaluates it (self-confirmation bias)

## Finding 3: No Hierarchical Task Decomposition

### The Problem

The agent treats a 30+ component assembly as a single sequential task. It creates files one-by-one, never steps back to assess overall progress, and has no mechanism to track which components are complete vs incomplete. When early components encounter errors, later components inherit incorrect assumptions.

### Evidence from Transcript

The agent creates `lib/nozzle.ts`, hits an error, fixes it, moves to `lib/injector.ts`, hits errors, fixes them, creates `lib/turbopump.ts`, `lib/actuators.ts`, `lib/plumbing.ts` — all in sequence. At no point does it assess whether the nozzle's actual dimensions match what the injector expects at their interface. There is no interface contract between components.

### State of the Art: Coordinator Phase Decomposition

A robust pattern for multi-component tasks separates **investigation** from **synthesis** from **execution**, assigning each to a different role so cognitive load and context budgets are bounded per phase:

| Phase          | Who                | Purpose                                              |
| -------------- | ------------------ | ---------------------------------------------------- |
| Research       | Workers (parallel) | Investigate codebase, find files, understand problem |
| Synthesis      | **Coordinator**    | Read findings, craft implementation specs            |
| Implementation | Workers            | Make targeted changes per spec                       |
| Verification   | Workers            | Test changes work                                    |

Synthesis (understanding) must stay at the orchestration layer. The anti-pattern "based on your findings, fix the bug" — which collapses synthesis and implementation into one step — should be prohibited in favor of synthesized specifications with file paths, line numbers, and explicit interface contracts. This separation prevents context pollution between roles and lets each worker operate with a focused, role-specific context window.

### State of the Art: Engineering BOM-Driven Decomposition

In mechanical engineering, complex assemblies are decomposed via a Bill of Materials (BOM) tree:

```
Assembly (Rocket Engine)
├── Sub-assembly: Thrust Chamber
│   ├── Part: Nozzle Bell (interfaces: throat flange, exit plane)
│   ├── Part: Throat Section (interfaces: nozzle flange, chamber flange)
│   └── Part: Combustion Chamber (interfaces: throat flange, injector face)
├── Sub-assembly: Injector Head
│   ├── Part: Injector Plate (interfaces: chamber face, manifold face)
│   ├── Part: Oxidizer Manifold (interfaces: injector face, feed line)
│   └── Part: Fuel Manifold (interfaces: injector face, feed line)
├── Sub-assembly: Turbopump
│   ├── Part: Pump Housing
│   ├── Part: Turbine Housing
│   └── Part: Shaft
└── Sub-assembly: Gimbal System
    ├── Part: Gimbal Ring (interfaces: mount points, actuator clevises)
    └── Part: Actuator × 2 (interfaces: gimbal clevis, frame clevis)
```

Each interface defines mating surfaces, bolt patterns, and dimensional constraints that must match between parts. This is absent from Tau's prompting.

### Tau Gap

Tau's prompt mentions `main.ts` + `lib/<component>.ts` file layout but provides no instruction for:

- BOM-driven decomposition with interface contracts
- Tracking completion status across components
- Verifying interface compatibility between mating parts
- Parallel vs sequential implementation ordering
- Assembly-level integration testing after all parts are created

## Finding 4: No Dimensional Constraint Propagation

### The Problem

When the agent creates the nozzle with `throatRadius: 150`, the injector must have an inner radius that mates with the throat's outer radius. But the agent defines `injectorRadius: 250` independently — there is no constraint that `injector.innerRadius === nozzle.throatOuterRadius`. When the agent later adjusts the nozzle, the injector dimensions become stale.

### Evidence from Transcript

The `params.ts` file defines all dimensions as flat constants with no dependency relationships:

```typescript
throatRadius: 150,
chamberRadius: 250,     // No relation to throatRadius defined
injectorRadius: 250,    // No relation to chamberRadius defined
```

In real parametric CAD, these would be constrained: `chamberRadius = throatRadius * expansionRatio`, `injectorRadius = chamberRadius + wallThickness`. When one changes, dependents update automatically.

### State of the Art: Design Intent Preservation

Autodesk Research demonstrated that adapting alignment techniques from LLMs to constraint generation achieves 93% full-constraint rates vs 34% with naive approaches. The key insight: parametric models must encode _relationships_ (parallel, concentric, tangent, equal, driven-dimension), not just _values_.

### Tau Gap

Tau's system prompt does not instruct the agent to:

- Define parametric relationships between dimensions (e.g., `exitDiameter = throatDiameter * expansionRatio`)
- Create mating constraints at interfaces (concentricity, coplanarity, bolt circle alignment)
- Use engineering formulas to derive dimensions from functional requirements
- Validate constraint satisfaction after modifications

## Finding 5: Insufficient Visual Verification Feedback

### The Problem

The `screenshot` tool captures the current render, but the agent has no way to compare it against the reference image. The `<visual_inspection>` prompt section instructs the agent to check for visual correctness, but without a structured comparison methodology, the agent performs a qualitative "looks about right" assessment.

### Evidence from Transcript

After the first successful render, the agent takes one multi-angle screenshot, writes a summary, and stops. It does not:

- Compare specific features against the reference (e.g., "the reference shows 36 cooling channels on the nozzle; the render shows 0")
- Identify missing components by systematic comparison
- Quantify the geometric deviation from the reference
- Plan corrective iterations based on identified deficiencies

### State of the Art: CADSmith's VLM Judge

CADSmith uses an **independent** vision-language model (Claude Opus) as a Judge that:

1. Receives three-view renders (front, side, top) of the generated geometry
2. Compares against the text specification (not the reference image directly)
3. Provides structured textual feedback identifying specific geometric discrepancies
4. Operates independently from the generation model (Claude Sonnet) to avoid self-confirmation bias

### State of the Art: Adversarial Verification with Rationalization Inoculation

A complementary pattern is to run a dedicated verification pass with a prompt that **preemptively names and blocks the model's most common avoidance tactics**, turning evaluator self-skepticism into an explicit instruction set:

- "The code looks correct based on my reading" → reading is not verification. Run it.
- "The implementer's tests already pass" → the implementer is an LLM. Verify independently.
- "This is probably fine" → probably is not verified.

The architectural rationale: a generator and verifier sharing the same prompt and same context inherit the same blind spots. Asymmetric prompting — where the verifier is told to actively distrust the generator's claims — breaks the self-confirmation loop without requiring two different model families.

### Tau Gap

Tau's visual verification is single-pass and qualitative. It lacks:

- **Reference comparison** — no tool to overlay or compare reference image against render
- **Feature checklist** — no structured list of features to verify (derived from specification)
- **Independent judgment** — no separation between generator and verifier
- **Iterative re-entry** — no prompt instruction to return to implementation after visual deficiencies are identified
- **Multi-angle verification** — `multi_angle` mode exists but no instruction on how to systematically use the six views

## Finding 6: Anti-Gold-Plating Rules Conflict with Engineering Detail

### The Problem

Tau's system prompt includes three anti-gold-plating rules (a common pattern in production coding agents):

1. "Don't add features, refactor code, or make 'improvements' beyond what was asked"
2. "Don't add error handling, fallbacks, or validation for scenarios that can't happen"
3. "Don't create helpers, utilities, or abstractions for one-time operations"

Additionally, the `<output_efficiency>` section instructs: "keep text between tool calls to ≤25 words" and "keep final responses to ≤100 words."

These rules are appropriate for simple coding tasks where over-engineering is the failure mode. But for complex engineering tasks where the user explicitly asks to "miss no details," these rules create a conflicting directive: the agent is simultaneously told to be comprehensive AND to not add features beyond what was asked.

### Evidence from Transcript

The agent's thinking traces show it repeatedly simplifying: "To keep it simple but visually impactful, we can revolve a jagged profile or cut out vertical slots. Vertical slots are easier to compute." This is a textbook example of the agent optimizing for simplicity (anti-gold-plating) when the task demands detail (engineering fidelity).

### State of the Art: Task-Type-Aware Prompt Branching

Mature agent harnesses recognize that a single behavioral profile cannot serve both "quick edit" and "exhaustive engineering" task classes. The architectural pattern is to **branch the system prompt on detected task type or user segment**, swapping in different versions of the same tool prompts (e.g., a verbose "planning" tool variant for high-stakes work versus a terse one for routine edits) and to layer in a token-budget directive that tells the model to "keep working until you approach the target" rather than optimizing for output brevity. Without this branching, conciseness rules tuned for the common case actively sabotage the long-tail detail-demanding case.

### Tau Gap

Tau serves the same anti-gold-plating rules regardless of task complexity. There is no mechanism to:

- Detect when a task demands high detail vs minimal output
- Adjust behavioral constraints based on task type (engineering vs quick edit)
- Override efficiency limits for complex tasks
- Signal that "miss no details" overrides default conciseness rules

## Finding 7: No Engineering Domain Knowledge Injection

### The Problem

The agent has CAD API knowledge (replicad/CadQuery function signatures) but no engineering domain knowledge. It doesn't know:

- What a regenerative cooling channel looks like or how it's constructed
- Standard nozzle bell contour equations (Rao method, method of characteristics)
- Typical bolt circle patterns, flange standards, pipe routing conventions
- How turbopumps are structured (inducer → impeller → volute → diffuser)
- Standard manufacturing constraints (minimum wall thickness, draft angles, fillet radii)

### Evidence from Transcript

The agent creates a turbopump as `makeSphere(radius)` + `makeCylinder(radius * 0.8, height * 0.4)` — a sphere and a cylinder. A real turbopump has an inducer, impeller, volute housing, bearing supports, seal cavities, and shaft passages. The agent has no domain knowledge to decompose "turbopump" into its engineering sub-components.

### State of the Art: CADSmith's RAG Knowledge Bases

CADSmith maintains two retrieval knowledge bases:

- **KB1**: 155 CadQuery method entries with signatures, descriptions, usage examples, and known pitfalls
- **KB2**: 25 error-solution patterns covering common OpenCASCADE failure modes

These are keyword-matched at inference time, not embedded in the prompt. This approach scales to large corpora without consuming context window tokens.

### Tau Gap

Tau injects kernel-specific API documentation and canonical examples via `<api_documentation>` and `<canonical_example>` sections. But there is no engineering domain knowledge:

- No component taxonomy (what sub-parts constitute a "turbopump" or "injector head")
- No standard engineering formulas (nozzle expansion ratio, bolt circle spacing)
- No manufacturing constraints database
- No retrieval-augmented access to engineering standards or domain knowledge

## Finding 8: Context Window Exhaustion on Complex Assemblies

### The Problem

The rocket engine transcript consumed 228,060 input tokens and 19,178 output tokens for a single generation pass — and the result was still incomplete. Complex assemblies require maintaining awareness of: all component specifications, interface contracts between parts, current implementation status, error history, and the original reference throughout the entire generation process.

### Evidence from Transcript

The agent created a `params.ts` file, then deleted it mid-session to restructure parameters, causing import errors. This restructuring burned tokens on error recovery that could have been spent on geometry improvement. By the end of the session, the agent had lost track of which components matched the reference and which were simplified approximations.

### State of the Art: Layered Context Management

Long-running complex tasks survive context window limits only when several mechanisms work together — no single technique is sufficient:

- **Scratchpad directory**: Workers read/write files for durable cross-worker knowledge that outlives any single message turn
- **Post-compact file restoration budget**: After compaction, a bounded set of "anchor" files (e.g., 5 files, 50K tokens, with per-file caps) is automatically re-injected so critical context survives
- **Session memory compaction**: Tunable thresholds (e.g., min 10K, max 40K tokens) so compaction fires before context exhaustion, not after
- **"Summarize tool results" instruction**: Tells the agent to actively distill important information into durable artifacts _before_ it scrolls out of context, rather than relying on retrieval after the fact
- **Token budget continuation**: A directive that the budget is a hard minimum, not a ceiling — preventing premature termination on detail-demanding tasks

The architectural insight is that compaction alone is reactive and lossy. Pairing it with proactive durable artifacts (scratchpads, spec files, anchor restoration) transforms context management from a memory-lossy summarization problem into a structured persistence problem.

### Tau Gap

Tau has compaction (`compaction.middleware.ts`) with nine-section summaries and drift guards (R13, R15 improvements), but lacks:

- **Scratchpad persistence** — no tool to write and retrieve intermediate specifications or status
- **Component status tracking** — no structured way to record "nozzle: complete, turbopump: 40%, plumbing: not started"
- **Token budget awareness** — no instruction to the agent about how much context remains or how to prioritize remaining work
- **Strategic context management** — no instruction to frontload critical specifications into durable storage before they scroll out of context

## Finding 9: Single-Agent Monolithic Execution

### The Problem

Tau uses a single agent for the entire design task: image analysis, specification extraction, code generation, error debugging, visual verification, and iteration. This means the agent must simultaneously be an expert at image understanding, CAD programming, debugging, and engineering design — while maintaining coherent context across all roles.

### State of the Art: Multi-Agent Specialization

CADSmith uses five specialized agents:

| Agent         | Role                                                  | Capabilities                           |
| ------------- | ----------------------------------------------------- | -------------------------------------- |
| **Planner**   | Decompose design intent into structured specification | JSON output, no code generation        |
| **Coder**     | Generate CadQuery code from specification             | RAG-augmented, API knowledge           |
| **Executor**  | Run code in sandboxed subprocess                      | Deterministic, no LLM                  |
| **Validator** | Combine kernel metrics + VLM Judge                    | Independent from coder model           |
| **Refiner**   | Correct code based on structured feedback             | Receives exact geometric discrepancies |

A complementary industry pattern uses specialized workers along similar role boundaries: Research (parallel investigation), Plan (read-only architect), Implementation, and Verification (adversarial, with no write access to the project to enforce evaluator independence).

### Tau Gap

Tau's single-agent architecture means:

- **No role specialization** — same model/prompt for analysis, coding, and verification
- **Self-confirmation bias** — the agent evaluates its own work
- **Context pollution** — debugging context from one component pollutes the context for the next
- **No parallelism** — components that could be designed independently are serialized

## Finding 10: No Design Intent Persistence

### The Problem

The agent's "plan.md" is a static file created once at the start. As the agent iterates, the plan is never updated to reflect what was actually implemented, what was simplified, or what remains to be done. When context compaction occurs, the detailed design intent captured in the plan may be summarized away.

### State of the Art: Engineering Feature Trees

In professional CAD systems (SolidWorks, CATIA, Onshape), the feature tree serves as a persistent, editable record of every design decision. Each feature has: a name, parent dependencies, parameters, constraints, and suppression state. The feature tree is the canonical representation — the geometry is derived from it.

### Tau Gap

- No mechanism to update the plan file as implementation progresses
- No structured status tracking per component
- No design decision log (why was the turbopump simplified? was it intentional or a shortcut?)
- No "resume from plan" capability if the session is interrupted

## State of the Art Comparison

| Capability                 | CADSmith                                     | ProCAD                                 | Coordinator-Style Coding Agents          | Leo AI                        | Tau                                 |
| -------------------------- | -------------------------------------------- | -------------------------------------- | ---------------------------------------- | ----------------------------- | ----------------------------------- |
| **Spec decomposition**     | Planner agent → JSON spec                    | Clarifying agent → refined prompt      | Coordinator synthesis phase              | Feature tree generation       | None — plan.md is prose             |
| **Geometric verification** | Dual-loop: OCCT kernel + VLM Judge           | Post-generation chamfer distance       | Adversarial verification worker          | Built-in CAD validation       | Single-pass: meshCount + bbox       |
| **Task decomposition**     | 5 specialized agents                         | 2-agent pipeline                       | 4-phase coordinator + workers            | Integrated CAD engine         | Single agent, sequential            |
| **Constraint propagation** | Planner extracts explicit constraints        | Clarifying agent resolves ambiguity    | N/A (code, not CAD)                      | Native parametric constraints | Flat params, no relationships       |
| **Visual verification**    | Three-view VLM Judge (independent model)     | N/A                                    | Screenshot + rationalization inoculation | Native 3D viewport            | Screenshot (self-evaluation)        |
| **Domain knowledge**       | RAG over 155 API entries + 25 error patterns | Fine-tuned on curated CadQuery dataset | Tool prompts + project-level memory file | CAD kernel internals          | Kernel API docs + canonical example |
| **Iteration count**        | Inner: 3, Outer: 5                           | Single-pass + clarification            | Unlimited (token budget)                 | Interactive                   | Typically 1-2 compile-fix cycles    |
| **Reference comparison**   | Chamfer distance, IoU, F1 vs mesh            | Chamfer distance vs reference          | Visual diff                              | N/A                           | None                                |

## Recommendations

### Prompt-Level Changes

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                              | Priority | Effort | Impact                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | --------------------------------------------------- |
| R1  | **Add specification decomposition phase to workflow** — before any code generation, instruct the agent to produce a structured specification: component list with names, dimensions (in mm), interface definitions (mating surfaces, bolt patterns), constraint relationships, and material/color assignments. For image-based tasks, include explicit "extract all visible dimensions" instruction | P0       | Low    | Critical — prevents premature coding                |
| R2  | **Add iterative verification loop to workflow** — after each component implementation, instruct the agent to: (a) run `test_model` with per-component assertions, (b) take multi-angle screenshots, (c) compare against specification, (d) identify deficiencies, (e) re-enter implementation. Minimum 2 verification cycles for complex tasks                                                      | P0       | Low    | Critical — single-pass is the primary failure mode  |
| R3  | **Add task-complexity detection with behavioral override** — when the user's prompt contains signals like "miss no details", "engineering-grade", "manufacture-ready", or references a complex image, inject a `<complex_task>` section that: suspends anti-gold-plating rules, removes word-count limits, enables detail-maximizing behavior, and requires specification-first workflow            | P0       | Medium | High — resolves the gold-plating vs detail conflict |
| R4  | **Add engineering topology decomposition template** — inject a BOM-driven decomposition template into the prompt for assembly tasks: assembly → sub-assemblies → parts, with interface contracts (mating faces, concentricity, bolt circles) defined at each boundary                                                                                                                               | P1       | Medium | High — enables systematic assembly design           |
| R5  | **Add dimensional constraint propagation instruction** — instruct the agent to define parameters as expressions, not values: `chamberRadius = throatRadius * 1.667` instead of `chamberRadius = 250`. Include instruction to verify all interface dimensions match between mating components                                                                                                        | P1       | Low    | High — prevents dimensional inconsistency           |
| R6  | **Add visual comparison methodology** — instruct the agent to systematically compare renders against the reference/specification using a checklist: for each component, verify presence, approximate shape, relative position, color, and surface detail. Score completeness as fraction (e.g., "15/28 components visible")                                                                         | P1       | Low    | Medium — structures qualitative visual check        |

### Tool-Level Changes

| #   | Action                                                                                                                                                                                                                                                                           | Priority | Effort | Impact                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------ |
| R7  | **Add per-component geometry analysis** — extend `test_model`/`get_kernel_result` to return per-named-shape metrics (bounding box, volume, face count) rather than only assembly-level stats. This enables the agent to verify individual components against their specification | P0       | Medium | Critical — enables quantitative component verification |
| R8  | **Add specification file tool** — create a structured `spec.json` tool that the agent can write and read, containing: component tree, dimensions with units, interface contracts, completion status per component. This persists design intent across context compaction         | P1       | Medium | High — solves design intent persistence                |
| R9  | **Add reference image comparison** — expose a tool that overlays or side-by-side compares the current render against a reference image, returning a structured assessment of similarity per region                                                                               | P2       | High   | High — enables closed-loop visual refinement           |
| R10 | **Add engineering knowledge RAG** — build a retrieval-augmented knowledge base of common engineering components (turbopump anatomy, nozzle contour equations, standard flange dimensions, bolt patterns) that the agent can query during specification decomposition             | P2       | High   | Medium — domain knowledge fills the expertise gap      |

### Agentic Architecture Changes

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                   | Priority    | Effort   | Impact                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------- | ---------------------------------------------------------- | --- | --- | --------------------------------------------- |
| R11 | **Implement dual-loop correction** — add an inner loop (compile-fix, up to 3 retries) and outer loop (geometric verification against specification, up to 5 iterations) modeled on CADSmith. The outer loop combines `test_model` metrics with structured visual assessment                                                                                                              | P0          | Medium   | Critical — transforms single-pass to iterative             |
| R12 | **Add independent verification pass** — after the agent completes a complex task, run a verification pass with a modified prompt (adversarial stance, rationalization-inoculation directives that preemptively block "looks correct" / "tests already pass" / "probably fine" avoidance tactics) that evaluates the output against the specification without the ability to modify files | P1          | Medium   | High — eliminates self-confirmation bias                   |
| R13 | **Add component status tracking** — maintain a structured record (in-context or file-based) of each component's status: {name, status: planned                                                                                                                                                                                                                                           | implemented | verified | refined, spec_dimensions, actual_dimensions, deficiencies} | P1  | Low | High — prevents losing track in long sessions |
| R14 | **Implement coordinator mode for assemblies** — for tasks with >5 components, switch to a coordinator architecture with the four-phase ownership split (Research → Synthesis → Implementation → Verification): decompose into component-level sub-tasks, synthesize specifications at the orchestration layer, delegate implementation, verify independently                             | P2          | High     | High — enables parallel work and specialized verification  |

### Context Engineering Changes

| #   | Action                                                                                                                                                                                                                                                                              | Priority | Effort | Impact                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------ |
| R15 | **Add specification-to-context injection** — when a `spec.json` exists, inject it into the system prompt as `<design_specification>`, ensuring the agent always has access to the full specification even after context compaction                                                  | P1       | Low    | High — specification survives compaction               |
| R16 | **Add progressive complexity disclosure** — for complex tasks, inject engineering best practices progressively: first the decomposition template, then per-component construction patterns, then assembly integration instructions. Avoid dumping all engineering knowledge at once | P1       | Medium | Medium — prevents context overload                     |
| R17 | **Add kernel-specific complex task examples** — for each kernel, add a canonical example of a complex multi-component assembly (not just a single part) showing proper decomposition, constraint propagation, interface management, and iterative refinement                        | P2       | Medium | Medium — demonstrates the expected workflow by example |

## References

- **CADSmith**: Barkley, Loghmani, Farimani. "CADSmith: Multi-Agent CAD Generation with Programmatic Geometric Validation." CMU, 2026. arXiv:2603.26512
- **ProCAD**: "Clarify Before You Draw: Proactive Agents for Robust Text-to-CAD Generation." arXiv:2602.03045
- **FutureCAD**: "Towards High-Fidelity CAD Generation via LLM-Driven Program Generation and Text-Based B-Rep Primitive Grounding." arXiv:2603.11831
- **Leo AI Assemblies**: engineering.com — "Leo AI can now generate full CAD assemblies"
- **Design Intent Alignment**: Autodesk Research — "Aligning Constraint Generation with Design Intent in Parametric CAD"
- **Inner/Outer Loop**: philschmid.de — "Agents: Inner Loop vs Outer Loop"
- Tau: `apps/api/app/api/chat/prompts/cad-agent.prompt.ts`, `apps/api/app/api/tools/tools/`, `packages/testing/`
- Policy: `docs/policy/context-engineering-policy.md`
