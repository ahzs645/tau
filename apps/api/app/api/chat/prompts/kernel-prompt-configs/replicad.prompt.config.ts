import type { KernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.types.js';

/**
 * Creates Replicad kernel configuration.
 * Optimized per context-engineering.mdc: terse, canonical example demonstrates behavior.
 *
 * @param replicadTypes - The Replicad TypeScript type definitions for API reference
 * @param canonicalExample - The comprehensive example demonstrating the full API surface
 */
export function createReplicadConfig(replicadTypes: string, canonicalExample: string): KernelConfig {
  return {
    fileExtension: '.ts',
    languageName: 'Replicad',

    codeStandards: `Output plain JavaScript (no TypeScript annotations). Use camelCase for variables. Export \`defaultParams\` object and default \`main(params)\` function returning geometry.

<replicad_api>
${replicadTypes}
</replicad_api>`,

    commonErrorPatterns:
      'invalid dimensions, self-intersecting geometry, unclosed sketches, failed boolean operations on coincident surfaces',

    fileLayoutMode: 'full-nesting',
    canonicalExample,
  };
}
