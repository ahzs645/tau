import { replicadTypes as replicadTypesMap } from '@taucad/api-extractor';
import type { KernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.types.js';
import canonicalExample from '#api/chat/prompts/kernel-prompt-configs/replicad.prompt.example.ts?raw';

const replicadTypes = Object.values(replicadTypesMap).join('\n\n');

export const replicadConfig: KernelConfig = {
  fileExtension: '.ts',
  languageName: 'Replicad',

  codeStandards: `Output TypeScript with ES module imports. Use camelCase for variables. Export \`defaultParams\` object and default \`main(params)\` function returning geometry.

<replicad_api>
${replicadTypes}
</replicad_api>`,

  commonErrorPatterns:
    'invalid dimensions, self-intersecting geometry, unclosed sketches, failed boolean operations on coincident surfaces',

  fileLayoutMode: 'full-nesting',
  canonicalExample,
};
