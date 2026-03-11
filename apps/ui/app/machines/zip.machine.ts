import { assign, assertEvent, setup } from 'xstate';
import type { AnyActorRef } from 'xstate';
import JSZip from 'jszip';
import { fromSafeAsync } from '#lib/xstate.lib.js';

/**
 * Zip Machine Context
 */
export type ZipContext = {
  parentRef: AnyActorRef | undefined;
  files: Map<string, { content: Uint8Array<ArrayBuffer>; filename: string }>;
  zipBlob: Blob | undefined;
  error: Error | undefined;
  zipFilename: string;
};

/**
 * Zip Machine Input
 */
type ZipInput = {
  parentRef?: AnyActorRef;
  zipFilename?: string;
};

/**
 * Zip Machine Events
 */
type ZipEventInternal =
  | {
      type: 'addFile';
      filename: string;
      content: Uint8Array<ArrayBuffer>;
    }
  | {
      type: 'addFiles';
      files: Array<{ filename: string; content: Uint8Array<ArrayBuffer> }>;
    }
  | { type: 'generate' }
  | { type: 'clear' }
  | { type: 'reset' };

type ZipEventEmitted = { type: 'zipGenerated'; blob: Blob };

type ZipEvent = ZipEventInternal | ZipEventEmitted;

const generateZipActor = fromSafeAsync<
  ZipEventEmitted,
  { files: Map<string, { content: Uint8Array<ArrayBuffer>; filename: string }> }
>(async ({ input }) => {
  const zip = new JSZip();

  for (const [, file] of input.files) {
    zip.file(file.filename, file.content);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  return { type: 'zipGenerated', blob };
});

const zipActors = {
  generateZipActor,
} as const;

/**
 * Zip Machine
 *
 * Manages creating ZIP archives from multiple files.
 *
 * States:
 * - idle: Waiting for files to be added
 * - generating: Creating the ZIP file
 * - ready: ZIP file is ready for download
 * - error: An error occurred during generation
 */
export const zipMachine = setup({
  types: {
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    context: {} as ZipContext,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    events: {} as ZipEvent,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    input: {} as ZipInput,
  },
  actors: zipActors,
  guards: {
    hasFiles({ context }) {
      return context.files.size > 0;
    },
  },
  actions: {
    setError: assign({
      error({ event }) {
        if ('error' in event && event.error instanceof Error) {
          return event.error;
        }

        return new Error('Unknown error');
      },
    }),
    clearError: assign({
      error: undefined,
    }),
    addFile: assign({
      files({ context, event }) {
        assertEvent(event, 'addFile');
        const updated = new Map(context.files);
        updated.set(event.filename, {
          content: event.content,
          filename: event.filename,
        });
        return updated;
      },
    }),
    addFiles: assign({
      files({ context, event }) {
        assertEvent(event, 'addFiles');
        const updated = new Map(context.files);
        for (const file of event.files) {
          updated.set(file.filename, {
            content: file.content,
            filename: file.filename,
          });
        }

        return updated;
      },
    }),
    setZipBlob: assign({
      zipBlob({ event }) {
        assertEvent(event, 'zipGenerated');
        return event.blob;
      },
    }),
    clearFiles: assign({
      files: new Map(),
    }),
    clearZipBlob: assign({
      zipBlob: undefined,
    }),
    reset: assign({
      files: new Map(),
      zipBlob: undefined,
      error: undefined,
    }),
  },
}).createMachine({
  id: 'zip',
  context: ({ input }) => ({
    parentRef: input.parentRef,
    files: new Map(),
    zipBlob: undefined,
    error: undefined,
    zipFilename: input.zipFilename ?? 'archive.zip',
  }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        addFile: {
          actions: 'addFile',
        },
        addFiles: {
          actions: 'addFiles',
        },
        generate: {
          target: 'generating',
          guard: 'hasFiles',
        },
        clear: {
          actions: 'clearFiles',
        },
        reset: {
          actions: 'reset',
        },
      },
    },
    generating: {
      entry: 'clearError',
      invoke: {
        src: 'generateZipActor',
        input: ({ context }) => ({
          files: context.files,
        }),
        onDone: {
          target: 'ready',
        },
        onError: {
          target: 'error',
          actions: 'setError',
        },
      },
      on: {
        zipGenerated: {
          actions: 'setZipBlob',
        },
      },
    },
    ready: {
      on: {
        addFile: {
          target: 'idle',
          actions: ['clearZipBlob', 'addFile'],
        },
        addFiles: {
          target: 'idle',
          actions: ['clearZipBlob', 'addFiles'],
        },
        clear: {
          target: 'idle',
          actions: ['clearFiles', 'clearZipBlob'],
        },
        reset: {
          target: 'idle',
          actions: 'reset',
        },
        generate: {
          target: 'generating',
        },
      },
    },
    error: {
      on: {
        generate: {
          target: 'generating',
          guard: 'hasFiles',
        },
        clear: {
          target: 'idle',
          actions: ['clearFiles', 'clearError'],
        },
        reset: {
          target: 'idle',
          actions: 'reset',
        },
      },
    },
  },
});
