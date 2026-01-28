import type { KernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.types.js';
import canonicalExample from '#api/chat/prompts/kernel-prompt-configs/openscad.prompt.example.scad?raw';

export const openscadConfig: KernelConfig = {
  fileExtension: '.scad',
  languageName: 'OpenSCAD',

  codeStandards: `Output executable OpenSCAD code. Use snake_case for variables (e.g., \`grip_diameter\`). Define modules for reusable geometry. Use hex colors (e.g., \`color("#8B5A2B")\`). Multi-select: \`children([0:2])\` for geometry, \`select(vec, [indices])\` for data.`,

  commonErrorPatterns:
    'missing semicolons, undefined variables, invalid dimensions (must be positive), unclosed modules',

  fileLayoutMode: 'full-nesting',
  canonicalExample,
};
