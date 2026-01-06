import { useMemo } from 'react';
import { useSelector } from '@xstate/react';
import type { ChatSnapshot } from '@taucad/chat';
import { useBuild } from '#hooks/use-build.js';
import { useFilesystemSnapshot } from '#hooks/use-file-manager.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';

/**
 * Hook to get the current chat snapshot for message context.
 * This provides the LLM with awareness of what the user is currently working on.
 *
 * The snapshot includes:
 * - filesystem: Token-efficient tree representation of the project
 * - activeFile: The file currently being rendered by the CAD engine
 * - openFiles: The files currently open in editor tabs
 *
 * Each component can be toggled via user preferences (cookies).
 *
 * @returns ChatSnapshot object or undefined if no context is enabled/available
 */
export function useChatSnapshot(): ChatSnapshot | undefined {
  // Get the file explorer ref from build context (may not be available outside build pages)
  const buildContext = useBuild({ enableNoContext: true });
  const fileExplorerRef = buildContext?.fileExplorerRef;

  // Get filesystem snapshot
  const filesystemSnapshot = useFilesystemSnapshot();

  // Get editor state from file explorer
  const editorState = useSelector(
    fileExplorerRef,
    (state) => {
      if (!state) {
        return { activeFilePath: undefined, openFiles: [] };
      }

      return {
        activeFilePath: state.context.activeFilePath,
        openFiles: state.context.openFiles,
      };
    },
    // Equality function to prevent unnecessary re-renders
    (previous, next) =>
      previous.activeFilePath === next.activeFilePath &&
      previous.openFiles.length === next.openFiles.length &&
      previous.openFiles.every((file, index) => file.path === next.openFiles[index]?.path),
  );

  // Read user preferences from cookies (default to true for all)
  const [includeFilesystem] = useCookie(cookieName.chatCtxFs, true);
  const [includeActiveFile] = useCookie(cookieName.chatCtxActive, true);
  const [includeOpenFiles] = useCookie(cookieName.chatCtxOpen, true);

  // Build the snapshot based on user preferences
  return useMemo((): ChatSnapshot | undefined => {
    const snapshot: ChatSnapshot = {};

    // Add filesystem if enabled and available
    if (includeFilesystem && filesystemSnapshot) {
      snapshot.filesystem = filesystemSnapshot;
    }

    // Add active file if enabled and available
    if (includeActiveFile && editorState.activeFilePath) {
      snapshot.activeFile = {
        path: editorState.activeFilePath,
        name: editorState.activeFilePath.split('/').pop() ?? editorState.activeFilePath,
      };
    }

    // Add open files if enabled and available
    if (includeOpenFiles && editorState.openFiles.length > 0) {
      snapshot.openFiles = editorState.openFiles.map((file) => ({
        path: file.path,
        name: file.name,
      }));
    }

    // Return undefined if no context is included
    if (Object.keys(snapshot).length === 0) {
      return undefined;
    }

    return snapshot;
  }, [
    includeFilesystem,
    filesystemSnapshot,
    includeActiveFile,
    editorState.activeFilePath,
    includeOpenFiles,
    editorState.openFiles,
  ]);
}

