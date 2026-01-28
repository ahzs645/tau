import { memo, useCallback, useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { useMonaco } from '@monaco-editor/react';
import { useSelector } from '@xstate/react';
import { FileCode } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { languageFromExtension } from '@taucad/types/constants';
import type { IssueSeverity } from '@taucad/types';
import { CodeEditor } from '#components/code/code-editor.client.js';
import { cn } from '#utils/ui.utils.js';
import { Loader } from '#components/ui/loader.js';
import { registerMonaco } from '#lib/monaco.js';
import { setKclLspFileManager } from '#lib/kcl-language/kcl-register-language.js';
import { ChatEditorBreadcrumbs } from '#routes/builds_.$id/chat-editor-breadcrumbs.js';
import { useBuild } from '#hooks/use-build.js';
import { ChatEditorTabs } from '#routes/builds_.$id/chat-editor-tabs.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';
import { EmptyItems } from '#components/ui/empty-items.js';
import { getFileExtension, isBinaryFile, decodeTextFile, encodeTextFile } from '#utils/filesystem.utils.js';
import { ChatEditorBinaryWarning } from '#routes/builds_.$id/chat-editor-binary-warning.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { useViewContext } from '#routes/builds_.$id/chat-interface-view-context.js';

/**
 * Build prefix for Monaco URIs, matching the file manager's root directory structure.
 */
const buildsPrefix = '/builds';

/**
 * Map IssueSeverity to Monaco MarkerSeverity.
 */
function getMarkerSeverity(monaco: typeof Monaco, severity: IssueSeverity | undefined): Monaco.MarkerSeverity {
  switch (severity) {
    case 'warning': {
      return monaco.MarkerSeverity.Warning;
    }

    case 'info': {
      return monaco.MarkerSeverity.Info;
    }

    case 'error': {
      return monaco.MarkerSeverity.Error;
    }

    default: {
      return monaco.MarkerSeverity.Error;
    }
  }
}

/**
 * Create a Monaco URI with build namespace to ensure file isolation between builds.
 * This prevents stale file content from appearing when switching builds.
 */
function createBuildNamespacedUri(monaco: typeof Monaco, buildId: string, relativePath: string): Monaco.Uri {
  return monaco.Uri.file(`${buildsPrefix}/${buildId}/${relativePath}`);
}

/**
 * Create a path string with build namespace for the Monaco Editor path prop.
 */
function createBuildNamespacedPath(buildId: string, relativePath: string): string {
  return `${buildsPrefix}/${buildId}/${relativePath}`;
}

export const ChatEditor = memo(function ({ className }: { readonly className?: string }): React.JSX.Element {
  const monaco = useMonaco();
  const { buildId, fileExplorerRef: fileExplorerActor, cadRef: cadActor, buildRef } = useBuild();
  const fileManager = useFileManager();
  const { fileManagerRef } = useFileManager();
  const [forceOpenBinary, setForceOpenBinary] = useState(false);
  const { setIsEditorOpen } = useViewContext();

  // Get active file path from file explorer
  const activeFilePath = useSelector(fileExplorerActor, (state) => {
    return state.context.activeFilePath;
  });

  const activeFile = useSelector(fileManagerRef, (state) => {
    const { openFiles } = state.context;

    if (!activeFilePath) {
      return undefined;
    }

    const fileContent = openFiles.get(activeFilePath);
    if (!fileContent) {
      return undefined;
    }

    const name = activeFilePath.split('/').pop() ?? activeFilePath;

    return {
      path: activeFilePath,
      name,
      isBinary: isBinaryFile(name, fileContent),
      content: fileContent,
      language: languageFromExtension[getFileExtension(name) as keyof typeof languageFromExtension],
    };
  });

  // Reset force open when file path changes (switching files)
  useEffect(() => {
    setForceOpenBinary(false);
  }, [activeFile?.path]);

  // Sync file preview preference between cookie and build machine
  const [enableFilePreview] = useCookie<boolean>(cookieName.cadFilePreview, true);
  const enableFilePreviewInMachine = useSelector(buildRef, (state) => state.context.enableFilePreview);

  // Sync cookie to build machine on mount and when cookie changes
  useEffect(() => {
    if (enableFilePreview !== enableFilePreviewInMachine) {
      buildRef.send({ type: 'setEnableFilePreview', enabled: enableFilePreview });
    }
  }, [enableFilePreview, enableFilePreviewInMachine, buildRef]);

  const handleCodeChange = useCallback(
    (value: ComponentProps<typeof CodeEditor>['value']) => {
      if (!activeFile) {
        return;
      }

      // Encode string → Uint8Array and write directly to fileManager
      void fileManager.writeFile(activeFile.path, encodeTextFile(value ?? ''), { source: 'editor' });
    },
    [activeFile, fileManager],
  );

  // Decode Uint8Array → string for editor
  const editorContent = activeFile ? decodeTextFile(activeFile.content) : '';

  const handleForceOpenBinary = useCallback(() => {
    setForceOpenBinary(true);
  }, []);

  useEffect(() => {
    if (monaco) {
      void registerMonaco(monaco);
    }
  }, [monaco]);

  // Set file manager on the KCL LSP client for import resolution
  useEffect(() => {
    setKclLspFileManager({
      readFile: async (path: string) => fileManager.readFile(path),
      exists: async (path: string) => fileManager.exists(path),
      readdir: async (path: string) => fileManager.readdir(path),
    });
  }, [fileManager]);

  const handleValidate = useCallback(() => {
    const errors = monaco?.editor.getModelMarkers({});
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- monaco has import issues. This is safe.
    const filteredErrors = errors?.filter((error) => error.severity === 8);
    if (filteredErrors?.length) {
      // Send errors to the CAD actor
      cadActor.send({
        type: 'setCodeIssues',
        errors: filteredErrors.map((error) => ({
          startLineNumber: error.startLineNumber,
          startColumn: error.startColumn,
          message: error.message,
          severity: error.severity,
          endLineNumber: error.endLineNumber,
          endColumn: error.endColumn,
        })),
      });
    } else {
      // Clear errors when there are none
      cadActor.send({ type: 'setCodeIssues', errors: [] });
    }
  }, [monaco, cadActor]);

  // Get kernel issues for active file from CAD machine (errors stored per-file as an array)
  const kernelIssues = useSelector(cadActor, (state) => {
    if (!activeFile) {
      return undefined;
    }

    return state.context.kernelIssues.get(activeFile.path);
  });

  // Show kernel issues as Monaco markers - only for the active file
  useEffect(() => {
    if (!monaco || !activeFile) {
      return;
    }

    const uri = createBuildNamespacedUri(monaco, buildId, activeFile.path);
    const model = monaco.editor.getModel(uri);

    if (!model) {
      return;
    }

    // Map kernel issues to Monaco markers (only for issues with location info)
    const markers = (kernelIssues ?? [])
      .filter((kernelIssue) => kernelIssue.location)
      .map((kernelIssue) => ({
        startLineNumber: kernelIssue.location!.startLineNumber,
        startColumn: kernelIssue.location!.startColumn,
        endLineNumber: kernelIssue.location!.endLineNumber ?? kernelIssue.location!.startLineNumber,
        endColumn: kernelIssue.location!.endColumn ?? kernelIssue.location!.startColumn + 1,
        message: kernelIssue.message,
        severity: getMarkerSeverity(monaco, kernelIssue.severity),
      }));

    monaco.editor.setModelMarkers(model, 'kernel', markers);
  }, [monaco, kernelIssues, activeFile, buildId]);

  // Subscribe to file writes and update Monaco model for non-editor sources
  useEffect(() => {
    if (!monaco) {
      return;
    }

    const subscription = fileManagerRef.on('fileWritten', (emittedEvent) => {
      // Skip Monaco updates for editor typing to avoid recursion
      if (emittedEvent.source === 'editor') {
        return;
      }

      const { path, data, source } = emittedEvent;
      const newContent = decodeTextFile(data);
      const uri = createBuildNamespacedUri(monaco, buildId, path);

      // Find existing Monaco model for this file
      const existingModel = monaco.editor.getModel(uri);

      if (existingModel) {
        // Update existing model if content is different
        if (existingModel.getValue() !== newContent) {
          // Push a stack element to create a new undo stop point
          existingModel.pushStackElement();

          // Apply the edit as a proper undo-able operation
          existingModel.pushEditOperations(
            [], // No cursor state to preserve
            [
              {
                range: existingModel.getFullModelRange(),
                text: newContent,
              },
            ],
            () => null, // No cursor computation needed
          );

          // Push another stack element to close this undo group
          existingModel.pushStackElement();
        }
      } else if (source === 'user') {
        // For user operations (user created/uploaded), create a new model
        // Machine sources (chat AI) should not auto-open files that weren't already open
        const extension = getFileExtension(path);
        const language = languageFromExtension[extension as keyof typeof languageFromExtension];
        monaco.editor.createModel(newContent, language, uri);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [monaco, fileManagerRef, buildId]);

  // Subscribe to fileOpened events to open the editor panel and jump to specific line numbers
  useEffect(() => {
    if (!monaco) {
      return;
    }

    const subscription = fileExplorerActor.on('fileOpened', (event) => {
      // Only open the editor panel when the file was opened by user action
      // Machine sources (build load, chat tools) should not auto-open the editor panel
      if (event.source === 'user') {
        setIsEditorOpen(true);
      }

      // Only jump if a line number is specified
      const { lineNumber, column } = event;
      if (!lineNumber) {
        return;
      }

      // Defer Monaco navigation until after the layout has fully settled
      // Double rAF ensures we wait for both React render and browser layout/paint cycles
      // This prevents layout shifts when the editor panel is opening
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const uri = createBuildNamespacedUri(monaco, buildId, event.path);
          const model = monaco.editor.getModel(uri);

          if (model) {
            const editors = monaco.editor.getEditors();
            const targetEditor = editors.find((editorInstance) => editorInstance.getModel() === model);

            if (targetEditor) {
              const position = new monaco.Position(lineNumber, column ?? 1);
              targetEditor.setPosition(position);
              targetEditor.revealPositionInCenter(position);
              targetEditor.focus();
            }
          }
        });
      });
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [monaco, fileExplorerActor, buildId, setIsEditorOpen]);

  return (
    <div className={cn('flex h-full flex-col bg-background', className)}>
      <ChatEditorTabs />
      <ChatEditorBreadcrumbs />
      {activeFile ? (
        activeFile.isBinary && !forceOpenBinary ? (
          <ChatEditorBinaryWarning onForceOpen={handleForceOpenBinary} />
        ) : (
          <CodeEditor
            loading={<Loader className="size-20 stroke-1 text-primary" />}
            className="h-full bg-background"
            defaultLanguage={activeFile.language}
            defaultValue={editorContent}
            fileExplorerRef={fileExplorerActor}
            fileManager={fileManager}
            buildId={buildId}
            path={createBuildNamespacedPath(buildId, activeFile.path)}
            onChange={handleCodeChange}
            onValidate={handleValidate}
          />
        )
      ) : (
        <EmptyItems>
          <FileCode className="mb-4 size-12 stroke-1 text-muted-foreground" />
          <p className="text-base font-medium">No file selected</p>
          <p className="mt-1 text-xs text-muted-foreground/70">Select a file to start editing</p>
        </EmptyItems>
      )}
    </div>
  );
});
