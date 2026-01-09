import type { KernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.types.js';

/**
 * Creates JSCAD kernel configuration.
 * Optimized per context-engineering.mdc: terse, canonical example demonstrates behavior.
 */
export function createJscadConfig(canonicalExample: string): KernelConfig {
  return {
    fileExtension: '.js',
    languageName: 'JSCAD',

    codeStandards: `Output ES modules JavaScript. Import from \`@jscad/modeling\` submodules. Export \`defaultParams\` object and default \`main(params)\` function returning geometry.`,

    commonErrorPatterns:
      'incorrect import paths, invalid dimensions, failed boolean operations, malformed vector arrays',

    fileLayoutMode: 'full-nesting',
    canonicalExample,
  };
}
