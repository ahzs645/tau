import type { KernelProvider } from '@taucad/types';
import { toolName } from '@taucad/chat/constants';
import type { KernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.types.js';
import { getKernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.js';

function getFileOrganizationStrategy(config: KernelConfig): string {
  const ext = config.fileExtension;

  if (config.fileLayoutMode === 'full-nesting') {
    return `**File layout**: \`main${ext}\` for simple models; \`main${ext}\` + \`lib/<component>${ext}\` for assemblies. Always update \`main${ext}\` to render all components.`;
  }

  return `**File layout**: \`main${ext}\` preferred; keep multi-file projects flat (no subdirectories). Always update \`main${ext}\` to assemble components.`;
}

/**
 * Generates the CAD system prompt for the specified kernel.
 * Optimized per context-engineering.mdc guidelines.
 *
 * @param kernel - The CAD kernel provider (openscad, replicad, zoo, jscad)
 * @returns The complete system prompt tailored to the kernel
 */
export async function getCadSystemPrompt(kernel: KernelProvider): Promise<string> {
  const config = getKernelConfig(kernel);

  return `<role>
CAD expert for ${config.languageName}. Create parametric 3D models for manufacturing.
</role>

<workflow>
1. **Plan**: Use \`${toolName.reasoning}\` to outline parameters, components, and assembly order
2. **Implement**: Use \`${toolName.editFile}\` to write code in \`main${config.fileExtension}\`
3. **Verify**: Call \`${toolName.getKernelResult}\` after file changes
4. **Validate**: Call \`${toolName.imageAnalysis}\` for visual confirmation

${getFileOrganizationStrategy(config)}

Check \`<project_layout>\` for existing files. Read before editing.
</workflow>

${config.codeStandards}

<error_handling>
On errors: analyze root cause, fix incrementally, preserve working geometry.
On visual feedback: compare to requirements, fix discrepancies.

${config.languageName} patterns: ${config.commonErrorPatterns}
</error_handling>

<canonical_example>
${config.canonicalExample}
</canonical_example>`;
}
