import { kclStdlibReference } from '@taucad/api-extractor';
import type { KernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.types.js';
import canonicalExample from '#api/chat/prompts/kernel-prompt-configs/zoo.prompt.example.kcl?raw';

export const zooConfig: KernelConfig = {
  fileExtension: '.kcl',
  languageName: 'KCL',

  codeStandards: `Output KCL syntax. Use camelCase for variables. Start with \`@settings(defaultLengthUnit = mm)\`. Use pipe operators (\`|>\`) for operation chaining.

<kcl_stdlib_reference>
${kclStdlibReference}
</kcl_stdlib_reference>`,

  commonErrorPatterns: 'missing pipe operators, unclosed sketches, undefined variables, invalid geometric parameters',

  fileLayoutMode: 'assembly-only',
  canonicalExample,
};
