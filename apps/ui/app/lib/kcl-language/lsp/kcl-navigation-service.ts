/**
 * KCL Navigation Service
 *
 * Intercepts Monaco's definition navigation and routes it through the file explorer system.
 * This enables Cmd+Click to open KCL files in the application's editor tabs.
 */

import type * as Monaco from 'monaco-editor';
import type { AnyActorRef } from 'xstate';
import { codeLanguages } from '@taucad/types/constants';
import { createKclLogger } from '#lib/kcl-language/lsp/kcl-logs.js';

const log = createKclLogger('Navigation');

type FileManagerApi = {
  readFile: (path: string) => Promise<Uint8Array>;
};

type NavigationServiceOptions = {
  /** Reference to the file explorer state machine actor */
  fileExplorerRef: AnyActorRef;
  /** File manager for reading file contents */
  fileManager: FileManagerApi;
  /** Decode file content from Uint8Array to string */
  decodeTextFile: (data: Uint8Array) => string;
};

type PendingNavigation = {
  path: string;
  lineNumber: number;
  column: number;
};

/**
 * Registers a navigation interceptor on the Monaco editor to handle
 * Cmd+Click navigation for KCL files.
 */
export function registerKclNavigation(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  options: NavigationServiceOptions,
): Monaco.IDisposable {
  const { fileExplorerRef, fileManager, decodeTextFile } = options;

  // Store pending navigation info for position jumping after file opens
  let pendingNavigation: PendingNavigation | undefined;

  // Subscribe to file explorer events to jump to position after file opens
  const unsubscribe = fileExplorerRef.on('fileOpened', (event: { path: string }) => {
    if (pendingNavigation && event.path === pendingNavigation.path) {
      // Capture navigation info to avoid race condition if another navigation
      // request arrives before the timeout fires
      const capturedNavigation = pendingNavigation;
      pendingNavigation = undefined;

      // Small delay to ensure the editor has mounted and model is ready
      setTimeout(() => {
        const targetUri = monaco.Uri.file(`/${capturedNavigation.path}`);
        const targetModel = monaco.editor.getModel(targetUri);

        if (targetModel) {
          const editors = monaco.editor.getEditors();
          const targetEditor = editors.find((editorInstance) => editorInstance.getModel() === targetModel);

          if (targetEditor) {
            const position = new monaco.Position(capturedNavigation.lineNumber, capturedNavigation.column);
            targetEditor.setPosition(position);
            targetEditor.revealPositionInCenter(position);
            targetEditor.focus();
          }
        }
      }, 100);
    }
  });

  // Override the editor's openCodeEditor command to intercept definition navigation
  // Monaco's go-to-definition action triggers this internal service
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Monaco internal API
  const editorService = getEditorService(editor);

  if (!editorService) {
    log.warn('Could not access editor service, navigation may not work');

    return {
      dispose() {
        unsubscribe.unsubscribe();
      },
    };
  }

  // Store original function
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Monaco internal API
  const originalOpenCodeEditor = editorService.openCodeEditor?.bind(editorService);

  if (!originalOpenCodeEditor) {
    log.warn('openCodeEditor not available, navigation may not work');

    return {
      dispose() {
        unsubscribe.unsubscribe();
      },
    };
  }

  // Override openCodeEditor to intercept navigation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Monaco internal API
  editorService.openCodeEditor = async (input: any, source: any, sideBySide?: boolean): Promise<any> => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Monaco internal API
    const resource = input?.resource;

    log.debug('openCodeEditor called with resource:', resource);

    if (!resource) {
      log.debug('No resource, using default behavior');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- Monaco internal API
      return originalOpenCodeEditor(input, source, sideBySide);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Monaco internal API
    const { path: uriPath, scheme }: { path: string; scheme: string } = resource;

    log.debug('Resource scheme:', scheme, 'path:', uriPath);

    // Check if this is a file navigation
    if (scheme !== 'file') {
      log.debug('Non-file scheme, using default behavior');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- Monaco internal API
      return originalOpenCodeEditor(input, source, sideBySide);
    }

    // Extract relative path (remove leading slash)
    const relativePath = uriPath.startsWith('/') ? uriPath.slice(1) : uriPath;

    log.debug('Relative path:', relativePath);

    // Check if this is a KCL file or if the model exists with KCL language
    const isKclFile = relativePath.endsWith('.kcl');
    const uri = monaco.Uri.file(`/${relativePath}`);
    const existingModel = monaco.editor.getModel(uri);
    const isKclModel = existingModel?.getLanguageId() === codeLanguages.kcl;

    log.debug('isKclFile:', isKclFile, 'isKclModel:', isKclModel);

    if (!isKclFile && !isKclModel) {
      // Not a KCL file, use default behavior
      log.debug('Not a KCL file, using default behavior');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- Monaco internal API
      return originalOpenCodeEditor(input, source, sideBySide);
    }

    // Extract position from options
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Monaco internal API
    const selection = input?.options?.selection;
    const lineNumber = (selection?.startLineNumber as number | undefined) ?? 1;
    const column = (selection?.startColumn as number | undefined) ?? 1;

    log.debug('Target position:', lineNumber, column);

    // Check if this is same-file navigation (e.g., jumping to a variable declaration)
    const currentModel = editor.getModel();
    const currentPath = currentModel?.uri.path;
    const targetPath = `/${relativePath}`;

    log.debug('Current path:', currentPath, 'Target path:', targetPath);

    if (currentPath === targetPath) {
      // Same-file navigation: jump directly to the position
      log.debug('Same-file navigation, jumping to position:', lineNumber, column);
      editor.setPosition({ lineNumber, column });
      editor.revealPositionInCenter({ lineNumber, column });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Monaco internal API
      return source;
    }

    // Store pending navigation for position jumping
    pendingNavigation = { path: relativePath, lineNumber, column };

    log.debug('Pending navigation set:', pendingNavigation);

    // Ensure the Monaco model exists for the target file
    if (!existingModel) {
      log.debug('No existing model, loading file:', relativePath);
      try {
        const content = await fileManager.readFile(relativePath);
        const textContent = decodeTextFile(content);
        monaco.editor.createModel(textContent, codeLanguages.kcl, uri);
        log.debug('Created Monaco model for:', relativePath);
      } catch (error: unknown) {
        log.error('Failed to load file:', relativePath, error);
        pendingNavigation = undefined;

        // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Monaco internal API
        return source;
      }
    }

    // Open the file through the file explorer
    log.debug('Opening file through file explorer:', relativePath);
    fileExplorerRef.send({ type: 'openFile', path: relativePath });

    // Return the source editor to prevent Monaco from trying to navigate internally
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Monaco internal API
    return source;
  };

  return {
    dispose() {
      // Restore original function
      if (originalOpenCodeEditor) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Monaco internal API
        editorService.openCodeEditor = originalOpenCodeEditor;
      }

      unsubscribe.unsubscribe();
    },
  };
}

/**
 * Get the editor service from a Monaco editor instance.
 * This accesses Monaco's internal API for intercepting navigation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Monaco internal API
function getEditorService(editor: Monaco.editor.IStandaloneCodeEditor): any {
  // Access the internal _codeEditorService
  // This is an undocumented API but necessary for intercepting go-to-definition navigation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Monaco internal API
  return (editor as any)._codeEditorService;
}
