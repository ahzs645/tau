import type { KernelTypesMap } from '#kernel-types.js';

/** Lazily resolves one kernel family's bundled declaration map. @public */
export type KernelTypesLoader = () => Promise<KernelTypesMap>;

const parseTypesMap = (raw: string): KernelTypesMap => JSON.parse(raw) as KernelTypesMap;

const loadOpenCascadeTypes: KernelTypesLoader = async () => {
  const module = await import('#generated/opencascade/opencascade.bundled.json?raw');
  return parseTypesMap(module.default);
};

const loadReplicadTypes: KernelTypesLoader = async () => {
  const module = await import('#generated/replicad/replicad.bundled.json?raw');
  return parseTypesMap(module.default);
};

const loadJscadTypes: KernelTypesLoader = async () => {
  const module = await import('#generated/jscad/jscad-modeling.bundled.json?raw');
  return parseTypesMap(module.default);
};

const loadManifoldTypes: KernelTypesLoader = async () => {
  const module = await import('#generated/manifold/manifold.bundled.json?raw');
  return parseTypesMap(module.default);
};

/**
 * Built-in declaration loaders keyed by the bare package name detected by ATA.
 * Each dynamic import becomes an independently hashed browser asset, so the
 * 11 MiB OpenCascade declarations are never parsed unless a model imports
 * `opencascade.js`.
 *
 * @public
 */
export const kernelTypeLoaders: Readonly<Record<string, KernelTypesLoader>> = {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- npm package name
  'opencascade.js': loadOpenCascadeTypes,
  replicad: loadReplicadTypes,
  // eslint-disable-next-line @typescript-eslint/naming-convention -- scoped npm package name
  '@jscad/modeling': loadJscadTypes,
  'manifold-3d': loadManifoldTypes,
};
