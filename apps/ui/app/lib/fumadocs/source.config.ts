import type { frontmatterSchema, metaSchema, DocsCollection } from 'fumadocs-mdx/config';
import type { LanguageInput } from 'shiki';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import kclLang from '#lib/kcl-language/kcl-shiki-precompiled.js';
import openscadLang from '#lib/openscad-language/openscad-shiki-precompiled.js';

export const docs: DocsCollection<typeof frontmatterSchema, typeof metaSchema> = defineDocs({
  dir: 'content/docs',
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig({
  mdxOptions: {
    remarkCodeTabOptions: {
      parseMdx: true,
    },
    rehypeCodeOptions: {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      // Cast to LanguageInput[] - the precompiled grammars are compatible at runtime
      langs: [...kclLang, ...openscadLang] as unknown as LanguageInput[],
    },
  },
});
