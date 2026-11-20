import type { GalleryStaticOptions, GalleryRenderResult } from '#runtime/types.js';
import { normalizeStaticGlb } from '#runtime/static-glb.js';

/** Load a binary glTF preview without creating a CAD kernel or evaluating model source. */
export const loadGalleryStaticArtifact = async (
  url: string,
  options: GalleryStaticOptions = {},
): Promise<GalleryRenderResult> => {
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) {
    throw new Error(`Could not load the model preview (${response.status}).`);
  }
  const bytes = normalizeStaticGlb(new Uint8Array(await response.arrayBuffer()), options.coordinateSystem ?? 'y-up');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  options.signal?.throwIfAborted();
  return {
    artifact: { mimeType: 'model/gltf-binary', content: bytes },
    artifactHash: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    jsonSchema: undefined,
    parameterManifest: undefined,
    defaultParameters: {},
    parameters: {},
    formats: ['glb'],
    issues: [],
  };
};
