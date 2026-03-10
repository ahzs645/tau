import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRawEngine } from 'shiki/engine/javascript';
import { transformerNotationDiff } from '@shikijs/transformers';

export const highlighter = await createHighlighterCore({
  themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
  langs: [
    import('@shikijs/langs-precompiled/javascript'),
    import('@shikijs/langs-precompiled/typescript'),
    import('@shikijs/langs-precompiled/jsx'),
    import('@shikijs/langs-precompiled/tsx'),
    import('@shikijs/langs-precompiled/bash'),
    import('@shikijs/langs-precompiled/json'),
    // @ts-expect-error -- TODO: migrate the precompiled grammar to the Shiki project.
    import('#lib/openscad-language/openscad-shiki-precompiled.js'),
    // @ts-expect-error -- TODO: migrate the precompiled grammar to the Shiki project.
    import('#lib/kcl-language/kcl-shiki-precompiled.js'),
    // @ts-expect-error -- TODO: migrate the precompiled grammar to the Shiki project.
    import('#lib/stepfile-language/stepfile-shiki-precompiled.js'),
    import('#lib/stl-language/stl-shiki-precompiled.js'),
    // @ts-expect-error -- TODO: migrate the precompiled grammar to the Shiki project.
    import('#lib/usd-language/usd-shiki-precompiled.js'),
  ],
  engine: createJavaScriptRawEngine(),
});

// Export the diff transformer for use in diff viewer
// Uses the Shiki notation syntax: // [!code ++] and // [!code --]
export const diffTransformer = transformerNotationDiff();
