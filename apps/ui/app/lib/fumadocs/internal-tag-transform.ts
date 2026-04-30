import type { DocEntry } from 'fumadocs-typescript';

/**
 * Workaround for `fumadocs-typescript@4.x`'s broken `@internal` filter.
 *
 * `generate()` filters with `!("internal" in entry.tags)`, but `entry.tags`
 * is an Array of `{ name, text }` objects — `"internal" in array` is always
 * `false`, so `@internal`-tagged properties are never hidden. Fixed properly
 * in v5.x (see https://www.npmjs.com/package/fumadocs-typescript) which
 * checks each tag name and bails inside `getDocEntry`.
 *
 * Until we upgrade the fumadocs stack as a unit, we inject this transform so
 * the existing filter detects `@internal` correctly: JS arrays accept
 * arbitrary string-keyed properties, so setting `entry.tags.internal = true`
 * flips `"internal" in entry.tags` to `true` and the entry is dropped.
 *
 * Critical for the opaque-type pattern (e.g. `RuntimeFileSystem`'s
 * `unique symbol` brand) — without this, the brand's TS-internal display
 * name `__@___runtimeFileSystemBrand@<id>` lands verbatim as a JS property
 * key in the compiled MDX output, which rolldown's parser rejects.
 */
export const internalTagTransform = (entry: DocEntry): void => {
  if (entry.tags.some((tag) => tag.name === 'internal')) {
    (entry.tags as unknown as Record<string, true>)['internal'] = true;
  }
};
