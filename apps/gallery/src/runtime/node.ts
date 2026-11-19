import { createNodeClient } from '@taucad/runtime/node';
import type { AnyRuntimeDefinition } from '@taucad/runtime/worker';
import { createGallerySessionWithClient } from '#runtime/session.js';
import type { GalleryKernel, GallerySession, GallerySessionInput, GallerySessionOptions } from '#runtime/types.js';

const loadRuntime = async (kernel: GalleryKernel): Promise<AnyRuntimeDefinition> => {
  switch (kernel) {
    case 'opencascade': {
      const { runtime } = await import('#runtime/definitions/opencascade.js');
      return runtime;
    }
    case 'replicad': {
      const { runtime } = await import('#runtime/definitions/replicad.js');
      return runtime;
    }
    case 'openrscad': {
      const { runtime } = await import('#runtime/definitions/openrscad.js');
      return runtime;
    }
  }
};

/**
 * The same gallery document and export policy in Node, without browser globals or a DOM.
 * Run this entry in a child process when a hard deadline is needed: an in-process native call cannot be preempted.
 */
export const createNodeGallerySession = async (
  input: GallerySessionInput,
  options?: GallerySessionOptions,
): Promise<GallerySession> => {
  options?.signal?.throwIfAborted();
  const runtime = await loadRuntime(input.kernel);
  const client = await createNodeClient({ runtime });
  client.setTranscodeTimeout(0);
  return createGallerySessionWithClient(client, input, options);
};
