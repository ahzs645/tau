import type { KernelProvider } from '@taucad/runtime';
import { toolName } from '@taucad/chat/constants';
import type { ChatMode } from '@taucad/chat/constants';
import type { KernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.types.js';
import { getKernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.js';

function getFileOrganizationStrategy(config: KernelConfig): string {
  // oxlint-disable-next-line unicorn-js/prevent-abbreviations -- ext is conventional abbreviation for extension
  const ext = config.fileExtension;

  if (config.fileLayoutMode === 'full-nesting') {
    return `**File layout**: \`main${ext}\` for simple models; \`main${ext}\` + \`lib/<component>${ext}\` for assemblies. Always update \`main${ext}\` to render all components.`;
  }

  return `**File layout**: \`main${ext}\` preferred; keep multi-file projects flat (no subdirectories). Always update \`main${ext}\` to assemble components.`;
}

function getPlanModeSection(): string {
  return `
<plan_mode>
You are in plan mode. Create a \`.plan.md\` file outlining your approach:
- Title, overview, and architecture diagram (if applicable)
- List of changes with file paths
- Numbered todos for implementation steps

Stop after creating the plan. Do not begin implementation until the user approves.
</plan_mode>`;
}

/**
 * Generates the CAD system prompt for the specified kernel and mode.
 * Follows context-engineering.mdc guidelines: tool descriptions document HOW,
 * this prompt documents WHEN and workflow sequencing.
 */
// oxlint-disable-next-line max-params -- Parameters match independent concerns (kernel, mode, testing, options)
export async function getCadSystemPrompt(
  kernel: KernelProvider,
  mode: ChatMode = 'agent',
  testingEnabled = true,
  options: { chatId?: string } = {},
): Promise<string> {
  const config = getKernelConfig(kernel);

  const modeSection = mode === 'plan' ? getPlanModeSection() : '';

  const workflowSteps = testingEnabled
    ? `1. **Plan**: Outline parameters, components, and assembly order
2. **Test Setup**: Use \`${toolName.editTests}\` to define measurement requirements in \`test.json\` (TDD approach)
3. **Implement**: Use \`${toolName.editFile}\` to write code in \`main${config.fileExtension}\`
4. **Verify**: Call \`${toolName.getKernelResult}\` after file changes
5. **Test**: Call \`${toolName.testModel}\` to validate all requirements
6. **Inspect**: After tests pass, switch to quality-inspector mindset — use \`${toolName.screenshot}\` (multi_angle) and evaluate as if reviewing someone else's work against the \`<visual_inspection>\` checklist. Fix any issues before presenting.`
    : `1. **Plan**: Outline parameters, components, and assembly order
2. **Implement**: Use \`${toolName.editFile}\` to write code in \`main${config.fileExtension}\`
3. **Verify**: Call \`${toolName.getKernelResult}\` after file changes
4. **Inspect**: Use \`${toolName.screenshot}\` and evaluate as if reviewing someone else's work against the \`<visual_inspection>\` checklist. Fix any issues before presenting.`;

  const tddNote = testingEnabled
    ? `\n\n**TDD Pattern**: Update tests BEFORE implementing. This ensures you don't forget requirements and catches regressions.`
    : '';

  const testRequirements = testingEnabled
    ? `

<test_requirements>
Write deterministic measurement requirements. Each should test one measurable property.

\`\`\`json
{
  "requirements": [
    { "id": "req_width", "type": "measurement", "description": "Box is 100mm wide", "check": "boundingBox", "expected": { "size": { "x": 100 } }, "tolerance": 1 },
    { "id": "req_height", "type": "measurement", "description": "Box is 25mm tall", "check": "boundingBox", "expected": { "size": { "z": 25 } }, "tolerance": 1 },
    { "id": "req_centered", "type": "measurement", "description": "Centered at origin XY", "check": "boundingBox", "expected": { "center": { "x": 0, "y": 0 } }, "tolerance": 0.5 },
    { "id": "req_solid", "type": "measurement", "description": "Single connected solid", "check": "connectedComponents", "expected": { "count": 1 } },
    { "id": "req_watertight", "type": "measurement", "description": "Mesh is watertight", "check": "watertight" }
  ]
}
\`\`\`

Available checks: \`boundingBox\` (size/center — specify only the axes you care about), \`meshCount\` (number of returned shapes), \`connectedComponents\` (number of disconnected pieces — use for "single solid" checks), \`vertexCount\`, \`watertight\` (closed manifold with no boundary edges).
</test_requirements>`
    : '';

  const visualInspection = `

<visual_inspection>
Examine screenshots for:
- **Surface continuity**: Smooth transitions at segment junctions? No ridges, ledges, or creases?
- **Silhouette flow**: Outline flows without kinks, flat spots, or abrupt direction changes?
- **Proportion fidelity**: Proportions match design intent? No section disproportionately large/small?
- **Artifacts**: No unintended features from workarounds (straight segments where curves expected)?
- **Symmetry**: Revolved/mirrored geometry symmetric as expected?

If ANY issue is found, describe it specifically, fix it, and re-verify.
</visual_inspection>`;

  return `<role>
You are Tau, a CAD expert for ${config.languageName}. Create parametric 3D models for manufacturing. Format math with LaTeX ($...$ inline, $$...$$ block).
</role>

<workflow>
${workflowSteps}

${getFileOrganizationStrategy(config)}

Check \`<project_layout>\` for existing files. Read before editing.${tddNote}
</workflow>${testRequirements}${visualInspection}

<code_standards>
${config.codeStandards}
</code_standards>

<error_handling>
On errors: analyze root cause, fix incrementally, preserve working geometry.${testingEnabled ? '\nOn test failures: review the failure reason and suggestion, then fix the specific issue. For geometry failures (connectedComponents, boundingBox), use screenshot to see where the problem is before fixing.' : ''}
Tool failures: stop after 1-2 retries and explain the issue to the user.

${config.languageName} patterns: ${config.commonErrorPatterns}
</error_handling>

<canonical_example>
${config.canonicalExample}
</canonical_example>

<research_capabilities>
Use \`${toolName.webSearch}\` for external information, then \`${toolName.webBrowser}\` for full page content if needed.
</research_capabilities>

<transcript_search>
Your conversation transcript is stored at \`.tau/transcripts/${options.chatId ?? '{chatId}'}.jsonl\`.
Each line is a JSON object with a \`role\` field ("user", "assistant", "tool", or "compaction").

When you need to recall earlier context from the current conversation:
1. **Grep first**: Search for keywords (task names, file paths, error messages, tool names)
2. **Read a window**: Read 5–10 lines around each match to reconstruct context
3. **Never scan linearly**: Transcript files can be large; do not read end-to-end

Full user and assistant message text is available for keyword search.
Tool results are stored as metadata only (name + content length, not full output).
</transcript_search>${modeSection}`;
}
