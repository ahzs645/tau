import { createRuntimeClient } from '@taucad/runtime/client';
import { createWebWorkerClientOptions } from '@taucad/runtime/transport/web';
import { createGallerySessionWithClient } from '#runtime/session.js';
import type { GalleryKernel, GallerySession, GallerySessionInput, GallerySessionOptions } from '#runtime/types.js';

const createWorker = (kernel: GalleryKernel): Worker => {
  switch (kernel) {
    case 'opencascade': {
      return new Worker(new URL('workers/opencascade.worker.ts', import.meta.url), { type: 'module' });
    }
    case 'replicad': {
      return new Worker(new URL('workers/replicad.worker.ts', import.meta.url), { type: 'module' });
    }
    case 'openrscad': {
      return new Worker(new URL('workers/openrscad.worker.ts', import.meta.url), { type: 'module' });
    }
  }
};

/** Start one selected kernel in a dedicated worker; parameter changes reuse its document. */
export const createGallerySession = (
  input: GallerySessionInput,
  options?: GallerySessionOptions,
): Promise<GallerySession> => {
  const client = createRuntimeClient(
    createWebWorkerClientOptions({
      createWorker: () => createWorker(input.kernel),
      operationTimeout: input.operationTimeout ?? 120_000,
    }),
  );
  client.setTranscodeTimeout(input.operationTimeout ?? 120_000);
  return createGallerySessionWithClient(client, input, options);
};
