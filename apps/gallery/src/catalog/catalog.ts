import { isModelInput, parseProjectDefinition, readDeclaredLibraries } from '#catalog/schema.js';
import type { GalleryFiles, GalleryProject } from '#catalog/types.js';

const metadata = import.meta.glob<unknown>('../../models/*/*/project.json', { eager: true, import: 'default' });
const presets = import.meta.glob<unknown>('../../models/*/*/presets.json', { eager: true, import: 'default' });
// URL modules keep source, meshes and artwork out of the initial JavaScript payload.
const urls = import.meta.glob<string>('../../models/*/*/**/*', { eager: true, query: '?url', import: 'default' });
const roots = new Map<string, string>();
const resourceUrls = new Map<string, Readonly<Record<string, string>>>();
const projects = Object.entries(metadata)
  .map(([metadataPath, definition]) => {
    const match = /^\.\.\/\.\.\/models\/(projects|curated)\/([^/]+)\/project\.json$/u.exec(metadataPath);
    const collection = match?.[1];
    const id = match?.[2];
    if (!id || (collection !== 'projects' && collection !== 'curated')) {
      throw new Error(`Unexpected gallery metadata path ${metadataPath}`);
    }
    if (roots.has(id)) {
      throw new Error(`Duplicate gallery project ID ${id}`);
    }
    const root = metadataPath.slice(0, -'project.json'.length);
    roots.set(id, root);
    const resources: Record<string, string> = Object.fromEntries(
      Object.entries(urls)
        .filter(([path]) => path.startsWith(root))
        .map(([path, url]) => [path.slice(root.length), url]),
    );
    for (const library of readDeclaredLibraries(definition)) {
      const prefix = `../../models/libraries/${library}/`;
      for (const [path, url] of Object.entries(urls)) {
        if (path.startsWith(prefix)) {
          resources[`${library}/${path.slice(prefix.length)}`] = url;
        }
      }
    }
    resourceUrls.set(id, resources);
    return parseProjectDefinition({
      id,
      collection,
      metadata: definition,
      presets: presets[`${root}presets.json`],
      filePaths: Object.keys(resources),
      resourceUrl: (path) => {
        const url = resources[path];
        if (!url) {
          throw new Error(`Missing gallery resource ${id}/${path}`);
        }
        return url;
      },
    });
  })
  .sort((left, right) => left.title.localeCompare(right.title));

/** Public gallery entries; unfinished source stays available in Git without becoming a route. */
export const listPublicProjects = (): readonly GalleryProject[] => projects.filter((project) => !project.hidden);

/** Resolve a public project without opening or executing its source. */
export const getProject = (id: string): GalleryProject | undefined =>
  projects.find((project) => project.id === id && !project.hidden);

const requireProject = (id: string): GalleryProject => {
  const project = getProject(id);
  if (!project) {
    throw new Error(`Unknown gallery project ${id}`);
  }
  return project;
};

const loadFiles = async (
  project: GalleryProject,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<GalleryFiles> => {
  const resources = resourceUrls.get(project.id);
  if (!resources) {
    throw new Error(`Missing source directory for ${project.id}`);
  }
  const entries = await Promise.all(
    paths.map(async (path) => {
      const url = resources[path];
      if (!url) {
        throw new Error(`Missing source resource ${project.id}/${path}`);
      }
      const response = await fetch(url, { signal });
      if (!response.ok) {
        throw new Error(`Could not load ${project.id}/${path}: HTTP ${response.status}`);
      }
      return [path, new Uint8Array(await response.arrayBuffer())] as const;
    }),
  );
  return Object.fromEntries(entries);
};

/** Load every source and binary dependency together; a missing part is a visible error. */
export const loadProjectFiles = async (id: string, variantId?: string, signal?: AbortSignal): Promise<GalleryFiles> => {
  const project = requireProject(id);
  if (variantId && !project.variants.some((variant) => variant.id === variantId)) {
    throw new Error(`Unknown variant ${id}/${variantId}`);
  }
  return loadFiles(
    project,
    project.filePaths.filter((name) => isModelInput(name)),
    signal,
  );
};

/** Decode a source file without ever treating binary mesh inputs as editor text. */
export const sourceText = (files: GalleryFiles, path: string): string | undefined => {
  if (!/\.(?:[cm]?js|tsx?|scad|json|svg|dxf|txt|csv)$/iu.test(path)) {
    return undefined;
  }
  const bytes = files[path];
  return bytes ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : undefined;
};

/** Package the complete authored project, including presets, binary inputs and attribution. */
export const createProjectSourceArchive = async (
  id: string,
  signal?: AbortSignal,
): Promise<{ filename: string; bytes: Uint8Array<ArrayBuffer>; mimeType: string }> => {
  const project = requireProject(id);
  const files = await loadFiles(project, project.filePaths, signal);
  const { zipSync } = await import('fflate');
  const archive = Object.fromEntries(Object.entries(files).map(([path, content]) => [`${id}/${path}`, content]));
  return {
    filename: `${id}-source.zip`,
    bytes: new Uint8Array(zipSync(archive, { level: 6 })),
    mimeType: 'application/zip',
  };
};
