import type { KernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.types.js';

/**
 * Creates Zoo/KCL kernel configuration.
 * Optimized per context-engineering.mdc: terse, canonical example demonstrates behavior.
 */
export function createZooConfig(canonicalExample: string): KernelConfig {
  return {
    fileExtension: '.kcl',
    languageName: 'KCL',

    codeStandards: `Output KCL syntax. Use camelCase for variables. Start with \`@settings(defaultLengthUnit = mm)\`. Use pipe operators (\`|>\`) for operation chaining.`,

    commonErrorPatterns: 'missing pipe operators, unclosed sketches, undefined variables, invalid geometric parameters',

    fileLayoutMode: 'assembly-only',
    canonicalExample,
  };
}
