/**
 * R20 — assert that `@taucad/runtime/filesystem/browser` is a real
 * subpath that returns an opaque {@link RuntimeFileSystem} brand.
 *
 * The subpath isolates the FS Access API entry point so browser apps
 * can tree-shake away the rest of the filesystem barrel and so the
 * eager `from-browser-fs` import does not pull `FileSystemDirectoryHandle`
 * symbols into Node-only consumer bundles.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

import { isRuntimeFileSystem } from '#filesystem/runtime-filesystem.js';

describe('filesystem/browser subpath (R20)', () => {
  it('exposes only the public fromBrowserFs factory', async () => {
    const subpath = await import('#filesystem/from-browser-fs.js');
    expect(subpath.fromBrowserFs).toBeTypeOf('function');
    const exported = Object.keys(subpath).sort();
    expect(exported).toEqual(['fromBrowserFs']);
  });

  it('returns an opaque RuntimeFileSystem brand from the subpath', async () => {
    const { fromBrowserFs } = await import('#filesystem/from-browser-fs.js');

    const stubRoot = {
      kind: 'directory',
      name: 'root',
      async *entries() {
        yield* [];
      },
      async getDirectoryHandle() {
        throw new Error('stub');
      },
      async getFileHandle() {
        throw new Error('stub');
      },
      async removeEntry() {
        await Promise.resolve();
      },
    } as unknown as FileSystemDirectoryHandle;

    const fs = fromBrowserFs(stubRoot);
    expect(isRuntimeFileSystem(fs)).toBe(true);
  });
});
