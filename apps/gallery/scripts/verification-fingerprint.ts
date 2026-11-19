import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const collectFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map(async (entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(filename);
      }
      return entry.isFile() ? [filename] : [];
    }),
  );
  return groups.flat();
};

/** Bind resumable verification evidence to the actual sources, dependencies and selected checks. */
export const verificationFingerprint = async (input: {
  readonly root: string;
  readonly directories: readonly string[];
  readonly files: readonly string[];
  readonly options: Readonly<Record<string, unknown>>;
}): Promise<string> => {
  const groups = await Promise.all(
    input.directories.map((directory) => collectFiles(path.join(input.root, directory))),
  );
  const files = [...groups.flat(), ...input.files.map((filename) => path.join(input.root, filename))].toSorted();
  const hash = createHash('sha256');
  hash.update(JSON.stringify(input.options));
  // Keep controller memory bounded while hashing large preserved binary model assets.
  /* oxlint-disable no-await-in-loop -- Read one source buffer at a time rather than retaining the full model/library collection. */
  for (const filename of files) {
    hash.update(path.relative(input.root, filename));
    hash.update('\0');
    hash.update(await readFile(filename));
    hash.update('\0');
  }
  /* oxlint-enable no-await-in-loop */
  return hash.digest('hex');
};
