import type { KernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.types.js';
import canonicalExample from '#api/chat/prompts/kernel-prompt-configs/opencascadejs.prompt.example.ts?raw';

export const opencascadejsConfig: KernelConfig = {
  fileExtension: '.ts',
  languageName: 'OpenCascade.js',

  codeStandards: `Output TypeScript with \`import { ClassName } from 'opencascade.js'\` using named imports. Export \`defaultParams\` and a default \`main(params)\` function returning a \`TopoDS_Shape\`. Always call \`.delete()\` on OCCT objects in a \`finally\` block to prevent memory leaks.`,

  commonErrorPatterns:
    'memory leaks from missing .delete() calls, wrong constructor overload suffix (e.g. _2 vs _3), unfreed gp_Pnt/gp_Dir temporaries, using Shape() before Build()',

  fileLayoutMode: 'full-nesting',
  canonicalExample,
};
