---
title: 'LLM Evaluation Best Practices for Agentic CAD'
description: 'Reference guide for LLM benchmarking and evaluation practices, frameworks, and metrics -- informed by CadQueryEval, eval-driven development, and the agentic evaluation landscape as of March 2026'
status: active
created: '2026-03-18'
updated: '2026-03-18'
category: reference
related:
  - apps/api/app/api/models/model.constants.ts
  - docs/research/open-source-model-integration.md
  - packages/runtime/src/benchmarks/benchmark-runner.ts
---

# LLM Evaluation Best Practices for Agentic CAD

Reference guide for benchmarking and evaluating LLM capabilities in the context of agentic code-based CAD, informed by the open-source evaluation landscape as of March 2026.

## Executive Summary

Evaluating agentic AI systems requires fundamentally different approaches than traditional software testing. LLMs are probabilistic -- the same prompt can yield different responses. Agentic systems compound this by making decisions, calling tools, and modifying state across multiple turns. The emerging discipline of eval-driven development treats evaluations as the working specification, not an afterthought. This document catalogs the frameworks, metrics, grading strategies, and CAD-specific approaches that inform Tau's model evaluation system.

## Table of Contents

- [Problem Statement](#problem-statement)
- [The Eigenquestion](#the-eigenquestion)
- [Finding 1: Eval-Driven Development](#finding-1-eval-driven-development)
- [Finding 2: The Three Grader Types](#finding-2-the-three-grader-types)
- [Finding 3: Agent-Specific Evaluation Dimensions](#finding-3-agent-specific-evaluation-dimensions)
- [Finding 4: CAD-Specific Evaluation -- CadQueryEval](#finding-4-cad-specific-evaluation----cadqueryeval)
- [Finding 5: Open-Source Evaluation Frameworks](#finding-5-open-source-evaluation-frameworks)
- [Finding 6: Visualization and Reporting](#finding-6-visualization-and-reporting)
- [Finding 7: Anthropic's Agent Eval Guidance](#finding-7-anthropics-agent-eval-guidance)
- [Recommendations](#recommendations)
- [References](#references)

## Problem Statement

Tau integrates 21+ LLM models across 6 providers. When providers update models, swap model versions, or change API behavior, we have no systematic way to detect quality regressions. The existing `model-integration.test.ts` tests a single model and is permanently skipped. We need a benchmarking and evaluation capability that:

1. Measures model quality across all providers with standardized prompts
2. Detects regressions when models update
3. Compares cost/quality trade-offs across open-source and closed-source models
4. Evolves to validate geometric correctness of generated CAD code

## The Eigenquestion

> **"Given a natural language CAD description, does the model produce geometrically correct, executable code via the correct tool-use pattern, at acceptable cost and latency?"**

This is the one question from which every other question and answer follows. It decomposes into a measurement pyramid where each level depends on the one below it:

| Level | Name                  | What It Measures                             | Metrics                                              |
| ----- | --------------------- | -------------------------------------------- | ---------------------------------------------------- |
| L0    | Connectivity          | Can we reach the model? Does it stream?      | HTTP 200, first token received, no timeout           |
| L1    | Tool-Use Correctness  | Did it call the right tools with valid args? | tool_called, valid_json_args, correct_tool_name      |
| L2    | Code Execution        | Does generated code compile and render?      | No syntax errors, successful `client.render()`       |
| L3    | Geometric Correctness | Does output geometry match specification?    | Bounding box, volume, watertight, Chamfer, Hausdorff |
| L4    | Agentic Capability    | Can it handle multi-step design tasks?       | Multi-turn completion, self-correction, iteration    |

Each level is a prerequisite for the next. A model that cannot call `create_file` (L1) cannot possibly produce correct geometry (L3). Measuring L3 without passing L1 is meaningless noise.

## Methodology

Research conducted via:

- Web search across evaluation framework documentation, academic papers, and industry blogs
- Direct analysis of CadQueryEval source code and benchmark results
- Review of Anthropic, OpenAI, and Braintrust evaluation guidance
- Analysis of the Agentic Benchmark Checklist (UIUC)
- Review of the Eval-Driven Development manifesto (evaldriven.org)
- Comparative analysis of Tau's existing kernel benchmark architecture

## Finding 1: Eval-Driven Development

The [Eval-Driven Development manifesto](https://evaldriven.org/) codifies the emerging best practice for building with LLMs. Its core principles, adapted for Tau:

### Principle 1: Evaluation is the Product

The eval suite is not a phase that follows development. Build evals first. Code is generated. Evals are engineered. For Tau, this means: before adding a new prompt or model, define what "correct" looks like and build the grader.

### Principle 2: Define Correctness Before You Write a Prompt

If you cannot express "correct" as a deterministic function, you are not ready to build. For CAD: "correct" means the generated code compiles, renders geometry, and that geometry matches a reference within defined tolerances.

### Principle 3: Probabilistic Systems Require Statistical Proof

A single passing test proves nothing about a stochastic system. Rigorous evaluation requires:

- Multiple runs per model (3-5 minimum) to account for sampling variance
- Confidence intervals on scores
- Regression baselines with statistical significance thresholds
- Distribution tracking, not anecdotal pass/fail

### Principle 4: Cost is a Metric

Token spend, latency, and compute are evaluation dimensions. A model that produces correct geometry but costs $6.14 per eval (as o1 does in CadQueryEval) may be commercially unviable compared to one that costs $0.04 (Gemini 2.0 Flash) at acceptable quality.

### Principle 5: Version Evals Like Code

Eval definitions, datasets, thresholds, and results live in version control. When the eval changes, the reason is documented. Results are serialized to JSON for comparison across runs.

## Finding 2: The Three Grader Types

Effective evaluation uses three complementary grader types, each with different trade-offs:

| Grader Type                    | Speed   | Cost | When to Use                                                                   |
| ------------------------------ | ------- | ---- | ----------------------------------------------------------------------------- |
| **Code-based**                 | Fast    | Free | Deterministic checks: file exists, JSON parses, imports present, syntax valid |
| **Model-based** (LLM-as-judge) | Slow    | $$$  | Nuanced quality: code readability, design intent, parameter naming            |
| **Human**                      | Slowest | $$$$ | Gold standard calibration, edge cases, subjective quality                     |

For Tau's Phase 1 (L0 + L1), code-based graders are sufficient and appropriate:

```typescript
function gradeSmokeCube(outcome: ModelRunOutcome): GraderResult {
  const checks: GraderCheck[] = [];

  const toolCalled = outcome.toolCalls.some((tc) => tc.name === 'create_file');
  checks.push({ name: 'tool_called', passed: toolCalled });

  const fileCreated = 'main.ts' in outcome.filesCreated;
  checks.push({ name: 'file_created', passed: fileCreated });

  if (fileCreated) {
    const code = outcome.filesCreated['main.ts'];
    const hasImport = code.includes('replicad');
    checks.push({ name: 'has_replicad_import', passed: hasImport });

    const hasExport = code.includes('export default') || code.includes('export function');
    checks.push({ name: 'has_default_export', passed: hasExport });
  }

  const passedChecks = checks.filter((c) => c.passed).length;
  const score = checks.length > 0 ? passedChecks / checks.length : 0;
  return { score, passed: score >= 0.8, checks };
}
```

For Phase 2 (L2 + L3), code-based graders remain primary but with geometry comparison:

```typescript
function gradeGeometry(rendered: RenderResult, reference: ReferenceMesh): GraderResult {
  const checks: GraderCheck[] = [];

  checks.push({ name: 'renders_successfully', passed: rendered.success });
  checks.push({ name: 'watertight', passed: rendered.mesh.isWatertight() });
  checks.push({
    name: 'bounding_box',
    passed: boundingBoxWithinTolerance(rendered.mesh, reference, 1.0),
  });
  checks.push({
    name: 'volume',
    passed: volumeWithinThreshold(rendered.mesh, reference, 0.02),
  });

  const chamfer = chamferDistance(rendered.mesh, reference);
  checks.push({
    name: 'chamfer_distance',
    passed: chamfer <= 1.0,
    detail: `${chamfer.toFixed(3)}mm`,
  });

  // ...
}
```

## Finding 3: Agent-Specific Evaluation Dimensions

AI agents introduce evaluation complexity beyond simple prompt-response testing. The [Agentic Benchmark Checklist](https://uiuc-kang-lab.github.io/agentic-benchmarks/) (UIUC) identifies two core validity requirements:

### Outcome Validity

Evaluation methods should correctly indicate task completion. For Tau: if the grader says the model produced a correct cube, opening the result in the CAD viewer should show a cube. False positives are dangerous -- they erode trust in the eval system.

### Task Validity

Tasks should be solvable if and only if agents possess target capabilities. For Tau: if a task requires `create_file`, the tool must be available. If a task requires Replicad knowledge, the system prompt must include it.

### The Six Evaluation Dimensions

Research across multiple sources converges on six dimensions for agentic evaluation:

| Dimension                   | What to Measure                               | Tau Example                                 |
| --------------------------- | --------------------------------------------- | ------------------------------------------- |
| **Task Completion**         | Did the agent accomplish the goal?            | File created with valid CAD code            |
| **Tool Selection Accuracy** | Did it call the right tools with valid args?  | `create_file` called, not `read_file`       |
| **Process Quality**         | Was the reasoning/planning sound?             | Efficient tool sequence, no redundant calls |
| **Outcome Quality**         | Is the output correct and useful?             | Geometry matches specification              |
| **Efficiency**              | Time, tokens, cost to complete                | Latency, input/output tokens, $/request     |
| **Safety**                  | No harmful outputs, PII, or policy violations | No code injection, no file system escapes   |

### Four-Way Status Semantics

Distinguishing _why_ a model failed is as important as knowing _that_ it failed:

- **passed** -- grader score >= threshold (the model works for this task)
- **failed** -- model responded but grader score < threshold (the model is broken for this task)
- **skipped** -- API key missing or model explicitly excluded (we cannot test this model)
- **error** -- infrastructure failure: timeout, HTTP 500, rate limit (the provider is broken)

A model that 500s is fundamentally different from a model that produces bad code. The report must distinguish these to avoid misattributing provider outages as model quality issues.

## Finding 4: CAD-Specific Evaluation -- CadQueryEval

[CadQueryEval](https://danwahl.net/cadqueryeval/) is the most directly relevant prior art. It evaluates LLM ability to generate CadQuery (Python) code for 3D CAD modeling by comparing output geometry against reference STL files.

### Architecture

Built on [Inspect AI](https://inspect.ai-safety-institute.org.uk/) (UK AI Safety Institute):

- **Tasks**: 25 YAML-defined CAD modeling tasks, from 2-operation primitives to 8+ operation assemblies
- **Sandbox**: Docker container with CadQuery, Trimesh, Open3D, Python 3.12
- **Scorer**: Multi-metric geometry comparison against reference STLs
- **Viewer**: Inspect View web UI for browsing results

### Scoring Metrics

| Metric           | Type       | Threshold | Description                             |
| ---------------- | ---------- | --------- | --------------------------------------- |
| Watertight       | Binary     | --        | Mesh is manifold (no open edges)        |
| Single Component | Binary     | --        | Expected number of connected components |
| Bounding Box     | Binary     | 1.0mm     | Dimensions match within tolerance       |
| Volume           | Binary     | 2.0%      | Volume within percentage threshold      |
| Chamfer Distance | Continuous | 1.0mm     | Average point cloud distance            |
| Hausdorff 95p    | Continuous | 1.0mm     | 95th percentile max deviation           |

A task passes only if all binary checks succeed.

### Key Results (February 2026)

Top performers on 25 CadQuery generation tasks:

| Model                  | Accuracy | Cost  | Notable                    |
| ---------------------- | -------- | ----- | -------------------------- |
| Gemini 3.1 Pro Preview | 0.80     | $2.02 | Best overall accuracy      |
| Claude Opus 4.6        | 0.60     | $0.44 | Strong quality/cost ratio  |
| GPT-5 Mini             | 0.52     | $0.16 | Budget leader              |
| DeepSeek V3.2          | 0.24     | $0.01 | Cheapest, but low accuracy |

### Applicability to Tau

CadQueryEval validates CadQuery (Python). Tau uses Replicad (TypeScript). The evaluation architecture transfers directly:

1. Replace CadQuery Docker sandbox with `@taucad/runtime` + `createRuntimeClient`
2. Replace STL export with glTF export from the runtime
3. Reuse the same geometric metrics (Chamfer, Hausdorff, bounding box, volume)
4. Replace YAML task definitions with TypeScript `ModelBenchmarkCase` objects
5. Replace Inspect View with custom self-contained HTML reports (matching kernel benchmark pattern)

This is Tau's Phase 2 evaluation roadmap.

## Finding 5: Open-Source Evaluation Frameworks

The evaluation tooling landscape as of March 2026, ranked by relevance to Tau:

### Tier 1: Most Relevant

| Framework                | Stars | Language    | Strengths                                                                                               | Tau Fit                                                        |
| ------------------------ | ----- | ----------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Promptfoo**            | 17.2k | TypeScript  | YAML configs, tool-call assertions (`is-valid-openai-tools-call`, `tool-call-f1`), web UI, CI/CD native | High -- same language, declarative evals, tool-call validation |
| **Braintrust Autoevals** | --    | TS + Python | Open-source scoring library, LLM-as-judge, heuristic methods, CI experiment tracking                    | High -- scoring primitives we can import directly              |
| **Inspect AI**           | --    | Python      | UK AISI framework, sandboxed execution, built-in agents, 100+ pre-built evals, CadQueryEval built on it | Medium -- Python-based but proven for CAD eval                 |

### Tier 2: Useful Reference

| Framework        | Stars | Language | Strengths                                              | Tau Fit                                      |
| ---------------- | ----- | -------- | ------------------------------------------------------ | -------------------------------------------- |
| **DeepEval**     | 14.1k | Python   | pytest-like syntax, agentic/RAG metrics, LLM-as-judge  | Low -- Python, but good metric catalog       |
| **OpenAI Evals** | 18k   | Python   | Largest community, comprehensive registry              | Low -- Python, OpenAI-centric                |
| **OpenBench**    | 747   | Python   | 95+ benchmarks, provider-agnostic, built on Inspect AI | Low -- academic benchmarks, not custom evals |
| **Lighteval**    | 2.3k  | Python   | HuggingFace, 1000+ eval tasks                          | Low -- model eval, not agent eval            |

### Promptfoo Deep Dive

Promptfoo is the strongest candidate for future integration (Phase 3). Key capabilities:

- **Declarative YAML test cases**: prompts, expected outputs, and assertions in config files
- **Tool-call assertions**: `is-valid-openai-tools-call` validates schema compliance, `tool-call-f1` scores actual vs expected tool calls
- **Side-by-side comparison**: web UI for browsing results across models
- **CI/CD integration**: runs in pipelines, caches results, supports concurrency
- **Provider-agnostic**: supports OpenAI, Anthropic, Google, custom providers
- **100% local**: no cloud dependency, MIT license

```yaml
# Example promptfoo config for CAD tool-use evaluation
prompts:
  - 'Create a 20mm cube in main.ts using Replicad'

providers:
  - id: openai:gpt-5.4
  - id: anthropic:claude-sonnet-4.6

tests:
  - assert:
      - type: is-valid-openai-tools-call
      - type: javascript
        value: "output.includes('create_file')"
      - type: cost
        threshold: 0.50
      - type: latency
        threshold: 10000
```

## Finding 6: Visualization and Reporting

Research into existing visualization tools:

| Tool                                | Status   | Approach                          | Verdict                                        |
| ----------------------------------- | -------- | --------------------------------- | ---------------------------------------------- |
| **LLM Comparator** (Google PAIR)    | Archived | Side-by-side response comparison  | Dead project, not viable                       |
| **LLM Compare**                     | Active   | Static JSON, color-coded bars     | Too simple for our needs                       |
| **Promptfoo Web UI**                | Active   | Full evaluation browser           | Excellent but requires full promptfoo adoption |
| **Inspect View**                    | Active   | Evaluation trace browser          | Python-based, doesn't fit our toolchain        |
| **Custom HTML** (kernel benchmarks) | In-house | Self-contained, inline SVG charts | Best fit for consistency and control           |

**Decision: Build custom.** The kernel benchmark HTML report pattern is proven, zero-dependency, and consistent with existing infrastructure. CadQueryEval's per-metric pass rate tables provide an excellent template for the per-check heatmap.

Key report elements (informed by CadQueryEval's detailed tables):

- **Per-model row**: model, provider, status badge, score (0.0-1.0), duration, TTFT, tokens, cost
- **Per-check columns**: checkmark/cross for each grader check (tool_called, file_created, has_import, has_export)
- **Score heatmap**: models x checks matrix (like CadQueryEval's per-task difficulty table)
- **Comparison mode**: delta columns with IMPROVED/REGRESSED/STABLE labels
- **Cost-efficiency scatter**: accuracy vs cost visualization

## Finding 7: Anthropic's Agent Eval Guidance

[Anthropic's "Demystifying Evals for AI Agents"](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) distills practical guidance from their experience:

### Start Small

20-50 tasks drawn from real failures and bug trackers. Early changes have large effect sizes, so small sample sizes suffice. For Tau: start with 5-8 smoke test prompts covering primitives (cube, cylinder, sphere) and basic tool-use patterns.

### Grade Outcomes, Not Paths

Check what agents produced, not the specific tool sequences they used. Agents regularly find valid approaches that designers did not anticipate. Include partial credit for partial solutions.

For Tau: do not assert that the model called `create_file` in exactly one step. Assert that after the conversation, `main.ts` exists and contains valid Replicad code. The model may use multiple tool calls, or it may include the code in a single call.

### Use Three Grader Types Strategically

| Type        | Use For                               | Example                                    |
| ----------- | ------------------------------------- | ------------------------------------------ |
| Code-based  | Fast, cheap, reproducible unit checks | File exists, JSON parses, import present   |
| Model-based | Nuanced quality requiring judgment    | "Is this parametric code well-structured?" |
| Human       | Gold standard calibration             | Periodic review of LLM-judge accuracy      |

### Evals Must Evolve

LLMs progressed from 40% to over 80% on SWE-bench Verified in one year. Evals that are too easy stop providing signal. Plan for increasing difficulty: start with smoke tests (L0-L1), graduate to geometry validation (L2-L3), then agentic multi-step tasks (L4).

### Failure Categorization

Categorize agent failures into three tiers to guide debugging:

| Tier | Name          | Cause                             | Tau Example                                  |
| ---- | ------------- | --------------------------------- | -------------------------------------------- |
| 1    | Specification | Agent misunderstands the task     | Model generates Python instead of TypeScript |
| 2    | Execution     | Tools fail or wrong tool selected | `create_file` called but with invalid path   |
| 3    | Verification  | Task completes but output is poor | Code renders but geometry is wrong shape     |

## Recommendations

| #   | Action                                                                                                                  | Priority | Effort | Impact                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ---------------------------------------------------------- |
| R1  | Build Phase 1 benchmark (L0 + L1) with graded outcomes, custom HTML reports, and comparison mode                        | P0       | Medium | High -- immediate regression detection                     |
| R2  | Add Phase 2 geometry validation (L2 + L3) using `@taucad/runtime` to render and compare against reference meshes        | P1       | High   | Critical -- validates actual CAD output quality            |
| R3  | Evaluate promptfoo integration for declarative YAML eval configs and web UI                                             | P2       | Medium | Medium -- better DX for adding eval cases                  |
| R4  | Add statistical rigor: multiple runs per model, confidence intervals, significance thresholds                           | P2       | Low    | Medium -- reduces false regressions from sampling variance |
| R5  | Build a curated eval dataset of 25+ Replicad tasks (mirroring CadQueryEval's 25-task structure) with reference geometry | P1       | High   | Critical -- the dataset is the product                     |
| R6  | Implement per-task difficulty tracking to identify which CAD operations are hardest for models                          | P2       | Low    | Medium -- guides prompt engineering and model selection    |
| R7  | Track eval results over time in version control (JSON reports) for longitudinal regression analysis                     | P1       | Low    | High -- enables "was this model better last month?"        |

## References

- [Eval-Driven Development](https://evaldriven.org/) -- Manifesto for evaluation-first AI development
- [CadQueryEval](https://danwahl.net/cadqueryeval/) -- Inspect AI evaluation for CadQuery code generation with geometric scoring
- [CadEval](https://github.com/wgpatrick/cadeval) -- Original CAD evaluation benchmark (OpenSCAD)
- [Anthropic: Demystifying Evals for AI Agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) -- Practical agent evaluation guidance
- [Agentic Benchmark Checklist](https://uiuc-kang-lab.github.io/agentic-benchmarks/) -- Outcome validity and task validity best practices
- [Promptfoo](https://www.promptfoo.dev/) -- TypeScript-native LLM evaluation framework (17k stars)
- [Braintrust Autoevals](https://github.com/braintrustdata/autoevals) -- Open-source scoring library for LLM outputs
- [Inspect AI](https://inspect.ai-safety-institute.org.uk/) -- UK AI Safety Institute evaluation framework
- [DeepEval](https://github.com/confident-ai/deepeval) -- Python evaluation framework with agentic metrics
- [OpenAI Evaluation Best Practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) -- Official guidance on designing evals
- [AI Evaluation Guide 2026](https://orchestrator.dev/blog/2026-02-18-ai-evaluation-guide-2026) -- Comprehensive guide to evaluation tools and techniques
- [ArtifactsBench](https://arxiv.org/html/2507.04952v2) -- Multimodal evaluation for visual code generation
- [Gen3DEval](https://openaccess.thecvf.com/content/CVPR2025/papers/Maiti_Gen3DEval_Using_vLLMs_for_Automatic_Evaluation_of_Generated_3D_Objects_CVPR_2025_paper.pdf) -- Vision LLM-based evaluation for 3D object quality
- Tau kernel benchmarks: `packages/runtime/src/benchmarks/` -- Internal reference architecture for benchmark runner/suite/report separation
