---
title: 'Visual Verification Prompt Engineering'
description: 'Research into LLM vision model limitations for CAD visual inspection, and prompt engineering strategies to improve defect detection during screenshot-based verification.'
status: draft
created: '2026-03-19'
updated: '2026-03-19'
category: investigation
related:
  - docs/policy/context-engineering-policy.md
---

# Visual Verification Prompt Engineering

Investigation into why the CAD agent fails to detect visual defects in generated 3D models during screenshot-based verification, and research-backed strategies to improve critical visual analysis.

## Executive Summary

The CAD agent's screenshot verification step consistently fails to identify visual defects in generated geometry. In a representative case, a vase model had a clearly visible surface discontinuity (a "belt line" ledge at the widest point), yet the agent described the model as "beautiful" and "gorgeous," interpreting the defect as a decorative feature. The agent only acknowledged the problem when the user explicitly zoomed in and asked about it. Root causes include: (1) no critical inspection guidance in the system prompt, (2) well-documented VLM sycophancy/confirmation bias when evaluating self-generated outputs, and (3) absence of structured visual checklists. Research from Anthropic, academic VLM studies, and manufacturing QA applications suggests concrete mitigations.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [References](#references)

## Problem Statement

The CAD agent workflow includes a screenshot verification step:

```
6. Screenshot: After tests pass, use screenshot to verify the model visually
```

This step is intended to catch visual issues that automated measurement tests cannot detect—surface quality, aesthetic proportions, curve continuity, unintended geometric artifacts. In practice, the agent treats this step as confirmation rather than inspection.

### Observed Failure

**Scenario**: User asked the agent to create a "beautiful, mathematically inspired vase." The agent:

1. Created the model, iterating through several geometry errors
2. Added a 6mm straight `yLine` segment at the belly to prevent arc bulging—a functional workaround that introduced a visible ledge/shelf
3. All 7 measurement tests passed (dimensions, watertightness, connected components)
4. Took multi-angle screenshots
5. Described the result: "The vase looks beautiful!" and "looks gorgeous — a classic amphora silhouette with smooth flowing curves"
6. Interpreted the visible belt line as: "nice pottery-like quality with visible turning marks"
7. Only acknowledged the defect when the user pointed it out with a zoomed image

### Categories of Visual Defects Missed

| Category              | Description                                                 | Example                                             |
| --------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| Surface discontinuity | C0 but not C1 continuous junctions                          | Belt line ledge between tangential arc segments     |
| Tangent breaks        | Visible creases where curve segments meet                   | Arc-to-arc transitions without curvature continuity |
| Proportion anomalies  | Geometry that looks wrong despite passing dimensional tests | Belly too spherical relative to neck                |
| Artifacts             | Unintended geometry from workarounds                        | Straight line segments where curves were expected   |
| Self-intersection     | Surface folding or overlap                                  | Tangential arcs bulging past intended bounds        |

## Methodology

1. **Transcript analysis**: Reviewed the full CAD agent conversation transcript to trace the agent's visual reasoning at each screenshot step
2. **Image evidence**: Examined the user-provided screenshots showing the defect (overview, zoomed belt line, full silhouette, and post-acknowledgment views)
3. **Prompt audit**: Analyzed the current system prompt (`cad-agent.prompt.ts`) and screenshot tool description against context-engineering-policy.md
4. **Literature review**: Surveyed 15+ sources on VLM visual inspection, sycophancy mitigation, manufacturing QA with vision models, and Anthropic's vision best practices
5. **Architecture review**: Traced the screenshot pipeline from capture through image injection to LLM consumption

## Findings

### Finding 1: Zero Visual Inspection Guidance in System Prompt

The current workflow step is purely procedural:

```
6. Screenshot: After tests pass, use screenshot to verify the model visually
```

This tells the agent WHEN to screenshot but not WHAT to look for or HOW to critically analyze the image. Compared to the error handling section (which provides specific behavioral guidance) and the test requirements section (which provides a structured schema), the visual verification step has no comparable structure.

**Evidence**: The agent's screenshot analysis consists entirely of descriptive statements ("smooth curves," "elegant taper," "graceful silhouette") with no systematic evaluation against any quality criteria.

### Finding 2: VLM Sycophancy and Self-Evaluation Bias

Research identifies a well-documented phenomenon where vision-language models exhibit **confirmation bias** when evaluating their own outputs:

- **Agreement bias**: Models show a strong tendency to favor information in their context window and generate reasoning chains to rationalize flawed behavior (Self-Grounded Verification, 2025)
- **Sycophantic modality gap**: Visual sycophancy is significantly more pronounced in MLLMs when processing image inputs compared to text-based evaluation (EMNLP 2025)
- **Asymmetric correction**: Models are more likely to shift from correct to incorrect judgments under self-induced bias than vice versa (arxiv 2602.08311)
- **Reluctance to say no**: LVLMs struggle with fine-grained self-critique in visual reasoning, showing a systematic reluctance to identify problems in outputs they've generated (VISCO benchmark)

In the observed case, the agent generated the CAD model, received passing tests as positive reinforcement, then approached the screenshot with a confirmed-positive disposition. The visible defect was reframed as an intentional feature ("belt line," "pottery banding") rather than recognized as a geometric workaround artifact.

### Finding 3: Composite Image Limitations

The `multi_angle` screenshot mode generates a single composite image with 6 orthographic views (front, back, right, left, top, bottom). While this provides comprehensive coverage, it presents challenges:

- **Resolution dilution**: Six views packed into one image reduce per-view pixel density, making subtle surface defects harder to detect
- **No zoom capability**: The agent cannot examine a specific region more closely—unlike Anthropic's recommended crop tool pattern
- **Fixed viewpoints**: Orthographic projections may not reveal defects visible at oblique angles or in perspective views

**Evidence**: The user needed to provide a zoomed-in image of the belt line before the agent could identify the specific surface discontinuity.

### Finding 4: Missing Critical Inspection Role Assignment

Anthropic's own vision best practices cookbook demonstrates that role assignment significantly improves visual analysis accuracy. Their example shows that adding "You have perfect vision and pay great attention to detail" improved object counting from incorrect to correct results.

The current CAD agent prompt assigns a CAD expert role:

```
You are Tau, a CAD expert for KCL. Create parametric 3D models for manufacturing.
```

This role primes the agent for **creation**, not **critical inspection**. When the agent transitions to the screenshot verification step, it remains in "proud creator" mode rather than switching to "quality inspector" mode.

### Finding 5: No Structured Visual Checklist

Manufacturing quality inspection research consistently shows that structured checklists dramatically improve defect detection rates:

- **QA-VLM** (2025): Enriches VLMs with application-specific quality criteria for surface roughness, contour smoothness, and geometric fidelity assessment
- **Amazon Nova Pro**: Uses structured JSON schemas for defect classification, confidence scoring, and reasoning explanations
- **PLG-DINO**: Combines domain-specific textual prompts with visual regions for fine-grained semantic alignment

The CAD agent has no equivalent. Measurement tests check quantitative properties (dimensions, connectivity, watertightness) but the visual step has zero structured criteria.

### Finding 6: Text Accompanying Screenshots is Non-Directive

When screenshots are injected into the conversation, the only accompanying text is:

```
Captured N screenshot(s)
```

This text provides no analytical framing. Research on VLM prompting consistently shows that the text accompanying an image significantly influences how the model analyzes it.

### Finding 7: Self-Grounded Verification Improves Accuracy

The Self-Grounded Verification (SGV) method addresses agreement bias through a two-step process:

1. **Elicit priors**: Ask the model what a correct output should look like, independent of the actual output
2. **Condition on priors**: Evaluate the actual output against these self-generated criteria

This decouples the "what should I expect?" reasoning from the "does this match?" evaluation, reducing confirmation bias by up to 20 percentage points.

The VISCO benchmark's "LookBack" strategy (revisiting images to verify each piece of information independently) improves critique performance by up to 13.5%.

### Finding 8: Multi-View Spatial Analysis is Underutilized

ViewFusion (2026) demonstrates that structured multi-view reasoning requires explicit spatial pre-alignment—deliberately reasoning about viewpoint relations before answering questions. Current composite screenshots provide the views but no instructions for cross-view analysis (e.g., "Does the silhouette in the front view show the same curvature transitions as the side view?").

## Recommendations

| #   | Action                                                            | Priority | Effort | Impact |
| --- | ----------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Add structured visual inspection checklist to system prompt       | P0       | Low    | High   |
| R2  | Inject critical-inspector role assignment with screenshot results | P0       | Low    | High   |
| R3  | Separate visual critique from creation confirmation               | P1       | Medium | High   |
| R4  | Add directive text to screenshot injection                        | P1       | Low    | Medium |
| R5  | Implement crop/zoom tool for region-of-interest inspection        | P2       | Medium | Medium |
| R6  | Add close-up render capability at curve junctions                 | P2       | High   | High   |
| R7  | Consider separate evaluation pass with adversarial framing        | P3       | Medium | Medium |

### R1: Structured Visual Inspection Checklist

Add a `<visual_inspection>` section to the system prompt that defines specific quality criteria:

```
<visual_inspection>
After taking screenshots, critically examine for:
- Surface continuity: Are all transitions between curve segments smooth? Look for visible ridges, ledges, shelves, or creases where segments meet.
- Silhouette quality: Does the outline flow smoothly without kinks, flat spots, or abrupt direction changes?
- Proportion fidelity: Do the proportions match the design intent? Is any section disproportionately large/small?
- Artifacts: Are there unintended features from geometric workarounds (straight segments where curves were expected, visible construction lines)?
- Symmetry: For revolved/mirrored geometry, is the result symmetric as expected?

If ANY visual issue is found, describe it specifically and fix it before presenting the result.
</visual_inspection>
```

**Context engineering alignment**: This follows the "right altitude" principle—specific heuristics rather than generic guidance ("verify visually") or prescriptive step lists.

### R2: Critical Inspector Role in Screenshot Context

Modify the text injected with screenshot images to include role assignment and analytical framing:

```
Before (current):
  "Captured N screenshot(s)"

After:
  "Captured N screenshot(s). Examine with perfect attention to detail — you are now a quality inspector, not the designer. Look for surface defects, discontinuities, artifacts, and any geometry that doesn't match design intent. Describe any issues found before confirming the model is acceptable."
```

**Research basis**: Anthropic's vision cookbook demonstrates that role assignment ("You have perfect vision and pay great attention to detail") combined with step-by-step analysis in structured tags significantly improves visual accuracy. Manufacturing QA research (QA-VLM, Amazon Nova Pro) confirms that expert framing reduces hallucination in defect detection.

### R3: Decouple Creation and Critique

The current workflow has the same agent context for both creating the model and evaluating it. This maximizes confirmation bias. Two approaches:

**Option A — Prompt-based separation**: Add a "mental mode switch" instruction in the workflow:

```
6. **Inspect**: Switch to quality-inspector mindset. Forget you built this model.
   Take screenshots and evaluate as if reviewing someone else's work.
```

**Option B — Self-grounded verification**: Before viewing screenshots, have the agent list what the model SHOULD look like based on the design intent:

```
Before taking a screenshot, list 3-5 specific visual properties you expect to see
(e.g., "smooth continuous silhouette with no flat spots," "visible curvature at belly
transition"). Then compare screenshots against these expectations.
```

**Research basis**: SGV achieves up to 20-point accuracy gains by eliciting priors before evaluation.

### R4: Directive Text with Screenshot Injection

The `injectScreenshotImages` function in `tool-result-trimmer.middleware.ts` currently prepends only `"Captured N screenshot(s)"`. This should include analytical directives.

### R5: Crop/Zoom Tool

Anthropic's crop tool cookbook demonstrates that giving the model the ability to "zoom in" on regions of interest dramatically improves fine-detail analysis. For CAD models, high-curvature regions (transitions between curve segments) are where defects concentrate.

Implementation approaches:

- **Client-side crop**: Add a `crop_screenshot` tool that takes a bounding box (normalized coordinates) and returns a zoomed region of the latest screenshot
- **Server-side re-render**: Add a `closeup_render` tool that re-renders the 3D scene from a specific viewpoint at higher resolution, focusing on a specified region

### R6: Close-Up Renders at Curve Junctions

For profiles built from multiple curve segments (tangential arcs, bezier curves), automatically identify junction points and render close-up views. This would catch the exact class of defect observed (belt line at arc junctions).

### R7: Adversarial Evaluation Pass

For high-stakes designs, add an optional second evaluation pass with adversarial framing:

```
"Assume this model has at least one visual defect. Find it."
```

Research (VISCO "LookBack" strategy) shows that forcing the model to re-examine with an adversarial assumption improves critique performance by 13.5%.

## Trade-offs

| Approach                    | Pros                                                                  | Cons                                                                        |
| --------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Prompt-only changes (R1-R4) | Zero code changes, immediate deployment, low token cost (~100 tokens) | May not fully overcome deep sycophancy patterns; relies on model compliance |
| Crop tool (R5)              | Proven pattern from Anthropic; model-directed investigation           | Requires new tool implementation; adds latency per crop operation           |
| Close-up renders (R6)       | Most effective for curve-junction defects; automatic                  | Requires render pipeline changes; increases screenshot count                |
| Adversarial pass (R7)       | Strongest bias mitigation; forces critical analysis                   | Doubles screenshot analysis time/cost; may over-flag acceptable geometry    |
| Separate critic agent       | Complete context isolation; eliminates confirmation bias              | Architectural complexity; added latency and cost; coordination overhead     |

**Recommended phasing**: Start with R1+R2+R4 (prompt-only, high impact, zero code changes to screenshot pipeline). Evaluate improvement. Add R5 (crop tool) if fine-detail detection remains insufficient. Reserve R6-R7 for high-fidelity use cases.

## Code Examples

### Current Screenshot Workflow (Ineffective)

```typescript
// cad-agent.prompt.ts — current workflow step
`6. **Screenshot**: After tests pass, use \`${toolName.screenshot}\` to verify the model visually`;

// tool-result-trimmer.middleware.ts — current injection text
content: [{ type: 'text', text: `Captured ${imageBlocks.length} screenshot(s)` }, ...imageBlocks];
```

### Proposed Visual Inspection Section

```typescript
const visualInspection = testingEnabled
  ? `\n\n<visual_inspection>
After screenshots, switch to quality-inspector mindset — examine as if reviewing someone else's work:
- **Surface continuity**: Smooth transitions between segments? No ridges, ledges, or creases at junctions?
- **Silhouette flow**: Outline flows without kinks, flat spots, or abrupt changes?
- **Proportion fidelity**: Proportions match design intent? No section disproportionately large/small?
- **Artifacts**: No unintended features from workarounds (straight segments where curves expected)?
- **Symmetry**: Revolved/mirrored geometry symmetric as expected?

If ANY issue is found, describe it specifically and fix before presenting the result.
</visual_inspection>`
  : '';
```

### Proposed Screenshot Injection Text

```typescript
const inspectionDirective = [
  `Captured ${imageBlocks.length} screenshot(s).`,
  'Examine with perfect attention to detail — you are now a quality inspector, not the designer.',
  'Look for surface defects, discontinuities, ridges, artifacts, and geometry that does not match design intent.',
  'Describe any issues found before confirming the model is acceptable.',
].join(' ');

content: [{ type: 'text', text: inspectionDirective }, ...imageBlocks];
```

### Proposed Self-Grounded Verification Workflow Step

```typescript
const workflowSteps = testingEnabled
  ? `...
5. **Test**: Call \`${toolName.testModel}\` to validate all requirements
6. **Pre-inspect**: Before screenshotting, list 3-5 specific visual properties you expect (smooth silhouette, continuous curves, no flat spots, etc.)
7. **Screenshot**: Use \`${toolName.screenshot}\` and compare against your expectations. Report any deviation.`
  : `...`;
```

## Diagrams

### Current vs Proposed Visual Verification Flow

```
CURRENT:
  Tests pass → Take screenshot → "Looks beautiful!" → Done
                                  ↑ confirmation bias

PROPOSED (R1+R2+R3):
  Tests pass → List expected visual properties (self-grounding)
             → Take screenshot
             → Inspector role: check against checklist
             → Issues found? → Fix and re-verify
             → No issues? → Confirm with specific evidence
```

### Screenshot Pipeline with Proposed Changes

```
  UI Capture
      │
      ▼
  Base64 DataURL
      │
      ▼
  tool-result-trimmer.middleware.ts
      │
      ├─ Latest screenshot: inject images + ★ inspection directive (R2/R4)
      │
      └─ Older screenshots: replace with "[previously captured]"
      │
      ▼
  LLM receives:
    - Inspection directive text (R2)
    - Image blocks
    - System prompt with <visual_inspection> checklist (R1)
    - Workflow with self-grounding step (R3)
```

## References

### Anthropic Documentation

- [Best practices for using vision with Claude](https://platform.claude.com/cookbook/multimodal-best-practices-for-vision) — Role assignment, step-by-step analysis, few-shot examples for vision accuracy
- [Giving Claude a crop tool for better image analysis](https://platform.claude.com/cookbook/multimodal-crop-tool) — Crop tool pattern for fine-detail inspection
- [Vision API documentation](https://docs.anthropic.com/en/docs/build-with-claude/vision) — Image format, resolution, and token cost guidelines

### VLM Sycophancy and Confirmation Bias

- Qu et al. (2025) — [ReCoT: Reflective Self-Correction Training for Mitigating Confirmation Bias in LVLMs](https://openaccess.thecvf.com/content/ICCV2025/papers/Qu_ReCoT_Reflective_Self-Correction_Training_for_Mitigating_Confirmation_Bias_in_Large_ICCV_2025_paper.pdf) — ICCV 2025
- [Towards Analyzing and Mitigating Sycophancy in Large Vision-Language Models](https://paperswithcode.com/paper/towards-analyzing-and-mitigating-sycophancy) — Sycophantic modality gap
- [Let's Think in Two Steps: Self-Grounded Verification](https://self-grounded-verification.github.io/) — SGV method, 20-point accuracy gains
- [VISCO: Benchmarking Fine-Grained Critique and Correction](https://arxiv.org/html/2412.02172v2) — LookBack strategy, 13.5% improvement
- [Sherlock: Self-Correcting Reasoning in VLMs](https://arxiv.org/html/2505.22651v2) — Self-correction training

### Manufacturing Visual QA

- [QA-VLM: Quality Assessment for Additive Manufacturing with VLMs](https://arxiv.org/html/2508.16661v1) — Structured quality criteria
- [Zero-Training Visual Defect Detection with Amazon Nova Pro](https://aws.amazon.com/blogs/industries/implement-zero-training-visual-defect-detection-in-manufacturing-with-amazon-nova-pro/) — Prompt-based defect classification
- [Enhanced Vision-Based Quality Inspection: Multiview Framework](https://pmc.ncbi.nlm.nih.gov/articles/PMC11945225/) — Multi-view defect detection

### CAD-Specific Visual Verification

- [CAD-Judge: Morphological Grading for Text-to-CAD](https://arxiv.org/html/2508.04002v1) — Compiler-as-a-Review module
- [CADCodeVerify: Vision-Language Models for 3D Design Validation](https://arxiv.org/html/2410.05340v1) — Validation questions for generated objects
- [ViewFusion: Structured Spatial Thinking Chains for Multi-View Reasoning](https://arxiv.org/html/2603.06024v1) — Cross-view spatial pre-alignment

### Multi-View Analysis

- [SiM3D: Single-instance Multiview 3D Anomaly Detection](https://arxiv.org/html/2506.21549v2) — Multi-view anomaly detection benchmark
- [Leveraging VLM-Based Pipelines to Annotate 3D Objects](https://arxiv.org/html/2311.17851v2) — Probabilistic aggregation over text summarization

### Related Internal Docs

- Policy: `docs/policy/context-engineering-policy.md`
