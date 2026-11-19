import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isModelInput, parseProjectDefinition, readDeclaredLibraries } from '#catalog/schema.js';
import type { GalleryFiles, GalleryProject } from '#catalog/types.js';

export const galleryModelsDirectory = fileURLToPath(new URL('../models/', import.meta.url));

export type NodeCatalogEntry = {
  readonly project: GalleryProject;
  readonly directory: string;
};

const listFiles = async (directory: string, relative = ''): Promise<string[]> => {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listFiles(directory, name) : entry.isFile() ? [name] : [];
    }),
  );
  return nested.flat().sort();
};

const resourcePath = (directory: string, libraries: readonly string[], relativePath: string): string => {
  const library = relativePath.split('/')[0];
  return library && libraries.includes(library)
    ? path.join(galleryModelsDirectory, 'libraries', relativePath)
    : path.join(directory, relativePath);
};

const readEntry = async (collection: 'curated' | 'projects', id: string): Promise<NodeCatalogEntry> => {
  const directory = path.join(galleryModelsDirectory, collection, id);
  const [filePaths, metadataText] = await Promise.all([
    listFiles(directory),
    readFile(path.join(directory, 'project.json'), 'utf8'),
  ]);
  const metadata: unknown = JSON.parse(metadataText);
  const libraries = readDeclaredLibraries(metadata);
  const libraryPaths = await Promise.all(
    libraries.map(async (library) => {
      const libraryFiles = await listFiles(path.join(galleryModelsDirectory, 'libraries', library));
      return libraryFiles.map((relativePath) => `${library}/${relativePath}`);
    }),
  );
  filePaths.push(...libraryPaths.flat());
  const presets: unknown = filePaths.includes('presets.json')
    ? JSON.parse(await readFile(path.join(directory, 'presets.json'), 'utf8'))
    : [];
  return {
    directory,
    project: parseProjectDefinition({
      id,
      collection,
      metadata,
      presets,
      filePaths,
      resourceUrl: (relativePath) => pathToFileURL(resourcePath(directory, libraries, relativePath)).href,
    }),
  };
};

/** Read the same folder-owned metadata as the browser without using Vite globals. */
export const readNodeCatalog = async (): Promise<readonly NodeCatalogEntry[]> => {
  const collections = await Promise.all(
    (['curated', 'projects'] as const).map(async (collection) => {
      const children = await readdir(path.join(galleryModelsDirectory, collection), { withFileTypes: true });
      return Promise.all(
        children.filter((child) => child.isDirectory()).map(async (child) => readEntry(collection, child.name)),
      );
    }),
  );
  const entries = collections.flat();
  const seen = new Set<string>();
  for (const { project } of entries) {
    if (seen.has(project.id)) {
      throw new Error(`Duplicate gallery project ID ${project.id}`);
    }
    seen.add(project.id);
  }
  return entries.sort((left, right) => left.project.title.localeCompare(right.project.title));
};

/** Preserve binary imports and nested helper files in the actual runtime input. */
export const loadNodeProjectFiles = async (entry: NodeCatalogEntry): Promise<GalleryFiles> => {
  const files = await Promise.all(
    entry.project.filePaths
      .filter((name) => isModelInput(name))
      .map(async (relativePath) => {
        const absolutePath = resourcePath(entry.directory, entry.project.libraries, relativePath);
        const bytes = await readFile(absolutePath);
        return [relativePath, new Uint8Array(bytes)] as const;
      }),
  );
  return Object.fromEntries(files);
};
