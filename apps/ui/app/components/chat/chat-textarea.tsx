import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { createActor } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type { ChatTextareaProperties } from '#components/chat/chat-textarea-types.js';
import { useChatTextareaLogic } from '#components/chat/chat-textarea-types.js';
import { ChatTextareaDesktop } from '#components/chat/chat-textarea-desktop.js';
import { ChatTextareaMobile } from '#components/chat/chat-textarea-mobile.js';
import { useIsMobile } from '#hooks/use-mobile.js';
import { ClientOnly } from '#components/ui/utils/client-only.js';
import { ChatTextareaSkeleton } from '#components/chat/chat-textarea-skeleton.js';
import { useProject } from '#hooks/use-project.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { useChats } from '#hooks/use-chats.js';
import { useChatActions } from '#hooks/use-chat.js';
import { useImageQuality } from '#hooks/use-image-quality.js';
import { toast } from '#components/ui/sonner.js';
import { orthographicViews, screenshotRequestMachine } from '#machines/screenshot-request.machine.js';
import type { graphicsMachine } from '#machines/graphics.machine.js';
import type { ContextSuggestionItem } from '#components/chat/tiptap/suggestion-types.js';
import { takeScreenshotGroup } from '#components/chat/tiptap/context-suggestion.utils.js';

/**
 * Main chat textarea component that conditionally renders either the
 * desktop or mobile version based on the `useIsMobile()` hook.
 *
 * All logic is shared via the `useChatTextareaLogic` hook.
 * Project context data (treeService, chats) is fetched here and passed
 * as props to keep the memo'd desktop component free of internal subscription hooks,
 * preventing re-render cascades through Radix UI's composeRefs.
 */
export const ChatTextarea = memo(function ({
  ref,
  onSubmit,
  enableAutoFocus = true,
  onEscapePressed,
  onBlur,
  className,
  enableContextActions = true,
  enableKernelSelector = true,
  mode = 'main',
}: ChatTextareaProperties): React.JSX.Element {
  const isMobile = useIsMobile();
  const logic = useChatTextareaLogic({
    ref,
    onSubmit,
    enableAutoFocus,
    onEscapePressed,
    onBlur,
    mode,
  });

  const projectContext = useProject({ enableNoContext: true });
  const { treeService } = useFileManager();
  const { chats } = useChats(projectContext?.projectId ?? '');
  const { setDraftText: setMainDraftText, setEditDraftText } = useChatActions();

  const setDraftText = useCallback(
    (text: string) => {
      if (mode === 'main') {
        setMainDraftText(text);
      } else {
        setEditDraftText(text);
      }
    },
    [mode, setMainDraftText, setEditDraftText],
  );

  // Mutable ref populated by ChatTextareaDesktop so the imperative handle
  // can focus the Tiptap editor instead of the (non-existent) <textarea>
  const focusEditorRef = useRef<(() => void) | undefined>(undefined);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        if (focusEditorRef.current) {
          focusEditorRef.current();
        } else {
          logic.focusInput();
        }
      },
    }),
    [logic.focusInput],
  );

  const geometryUnits = projectContext?.geometryUnits;
  const mainEntryFile = projectContext?.mainEntryFile;
  const screenshotActionItems = useMemo((): ContextSuggestionItem[] => {
    if (!geometryUnits) {
      return [];
    }

    const items: ContextSuggestionItem[] = [
      {
        id: 'screenshot-current-view',
        label: 'Current view',
        chipType: 'screenshot',
        group: takeScreenshotGroup,
        isAction: true,
        screenshotAction: { type: 'single' },
      },
      {
        id: 'screenshot-orthographic',
        label: 'Orthographic views x 6',
        chipType: 'screenshot',
        group: takeScreenshotGroup,
        isAction: true,
        screenshotAction: { type: 'composite' },
      },
    ];

    for (const [entryFile] of geometryUnits) {
      if (entryFile === mainEntryFile) {
        continue;
      }
      const fileName = entryFile.split('/').pop() ?? 'Untitled';
      items.push({
        id: `screenshot-view:${entryFile}`,
        label: fileName,
        chipType: 'screenshot',
        group: takeScreenshotGroup,
        isAction: true,
        screenshotAction: { type: 'view', entryFile },
      });
    }

    return items;
  }, [geometryUnits, mainEntryFile]);

  const { quality: screenshotQuality } = useImageQuality();

  // Track active screenshot actors for lifecycle cleanup
  const activeScreenshotActorsRef = useRef(new Set<{ stop: () => void }>());
  useEffect(() => {
    const actors = activeScreenshotActorsRef;
    return () => {
      for (const actor of actors.current) {
        actor.stop();
      }
      actors.current.clear();
    };
  }, []);

  // Refs for stable callback — avoids recreating handleScreenshotAction on every render
  const projectContextRef = useRef(projectContext);
  projectContextRef.current = projectContext;
  const handleAddImageRef = useRef(logic.handleAddImage);
  handleAddImageRef.current = logic.handleAddImage;
  const screenshotQualityRef = useRef(screenshotQuality);
  screenshotQualityRef.current = screenshotQuality;

  const handleScreenshotAction = useCallback((item: ContextSuggestionItem) => {
    const { screenshotAction } = item;
    if (!screenshotAction) {
      return;
    }

    const currentProjectContext = projectContextRef.current;
    if (!currentProjectContext) {
      toast.error('No project context available for screenshot');
      return;
    }

    const { viewGraphics, editorRef, mainEntryFile: mainEntry } = currentProjectContext;
    const { viewSettings } = editorRef.getSnapshot().context;

    let graphicsRef: ActorRefFrom<typeof graphicsMachine> | undefined;

    if (screenshotAction.type === 'view') {
      for (const [viewId, gRef] of viewGraphics) {
        if (viewSettings[viewId]?.entryFile === screenshotAction.entryFile) {
          graphicsRef = gRef;
          break;
        }
      }
    } else {
      for (const [viewId, gRef] of viewGraphics) {
        if (viewSettings[viewId]?.entryFile === mainEntry) {
          graphicsRef = gRef;
          break;
        }
      }
      graphicsRef ??= viewGraphics.values().next().value;
    }

    if (!graphicsRef) {
      toast.error('No graphics view available for screenshot');
      return;
    }

    const actor = createActor(screenshotRequestMachine, {
      input: { graphicsRef },
    });
    const actors = activeScreenshotActorsRef.current;
    actors.add(actor);
    actor.start();

    const cleanup = () => {
      actor.stop();
      actors.delete(actor);
    };

    const quality = screenshotQualityRef.current;

    if (screenshotAction.type === 'composite') {
      actor.send({
        type: 'requestCompositeScreenshot',
        options: {
          output: {
            format: 'image/webp',
            quality,
            isPreview: true,
          },
          cameraAngles: orthographicViews.slice(0, 6),
          aspectRatio: 1,
          maxResolution: 800,
          zoomLevel: 1.2,
          composite: {
            enabled: true,
            preferredRatio: { columns: 3, rows: 2 },
            showLabels: true,
            padding: 12,
            labelHeight: 24,
            backgroundColor: 'transparent',
            dividerColor: 'var(--border)',
            dividerWidth: 1,
          },
        },
        onSuccess(dataUrls) {
          cleanup();
          const dataUrl = dataUrls[0];
          if (dataUrl) {
            handleAddImageRef.current(dataUrl);
          } else {
            toast.error('Failed to capture composite screenshot');
          }
        },
        onError(error) {
          cleanup();
          toast.error(`Screenshot failed: ${error}`);
        },
      });
    } else {
      actor.send({
        type: 'requestScreenshot',
        options: {
          output: {
            format: 'image/webp',
            quality,
          },
          aspectRatio: 16 / 9,
          maxResolution: 1200,
          zoomLevel: 1.4,
        },
        onSuccess(dataUrls) {
          cleanup();
          const dataUrl = dataUrls[0];
          if (dataUrl) {
            handleAddImageRef.current(dataUrl);
          } else {
            toast.error('Failed to capture screenshot');
          }
        },
        onError(error) {
          cleanup();
          toast.error(`Screenshot failed: ${error}`);
        },
      });
    }
  }, []);

  const skeleton = <ChatTextareaSkeleton className={className} />;

  if (isMobile) {
    return (
      <ClientOnly fallback={skeleton}>
        <ChatTextareaMobile
          className={className}
          enableAutoFocus={enableAutoFocus}
          enableContextActions={enableContextActions}
          enableKernelSelector={enableKernelSelector}
          // State
          isDragging={logic.isDragging}
          showContextMenu={logic.showContextMenu}
          contextSearchQuery={logic.contextSearchQuery}
          selectedMenuIndex={logic.selectedMenuIndex}
          isSubmitting={logic.isSubmitting}
          inputText={logic.inputText}
          images={logic.images}
          selectedToolChoice={logic.selectedToolChoice}
          status={logic.status}
          selectedModel={logic.selectedModel}
          formattedCancelKeyCombination={logic.formattedCancelKeyCombination}
          // Refs
          textareaReference={logic.textareaReference}
          fileInputReference={logic.fileInputReference}
          containerReference={logic.containerReference}
          // Handlers
          handleSubmit={logic.handleSubmit}
          handleCancelClick={logic.handleCancelClick}
          handleTextareaKeyDown={logic.handleTextareaKeyDown}
          handleDragOver={logic.handleDragOver}
          handleDragLeave={logic.handleDragLeave}
          handleDrop={logic.handleDrop}
          handleFileSelect={logic.handleFileSelect}
          handleFileChange={logic.handleFileChange}
          handleTextChange={logic.handleTextChange}
          handleContextMenuSelect={logic.handleContextMenuSelect}
          handleContextImageAdd={logic.handleContextImageAdd}
          handleAddText={logic.handleAddText}
          handleAddImage={logic.handleAddImage}
          handleTextareaBlur={logic.handleTextareaBlur}
          handlePointerDown={logic.handlePointerDown}
          focusInput={logic.focusInput}
          removeImage={logic.removeImage}
          setShowContextMenu={logic.setShowContextMenu}
          setAtSymbolPosition={logic.setAtSymbolPosition}
          setContextSearchQuery={logic.setContextSearchQuery}
          setSelectedMenuIndex={logic.setSelectedMenuIndex}
          setDraftToolChoice={logic.setDraftToolChoice}
        />
      </ClientOnly>
    );
  }

  return (
    <ClientOnly fallback={skeleton}>
      <ChatTextareaDesktop
        className={className}
        enableAutoFocus={enableAutoFocus}
        enableContextActions={enableContextActions}
        enableKernelSelector={enableKernelSelector}
        // State
        isDragging={logic.isDragging}
        isSubmitting={logic.isSubmitting}
        inputText={logic.inputText}
        images={logic.images}
        selectedToolChoice={logic.selectedToolChoice}
        status={logic.status}
        selectedModel={logic.selectedModel}
        formattedCancelKeyCombination={logic.formattedCancelKeyCombination}
        // Context data for Tiptap
        treeService={treeService}
        chats={chats}
        actionItems={screenshotActionItems}
        setDraftText={setDraftText}
        // Refs
        fileInputReference={logic.fileInputReference}
        containerReference={logic.containerReference}
        focusEditorRef={focusEditorRef}
        // Handlers
        handleSubmit={logic.handleSubmit}
        handleCancelClick={logic.handleCancelClick}
        handleDragOver={logic.handleDragOver}
        handleDragLeave={logic.handleDragLeave}
        handleDrop={logic.handleDrop}
        handleFileSelect={logic.handleFileSelect}
        handleFileChange={logic.handleFileChange}
        handleAddImage={logic.handleAddImage}
        onScreenshotAction={handleScreenshotAction}
        onEscapePressed={onEscapePressed}
        handleTextareaBlur={logic.handleTextareaBlur}
        removeImage={logic.removeImage}
        setDraftToolChoice={logic.setDraftToolChoice}
      />
    </ClientOnly>
  );
});
