import { memo, useCallback, useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { useMonaco } from '@monaco-editor/react';
import { useSelector } from '@xstate/react';
import { FileCode } from 'lucide-react';
import { languageFromExtension } from '@taucad/types/constants';
import { CodeEditor } from '#components/code/code-editor.js';
import { cn } from '#utils/ui.utils.js';
import { HammerAnimation } from '#components/hammer-animation.js';
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

export const ChatEditor = memo(function ({ className }: { readonly className?: string }): React.JSX.Element {
  const monaco = useMonaco();
  const { fileExplorerRef: fileExplorerActor, cadRef: cadActor, buildRef } = useBuild();
  const fileManager = useFileManager();
  const { fileManagerRef } = useFileManager();
  const [forceOpenBinary, setForceOpenBinary] = useState(false);

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
        type: 'setCodeErrors',
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
      cadActor.send({ type: 'setCodeErrors', errors: [] });
    }
  }, [monaco, cadActor]);

  // Get kernel errors for active file from CAD machine (errors stored per-file as an array)
  const kernelErrors = useSelector(cadActor, (state) => {
    if (!activeFile) {
      return undefined;
    }

    return state.context.kernelErrors.get(activeFile.path);
  });

  // Show kernel errors as Monaco markers - only for the active file
  useEffect(() => {
    if (!monaco || !activeFile) {
      return;
    }

    const uri = monaco.Uri.file(`/${activeFile.path}`);
    const model = monaco.editor.getModel(uri);

    if (!model) {
      return;
    }

    // Map kernel errors to Monaco markers (only for errors with location info)
    const markers = (kernelErrors ?? [])
      .filter((kernelError) => kernelError.location)
      .map((kernelError) => ({
        startLineNumber: kernelError.location!.startLineNumber,
        startColumn: kernelError.location!.startColumn,
        endLineNumber: kernelError.location!.endLineNumber ?? kernelError.location!.startLineNumber,
        endColumn: kernelError.location!.endColumn ?? kernelError.location!.startColumn + 1,
        message: kernelError.message,
        severity: monaco.MarkerSeverity.Error,
      }));

    monaco.editor.setModelMarkers(model, 'kernel', markers);
  }, [monaco, kernelErrors, activeFile]);

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
      const uri = monaco.Uri.file(`/${path}`);

      // Find existing Monaco model for this file
      const existingModel = monaco.editor.getModel(uri);

      if (existingModel) {
        // Update existing model if content is different
        if (existingModel.getValue() !== newContent) {
          existingModel.setValue(newContent);
        }
      } else if (source === 'file-tree') {
        // For file-tree operations (user created/uploaded), create a new model
        // External sources (chat AI) should not auto-open files that weren't already open
        const extension = getFileExtension(path);
        const language = languageFromExtension[extension as keyof typeof languageFromExtension];
        monaco.editor.createModel(newContent, language, uri);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [monaco, fileManagerRef]);

  return (
    <div className={cn('flex h-full flex-col bg-background', className)}>
      <ChatEditorTabs />
      <ChatEditorBreadcrumbs />
      {activeFile ? (
        activeFile.isBinary && !forceOpenBinary ? (
          <ChatEditorBinaryWarning onForceOpen={handleForceOpenBinary} />
        ) : (
          <CodeEditor
            loading={<HammerAnimation className="size-20 animate-spin stroke-1 text-primary ease-in-out" />}
            className="h-full bg-background"
            defaultLanguage={activeFile.language}
            defaultValue={editorContent}
            fileExplorerRef={fileExplorerActor}
            fileManager={fileManager}
            path={activeFile.path}
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
