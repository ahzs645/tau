import { jscadModelingTypes as jscadTypesMap } from '@taucad/api-extractor';
import type { KernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.types.js';
import canonicalExample from '#api/chat/prompts/kernel-prompt-configs/jscad.prompt.example.ts?raw';

const jscadModelingTypes = Object.values(jscadTypesMap).join('\n\n');

export const jscadConfig: KernelConfig = {
  fileExtension: '.ts',
  languageName: 'JSCAD',

  codeStandards: `Output TypeScript with ES module imports. Import from \`@jscad/modeling\` submodules. Export \`defaultParams\` object and default \`main(params)\` function returning geometry.

<jscad_api>
${jscadModelingTypes}
</jscad_api>`,

  commonErrorPatterns: 'incorrect import paths, invalid dimensions, failed boolean operations, malformed vector arrays',

  fileLayoutMode: 'full-nesting',
  canonicalExample,
};
