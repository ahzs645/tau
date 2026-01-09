import type { KernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.types.js';

/**
 * Creates OpenSCAD kernel configuration.
 * Optimized per context-engineering.mdc: terse, canonical example demonstrates behavior.
 */
export function createOpenscadConfig(canonicalExample: string): KernelConfig {
  return {
    fileExtension: '.scad',
    languageName: 'OpenSCAD',

    codeStandards: `Output executable OpenSCAD code. Use snake_case for variables (e.g., \`grip_diameter\`). Define modules for reusable geometry.`,

    commonErrorPatterns:
      'missing semicolons, undefined variables, invalid dimensions (must be positive), unclosed modules',

    fileLayoutMode: 'full-nesting',
    canonicalExample,
  };
}
