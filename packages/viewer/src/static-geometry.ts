import type { GeometryGltf } from '@taucad/types';

/**
 * GLTF geometry with Tau's stable geometry hash attached.
 *
 * @public
 */
export type StaticGeometry = GeometryGltf & {
  readonly hash: string;
};

/**
 * A static glTF/GLB asset that can be loaded directly without starting a CAD kernel.
 *
 * @public
 */
export type StaticGeometrySource = {
  readonly kind: 'static';
  readonly url: string;
  readonly hash?: string;
};

/**
 * Viewer geometry source accepted by the static viewer utilities.
 *
 * @public
 */
export type GeometrySource = StaticGeometrySource;

/**
 * Options for loading static geometry assets.
 *
 * @public
 */
export type LoadStaticGeometryOptions = {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
};

/**
 * Load a static GLB or glTF asset into Tau's geometry shape.
 *
 * @param source - Static geometry source to fetch.
 * @param options - Loading hooks such as an abort signal or test fetch implementation.
 * @returns The loaded static geometry.
 * @public
 */
export async function loadStaticGeometry(
  source: StaticGeometrySource,
  options: LoadStaticGeometryOptions = {},
): Promise<StaticGeometry> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  const response = await fetchImplementation(source.url, { signal: options.signal });
  if (!response.ok) {
    throw new Error(`Failed to load static geometry: ${response.status}`);
  }

  return staticGeometryFromBytes({
    bytes: new Uint8Array(await response.arrayBuffer()),
    hash: source.hash ?? `static:${source.url}`,
  });
}

/**
 * Raw static geometry bytes plus the stable hash used by Tau viewer caches.
 *
 * @public
 */
export type StaticGeometryBytesInput = {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly hash: string;
};

/**
 * Wrap raw GLB or glTF bytes in Tau's geometry shape.
 *
 * @param input - Static geometry bytes and stable hash.
 * @returns A copied static geometry object.
 * @public
 */
export function staticGeometryFromBytes(input: StaticGeometryBytesInput): StaticGeometry {
  return {
    format: 'gltf',
    content: new Uint8Array(input.bytes),
    hash: input.hash,
  };
}
