import type { KernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.types.js';
import canonicalExample from '#api/chat/prompts/kernel-prompt-configs/jscad.prompt.example.js?raw';

export const jscadConfig: KernelConfig = {
  fileExtension: '.js',
  languageName: 'JSCAD',

  codeStandards: `Output ES modules JavaScript. Import from \`@jscad/modeling\` submodules. Export \`defaultParams\` object and default \`main(params)\` function returning geometry.`,

  commonErrorPatterns: 'incorrect import paths, invalid dimensions, failed boolean operations, malformed vector arrays',

  fileLayoutMode: 'full-nesting',
  canonicalExample,
};
