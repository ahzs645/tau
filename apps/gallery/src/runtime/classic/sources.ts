import { assertRootedPath, resolveImportPath } from '@taucad/runtime/kernel';
import type { KernelFileSystem } from '@taucad/runtime/kernel';

export type ClassicSources = Readonly<{
  entryPath: string;
  files: Readonly<Record<string, Uint8Array<ArrayBuffer>>>;
}>;

/** The session filesystem contains one project revision, including its explicitly selected library files. */
export const listClassicSourcePaths = async (filesystem: KernelFileSystem): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 50) {
      throw new Error(`OpenSCAD source directory depth exceeded at ${directory}.`);
    }
    const entries = await filesystem.readdirStat(directory);
    const directories = entries.filter(({ type }) => type === 'dir');
    files.push(...entries.filter(({ type }) => type === 'file').map(({ path }) => assertRootedPath(path)));
    await Promise.all(directories.map(async ({ path }) => visit(path, depth + 1)));
  };
  await visit('', 0);
  return files.sort();
};

export const readClassicSources = async (entryPath: string, filesystem: KernelFileSystem): Promise<ClassicSources> => {
  const paths = await listClassicSourcePaths(filesystem);
  const entry = assertRootedPath(entryPath);
  if (!paths.includes(entry)) {
    throw new Error(`The OpenSCAD entry file is missing: ${entry}`);
  }
  return { entryPath: entry, files: await filesystem.readFiles(paths) };
};

export const classicSourceText = (sources: ClassicSources, path = sources.entryPath): string => {
  const bytes = sources.files[path];
  if (!bytes) {
    throw new Error(`OpenSCAD source file is missing: ${path}`);
  }
  return new TextDecoder().decode(bytes);
};

/** Project includes can carry controls; BOSL2 implementation globals are library internals. */
export const classicCustomizerPaths = (sources: ClassicSources): string[] => {
  const visited = new Set<string>();
  const visit = (path: string): void => {
    if (visited.has(path) || path.startsWith('BOSL2/')) {
      return;
    }
    visited.add(path);
    for (const match of classicSourceText(sources, path).matchAll(/^\s*(?:use|include)\s*[<"]([^">]+)[">]/gmu)) {
      const specifier = match[1];
      if (!specifier) {
        continue;
      }
      const relative = resolveImportPath(specifier.startsWith('.') ? specifier : `./${specifier}`, path);
      const resolved = Object.hasOwn(sources.files, relative) ? relative : specifier;
      if (Object.hasOwn(sources.files, resolved) && resolved.endsWith('.scad')) {
        visit(resolved);
      }
    }
  };
  visit(sources.entryPath);
  return [...visited];
};
