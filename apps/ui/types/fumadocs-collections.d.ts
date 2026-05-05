/** Ambient typings for TS path alias `fumadocs-mdx:collections/*` targets (generated files use `// @ts-nocheck`, which wipes inference for dependents). */

declare module 'fumadocs-mdx:collections/server' {
  import type { DocsCollectionEntry } from 'fumadocs-mdx/runtime/server';

  export const docs: DocsCollectionEntry<'docs'>;
}

declare module 'fumadocs-mdx:collections/browser' {
  import type { DocCollectionEntry } from 'fumadocs-mdx/runtime/browser';
  import type { PageData } from 'fumadocs-core/source';

  const collections: { docs: DocCollectionEntry<'docs', PageData> };
  export default collections;
}
