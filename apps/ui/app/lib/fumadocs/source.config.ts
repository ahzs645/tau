import type { frontmatterSchema, metaSchema, DocsCollection } from 'fumadocs-mdx/config';
import type { LanguageInput } from 'shiki';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { remarkAutoTypeTable, createGenerator } from 'fumadocs-typescript';
import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import kclLang from '#lib/kcl-language/kcl-shiki-precompiled.js';
import openscadLang from '#lib/openscad-language/openscad-shiki-precompiled.js';

const generator = createGenerator({
  tsconfigPath: '../../tsconfig.docs.json',
});

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
    remarkPlugins: [[remarkAutoTypeTable, { generator }], remarkMdxMermaid],
    remarkCodeTabOptions: {
      parseMdx: true,
    },
    rehypeCodeOptions: {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- precompiled Shiki grammars are compatible at runtime but don't match LanguageInput type
      langs: [...kclLang, ...openscadLang] as unknown as LanguageInput[],
    },
  },
});
