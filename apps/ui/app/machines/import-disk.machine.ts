import { assign, assertEvent, setup, fromPromise, emit } from 'xstate';
import type { AnyActorRef, OutputFrom, DoneActorEvent } from 'xstate';
import JSZip from 'jszip';
import { assertActorDoneEvent } from '#lib/xstate.js';
import type { FileMap } from '#utils/file-reader.utils.js';
import { readFromFileList, readFromDataTransfer, normalizeFilePaths, getImportName } from '#utils/file-reader.utils.js';
import { findMainFile } from '#routes/import.$/import.utils.js';

/**
 * Import Disk Machine Context
 */
export type ImportDiskContext = {
  parentRef: AnyActorRef | undefined;
  files: FileMap;
  importName: string;
  selectedMainFile: string | undefined;
  error: Error | undefined;
  progress: { processed: number; total: number };
  buildId: string | undefined;
};

/**
 * Import Disk Machine Input
 */
type ImportDiskInput = {
  parentRef?: AnyActorRef;
};

/**
 * Import Disk Machine Events
 */
type ImportDiskEventInternal =
  | { type: 'processFiles'; files: FileList | File[] }
  | { type: 'processDataTransfer'; items: DataTransferItemList }
  | { type: 'processZip'; file: File }
  | { type: 'updateProgress'; processed: number; total: number }
  | { type: 'selectMainFile'; file: string }
  | { type: 'confirmImport' }
  | { type: 'retry' }
  | { type: 'reset' };

/**
 * Import Disk Machine Emitted Events
 */
type ImportDiskEmitted =
  | { type: 'progress'; processed: number; total: number }
  | { type: 'filesReady'; files: FileMap; importName: string }
  | { type: 'error'; error: Error };

// Actor output types
type FilesReadResult = { type: 'filesRead'; files: FileMap; importName: string };
type BuildCreatedResult = { type: 'buildCreated'; buildId: string };

/**
 * Read files actor - reads files from FileList
 */
const readFilesActor = fromPromise<
  FilesReadResult,
  { files: FileList | File[]; onProgress: (processed: number, total: number) => void }
>(async ({ input }) => {
  const files = await readFromFileList(input.files, input.onProgress);
  const importName = getImportName(files);

  return { type: 'filesRead', files, importName };
});

/**
 * Read data transfer actor - reads files from DataTransferItemList (drag-drop)
 */
const readDataTransferActor = fromPromise<
  FilesReadResult,
  { items: DataTransferItemList; onProgress: (processed: number, total: number) => void }
>(async ({ input }) => {
  const files = await readFromDataTransfer(input.items, input.onProgress);
  const importName = getImportName(files);

  return { type: 'filesRead', files, importName };
});

/**
 * Extract ZIP actor - extracts files from a ZIP blob with smart path normalization
 */
const extractZipActor = fromPromise<
  FilesReadResult,
  { file: File; onProgress: (processed: number, total: number) => void }
>(async ({ input }) => {
  const zip = await JSZip.loadAsync(input.file);
  const files: FileMap = new Map();

  // Get all file entries (excluding directories)
  const fileEntries = Object.entries(zip.files).filter(([, file]) => !file.dir);
  const totalFiles = fileEntries.length;
  let processedFiles = 0;

  // Process each file sequentially for progress tracking
  for (const [path, file] of fileEntries) {
    // eslint-disable-next-line no-await-in-loop -- processing files sequentially for progress tracking
    const content = (await file.async('uint8array')) as Uint8Array<ArrayBuffer>;
    files.set(path, {
      filename: path,
      content,
    });

    processedFiles++;
    input.onProgress(processedFiles, totalFiles);
  }

  // Apply smart path normalization (strips common root if present)
  const normalizedFiles = normalizeFilePaths(files);
  const importName = getImportName(normalizedFiles, input.file.name);

  return { type: 'filesRead', files: normalizedFiles, importName };
});

/**
 * Create build actor - placeholder that should be provided by the route
 */
const createBuildActor = fromPromise<BuildCreatedResult, { importName: string; mainFile: string; files: FileMap }>(
  async () => {
    throw new Error('createBuildActor must be provided by the route');
  },
);

const importDiskActors = {
  readFilesActor,
  readDataTransferActor,
  extractZipActor,
  createBuildActor,
} as const;

type ImportDiskActorNames = keyof typeof importDiskActors;
type ImportDiskEventExternal = OutputFrom<(typeof importDiskActors)[ImportDiskActorNames]>;
type ImportDiskEventExternalDone = DoneActorEvent<ImportDiskEventExternal, ImportDiskActorNames>;
type ImportDiskEvent = ImportDiskEventExternalDone | ImportDiskEventInternal;

/**
 * Import Disk Machine
 *
 * Manages importing files from disk (files, folders, or ZIP archives).
 *
 * States:
 * - idle: Waiting for files to process
 * - reading: Reading files from File API
 * - extracting: Extracting files from ZIP archive
 * - selectingMainFile: User selects the main file
 * - creating: Creating the build
 * - success: Import completed successfully
 * - error: An error occurred during import
 */
export const importDiskMachine = setup({
  types: {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    context: {} as ImportDiskContext,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    events: {} as ImportDiskEvent,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    input: {} as ImportDiskInput,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    emitted: {} as ImportDiskEmitted,
  },
  actors: importDiskActors,
  guards: {
    hasSelectedMainFile({ context }) {
      return context.selectedMainFile !== undefined && context.selectedMainFile.length > 0;
    },
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
    setProgress: assign({
      progress({ event }) {
        assertEvent(event, 'updateProgress');

        return { processed: event.processed, total: event.total };
      },
    }),
    setFilesFromResult: assign({
      files({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'filesRead');
        return event.output.files;
      },
      importName({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'filesRead');
        return event.output.importName;
      },
    }),
    initializeSelectedMainFile: assign({
      selectedMainFile({ context }) {
        const fileNames = [...context.files.keys()];
        return findMainFile(fileNames);
      },
    }),
    setSelectedMainFile: assign({
      selectedMainFile({ event }) {
        assertEvent(event, 'selectMainFile');

        return event.file;
      },
    }),
    setBuildId: assign({
      buildId({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'buildCreated');
        return event.output.buildId;
      },
    }),
    reset: assign({
      files: new Map(),
      importName: 'Uploaded Files',
      selectedMainFile: undefined,
      error: undefined,
      progress: { processed: 0, total: 0 },
      buildId: undefined,
    }),
    emitProgress: emit(({ context }) => ({
      type: 'progress' as const,
      processed: context.progress.processed,
      total: context.progress.total,
    })),
    emitFilesReady: emit(({ context }) => ({
      type: 'filesReady' as const,
      files: context.files,
      importName: context.importName,
    })),
    emitError: emit(({ context }) => ({
      type: 'error' as const,
      error: context.error ?? new Error('Unknown error'),
    })),
  },
}).createMachine({
  id: 'importDisk',
  context: ({ input }) => ({
    parentRef: input.parentRef,
    files: new Map(),
    importName: 'Uploaded Files',
    selectedMainFile: undefined,
    error: undefined,
    progress: { processed: 0, total: 0 },
    buildId: undefined,
  }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        processFiles: {
          target: 'reading',
        },
        processDataTransfer: {
          target: 'readingDataTransfer',
        },
        processZip: {
          target: 'extracting',
        },
        reset: {
          actions: 'reset',
        },
      },
    },
    reading: {
      entry: 'clearError',
      invoke: {
        src: 'readFilesActor',
        input({ event, self }) {
          assertEvent(event, 'processFiles');

          return {
            files: event.files,
            onProgress(processed: number, total: number) {
              self.send({ type: 'updateProgress', processed, total });
            },
          };
        },
        onDone: {
          target: 'selectingMainFile',
          actions: ['setFilesFromResult', 'initializeSelectedMainFile', 'emitFilesReady'],
        },
        onError: {
          target: 'error',
          actions: ['setError', 'emitError'],
        },
      },
      on: {
        updateProgress: {
          actions: ['setProgress', 'emitProgress'],
        },
      },
    },
    readingDataTransfer: {
      entry: 'clearError',
      invoke: {
        src: 'readDataTransferActor',
        input({ event, self }) {
          assertEvent(event, 'processDataTransfer');

          return {
            items: event.items,
            onProgress(processed: number, total: number) {
              self.send({ type: 'updateProgress', processed, total });
            },
          };
        },
        onDone: {
          target: 'selectingMainFile',
          actions: ['setFilesFromResult', 'initializeSelectedMainFile', 'emitFilesReady'],
        },
        onError: {
          target: 'error',
          actions: ['setError', 'emitError'],
        },
      },
      on: {
        updateProgress: {
          actions: ['setProgress', 'emitProgress'],
        },
      },
    },
    extracting: {
      entry: 'clearError',
      invoke: {
        src: 'extractZipActor',
        input({ event, self }) {
          assertEvent(event, 'processZip');

          return {
            file: event.file,
            onProgress(processed: number, total: number) {
              self.send({ type: 'updateProgress', processed, total });
            },
          };
        },
        onDone: {
          target: 'selectingMainFile',
          actions: ['setFilesFromResult', 'initializeSelectedMainFile', 'emitFilesReady'],
        },
        onError: {
          target: 'error',
          actions: ['setError', 'emitError'],
        },
      },
      on: {
        updateProgress: {
          actions: ['setProgress', 'emitProgress'],
        },
      },
    },
    selectingMainFile: {
      on: {
        selectMainFile: {
          actions: 'setSelectedMainFile',
        },
        confirmImport: {
          target: 'creating',
          guard: 'hasSelectedMainFile',
        },
        reset: {
          target: 'idle',
          actions: 'reset',
        },
      },
    },
    creating: {
      invoke: {
        src: 'createBuildActor',
        input: ({ context }) => ({
          importName: context.importName,
          mainFile: context.selectedMainFile!,
          files: context.files,
        }),
        onDone: {
          target: 'success',
          actions: 'setBuildId',
        },
        onError: {
          target: 'error',
          actions: ['setError', 'emitError'],
        },
      },
    },
    success: {
      type: 'final',
    },
    error: {
      on: {
        retry: {
          target: 'idle',
          actions: 'clearError',
        },
        reset: {
          target: 'idle',
          actions: 'reset',
        },
      },
    },
  },
});

export type ImportDiskMachineActor = typeof importDiskMachine;
