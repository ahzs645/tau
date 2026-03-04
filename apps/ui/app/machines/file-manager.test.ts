import { describe, it, expect, beforeEach } from 'vitest';
import { configure, fs as zenfs, InMemory } from '@zenfs/core';

const fsp = zenfs.promises;

/**
 * Serialization queue identical to the one in file-manager.ts.
 * Duplicated here to test the pattern in isolation without importing
 * the full file-manager module (which has side effects and worker deps).
 */
// oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- chained promise pattern
let writeQueue: Promise<void> = Promise.resolve();

async function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue
    // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- chained promise pattern
    .catch(() => {
      // Swallow previous error so the queue continues
    })
    // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- chained promise pattern
    .then(async () => operation());

  writeQueue = result
    // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- chained promise pattern
    .catch(() => {
      // No-op
    })
    // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- chained promise pattern
    .then(() => {
      // No-op
    });
  return result;
}

function resetQueue(): void {
  // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- chained promise pattern
  writeQueue = Promise.resolve();
}

/**
 * Helper to write a file using the ZenFS promise API,
 * creating parent directories as needed (non-serialized).
 */
async function writeFileRaw(path: string, content: string): Promise<void> {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash > 0) {
    const directory = path.slice(0, lastSlash);
    const segments = directory.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current += `/${segment}`;
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential processing required
        await fsp.mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    }
  }

  await fsp.writeFile(path, content);
}

describe('ZenFS directory listing race condition (zen-fs/core#256)', () => {
  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem mount path
    await configure({ mounts: { '/': InMemory } });
    resetQueue();
  });

  it('should lose directory entries when writing concurrently WITHOUT serialization', async () => {
    const directory = '/race-test';
    await fsp.mkdir(directory);

    const fileCount = 10;
    const writes = Array.from({ length: fileCount }, async (_, i) =>
      writeFileRaw(`${directory}/file-${i}.txt`, `content-${i}`),
    );

    // Fire all writes concurrently -- no serialization.
    // ZenFS commitNew reads the directory listing, adds one entry, writes it back.
    // Concurrent calls read the SAME snapshot, so the last writer wins and
    // all other entries are lost.
    await Promise.all(writes);

    const entries = await fsp.readdir(directory);

    // With the race condition, we expect FEWER than fileCount entries.
    // The exact count varies per run, but it should almost never be the full set.
    // We assert that at least one entry was lost to prove the race exists.
    console.log(`[race-test] Without serialization: ${entries.length}/${fileCount} files survived`, entries);

    expect(entries.length).toBeLessThan(fileCount);
  });

  it('should preserve ALL directory entries when writing with serialization', async () => {
    const directory = '/serial-test';
    await fsp.mkdir(directory);

    const fileCount = 10;

    // Write all files through the serialization queue -- each operation
    // waits for the previous one to complete before running.
    const writes = Array.from({ length: fileCount }, async (_, i) =>
      serialized(async () => writeFileRaw(`${directory}/file-${i}.txt`, `content-${i}`)),
    );

    await Promise.all(writes);

    const entries = await fsp.readdir(directory);

    console.log(`[serial-test] With serialization: ${entries.length}/${fileCount} files survived`, entries);

    expect(entries.length).toBe(fileCount);

    // Verify every file is present and readable
    for (let i = 0; i < fileCount; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential processing required
      const content = await fsp.readFile(`${directory}/file-${i}.txt`, 'utf8');
      expect(content).toBe(`content-${i}`);
    }
  });

  it('should lose entries in nested directory writes without serialization', async () => {
    // This simulates the real-world scenario: creating a build with multiple
    // files in /builds/<id>/ -- all written concurrently.
    const buildDirectory = '/builds/test-build-id';

    const files: Record<string, string> = {
      [`${buildDirectory}/main.ts`]: 'export default {};',
      [`${buildDirectory}/utils.ts`]: 'export function helper() {}',
      [`${buildDirectory}/types.ts`]: 'export type Foo = {};',
      [`${buildDirectory}/config.json`]: '{"key": "value"}',
      [`${buildDirectory}/README.md`]: '# Test',
    };

    // Write all files concurrently without serialization
    const writes = Object.entries(files).map(async ([path, content]) => writeFileRaw(path, content));

    await Promise.all(writes);

    const entries = await fsp.readdir(buildDirectory);

    console.log(
      `[nested-race-test] Without serialization: ${entries.length}/${Object.keys(files).length} files survived`,
      entries,
    );

    // The directory listing should be corrupted -- some files will be missing
    expect(entries.length).toBeLessThan(Object.keys(files).length);
  });

  it('should preserve all entries in nested directory writes WITH serialization', async () => {
    const buildDirectory = '/builds/test-build-id';

    const files: Record<string, string> = {
      [`${buildDirectory}/main.ts`]: 'export default {};',
      [`${buildDirectory}/utils.ts`]: 'export function helper() {}',
      [`${buildDirectory}/types.ts`]: 'export type Foo = {};',
      [`${buildDirectory}/config.json`]: '{"key": "value"}',
      [`${buildDirectory}/README.md`]: '# Test',
    };

    // Write all files through the serialization queue
    const writes = Object.entries(files).map(async ([path, content]) =>
      serialized(async () => writeFileRaw(path, content)),
    );

    await Promise.all(writes);

    const entries = await fsp.readdir(buildDirectory);

    console.log(
      `[nested-serial-test] With serialization: ${entries.length}/${Object.keys(files).length} files survived`,
      entries,
    );

    expect(entries.length).toBe(Object.keys(files).length);

    // Verify file contents are intact
    for (const [path, expectedContent] of Object.entries(files)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential processing required
      const content = await fsp.readFile(path, 'utf8');
      expect(content).toBe(expectedContent);
    }
  });
});
