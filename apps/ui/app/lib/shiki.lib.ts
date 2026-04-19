import type { HighlighterCore } from 'shiki/core';
import { transformerNotationDiff } from '@shikijs/transformers';

let cachedHighlighter: Promise<HighlighterCore> | undefined;

/**
 * Lazily create and return a memoized Shiki highlighter instance.
 * Defers grammar evaluation until first use, avoiding top-level `await`
 * that blocks module graph evaluation on startup.
 */
export const getHighlighter = async (): Promise<HighlighterCore> => {
  cachedHighlighter ??= (async () => {
    const { createHighlighterCore } = await import('shiki/core');
    const { createJavaScriptRawEngine } = await import('shiki/engine/javascript');

    return createHighlighterCore({
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
  })();
  return cachedHighlighter;
};

export const diffTransformer = transformerNotationDiff();
