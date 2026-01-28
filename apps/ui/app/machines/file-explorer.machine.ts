import { assertEvent, setup, enqueueActions } from 'xstate';
import type { FileStatus } from '@taucad/types';

export type FileItem = {
  id: string;
  name: string;
  path: string;
  content: Uint8Array<ArrayBuffer>;
  language?: string;
  isDirectory?: boolean;
  children?: FileItem[];
  gitStatus?: FileStatus;
};

export type OpenFile = {
  path: string;
  name: string;
};

// Interface defining the context for the file explorer machine
type FileExplorerContext = {
  openFiles: OpenFile[];
  activeFilePath: string | undefined;
};

/**
 * Source of a file open event.
 * - 'user': User-initiated action (e.g., clicked on file in tree, breadcrumb, link) - should open editor panel
 * - 'machine': Programmatic action (e.g., build load, chat tool) - should not auto-open editor panel
 */
export type FileOpenSource = 'user' | 'machine';

// Define the types of events the machine can receive
type FileExplorerEvent =
  | { type: 'openFile'; path: string; source: FileOpenSource; lineNumber?: number; column?: number }
  | { type: 'closeFile'; path: string }
  | { type: 'renameFile'; oldPath: string; newPath: string }
  | { type: 'setActiveFile'; path: string }
  | { type: 'closeAll' };

type FileExplorerEmitted = {
  type: 'fileOpened';
  path: string;
  lineNumber?: number;
  column?: number;
  source?: FileOpenSource;
};

/**
 * File Explorer Machine
 *
 * This machine manages the state of the file explorer:
 * - Handles opening and closing files
 * - Tracks active file
 * - Pure UI state management (no parent coordination)
 */
export const fileExplorerMachine = setup({
  types: {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    context: {} as FileExplorerContext,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    events: {} as FileExplorerEvent,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    emitted: {} as FileExplorerEmitted,
  },
  actions: {
    openFile: enqueueActions(({ enqueue, event, context }) => {
      assertEvent(event, 'openFile');

      const existingFile = context.openFiles.find((f) => f.path === event.path);
      if (existingFile) {
        // File already open and active - still emit to allow line navigation
        if (context.activeFilePath === event.path) {
          enqueue.emit({
            type: 'fileOpened' as const,
            path: event.path,
            lineNumber: event.lineNumber,
            column: event.column,
            source: event.source,
          });
          return;
        }

        // File open but not active - set as active and emit
        enqueue.assign({
          activeFilePath: event.path,
        });
        enqueue.emit({
          type: 'fileOpened' as const,
          path: event.path,
          lineNumber: event.lineNumber,
          column: event.column,
          source: event.source,
        });
        return;
      }

      // Open new file
      const newFile: OpenFile = {
        path: event.path,
        name: event.path.split('/').pop() ?? event.path,
      };

      enqueue.assign({
        openFiles: [...context.openFiles, newFile],
        activeFilePath: newFile.path,
      });

      enqueue.emit({
        type: 'fileOpened' as const,
        path: event.path,
        lineNumber: event.lineNumber,
        column: event.column,
        source: event.source,
      });
    }),

    closeFile: enqueueActions(({ enqueue, event, context }) => {
      assertEvent(event, 'closeFile');

      const updatedOpenFiles = context.openFiles.filter((file) => file.path !== event.path);
      let newActiveFilePath = context.activeFilePath;

      // If closing the active file, set new active file
      if (context.activeFilePath === event.path) {
        newActiveFilePath = updatedOpenFiles.at(-1)?.path;

        // Emit fileOpened for the new active file (if any)
        if (newActiveFilePath) {
          enqueue.emit({
            type: 'fileOpened' as const,
            path: newActiveFilePath,
          });
        }
      }

      enqueue.assign({
        openFiles: updatedOpenFiles,
        activeFilePath: newActiveFilePath,
      });
    }),

    setActiveFile: enqueueActions(({ enqueue, event, context }) => {
      assertEvent(event, 'setActiveFile');

      // Already active - nothing to do
      if (context.activeFilePath === event.path) {
        return;
      }

      enqueue.assign({
        activeFilePath: event.path,
      });

      // Emit fileOpened for the new active file
      enqueue.emit({
        type: 'fileOpened' as const,
        path: event.path,
      });
    }),

    closeAll: enqueueActions(({ enqueue }) => {
      enqueue.assign({
        openFiles: [],
        activeFilePath: undefined,
      });
    }),

    // Rename a file atomically without triggering fallback behavior
    // This updates the path in place, preserving the file's position and active state
    renameFile: enqueueActions(({ enqueue, event, context }) => {
      assertEvent(event, 'renameFile');

      const { oldPath, newPath } = event;

      // Update the path in openFiles
      const updatedOpenFiles = context.openFiles.map((file) => {
        if (file.path === oldPath) {
          return {
            ...file,
            path: newPath,
            name: newPath.split('/').pop() ?? newPath,
          };
        }

        // Also handle nested files (for directory renames)
        if (file.path.startsWith(`${oldPath}/`)) {
          const relativePath = file.path.slice(oldPath.length);
          const newFilePath = `${newPath}${relativePath}`;
          return {
            ...file,
            path: newFilePath,
            name: newFilePath.split('/').pop() ?? newFilePath,
          };
        }

        return file;
      });

      // Update activeFilePath if it was the renamed file or a nested file
      let newActiveFilePath = context.activeFilePath;
      if (context.activeFilePath === oldPath) {
        newActiveFilePath = newPath;
      } else if (context.activeFilePath?.startsWith(`${oldPath}/`)) {
        const relativePath = context.activeFilePath.slice(oldPath.length);
        newActiveFilePath = `${newPath}${relativePath}`;
      }

      enqueue.assign({
        openFiles: updatedOpenFiles,
        activeFilePath: newActiveFilePath,
      });

      // Emit fileOpened for the renamed file so CAD machine updates its reference
      if (
        newActiveFilePath &&
        (context.activeFilePath === oldPath || context.activeFilePath?.startsWith(`${oldPath}/`))
      ) {
        enqueue.emit({
          type: 'fileOpened' as const,
          path: newActiveFilePath,
        });
      }
    }),
  },
}).createMachine({
  id: 'fileExplorer',
  context: {
    openFiles: [],
    activeFilePath: undefined,
  },
  initial: 'idle',
  states: {
    idle: {
      on: {
        openFile: {
          actions: 'openFile',
        },
        closeFile: {
          actions: 'closeFile',
        },
        renameFile: {
          actions: 'renameFile',
        },
        setActiveFile: {
          actions: 'setActiveFile',
        },
        closeAll: {
          actions: 'closeAll',
        },
      },
    },
  },
});

export type { FileExplorerEmitted };
