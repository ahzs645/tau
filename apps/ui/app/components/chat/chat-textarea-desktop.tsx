import { memo, useCallback, useEffect, useRef } from 'react';
import { ChevronDown, Paperclip, Wrench, AtSign } from 'lucide-react';
import type { Chat, ToolSelection } from '@taucad/chat';
import type { FileEntry } from '@taucad/types';
import type { FileTreeService } from '#lib/file-tree-service.js';
import { ChatModelSelector } from '#components/chat/chat-model-selector.js';
import { ChatKernelSelector } from '#components/chat/chat-kernel-selector.js';
import { ChatToolSelector } from '#components/chat/chat-tool-selector.js';
import { ChatAgentSelector, toggleModeKeyCombination } from '#components/chat/chat-mode-selector.js';
import { Button } from '#components/ui/button.js';
import { KeyShortcut } from '#components/ui/key-shortcut.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { SvgIcon } from '#components/icons/svg-icon.js';
import { formatKeyCombination } from '#utils/keys.utils.js';
import { cn } from '#utils/ui.utils.js';
import { ChatContextIndicator } from '#components/chat/chat-context-indicator.js';
import { ChatTextareaDesktopImages } from '#components/chat/chat-textarea-desktop-images.js';
import { ChatTextareaSubmitButton } from '#components/chat/chat-textarea-submit-button.js';
import { focusTrapAttribute } from '#components/chat/chat-textarea-types.js';
import { useSelector } from '@xstate/react';
import { useChatActions, useChatContext } from '#hooks/use-chat.js';
import type { useModels } from '#hooks/use-models.js';
import { useFeature } from '#flags/use-feature.js';
import { ChatEditor } from '#components/chat/tiptap/chat-editor.js';
import { useChatEditor, buildEditorContentJson } from '#components/chat/tiptap/use-chat-editor.js';
import type { ContextSuggestionItem } from '#components/chat/tiptap/suggestion-types.js';
import { createScreenshotContextHandler } from '#components/chat/screenshot-actions.utils.js';
import { buildPastedContent } from '#utils/at-reference.utils.js';
import { defaultSkills } from '#components/chat/tiptap/slash-command-suggestion.js';

const knownSkillIds = new Set(defaultSkills.map((s) => s.id));

type ChatTextareaDesktopProperties = {
  readonly className?: string;
  readonly enableAutoFocus?: boolean;
  readonly enableContextActions?: boolean;
  readonly enableKernelSelector?: boolean;

  // State
  readonly isDragging: boolean;
  readonly isSubmitting: boolean;
  readonly inputText: string;
  readonly images: string[];
  readonly selectedToolChoice: ToolSelection;
  readonly status: string;
  readonly selectedModel: ReturnType<typeof useModels>['selectedModel'];
  readonly formattedCancelKeyCombination: string;

  // Context data for Tiptap editor
  readonly treeService: FileTreeService | undefined;
  readonly chats: Chat[];
  readonly actionItems?: ContextSuggestionItem[];
  readonly setDraftText: (text: string) => void;

  // Refs
  // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- React ref object
  readonly fileInputReference: React.RefObject<HTMLInputElement | null>;
  // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- React ref object
  readonly containerReference: React.RefObject<HTMLDivElement | null>;
  // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- React ref object for imperative focus
  readonly focusEditorRef: React.RefObject<(() => void) | undefined>;

  // Handlers (all must be stable references to prevent tooltip re-render loops)
  readonly handleSubmit: () => Promise<void>;
  readonly handleCancelClick: () => void;
  readonly handleDragOver: (event: React.DragEvent) => void;
  readonly handleDragLeave: () => void;
  readonly handleDrop: (event: React.DragEvent) => void;
  readonly handleFileSelect: () => void;
  readonly handleFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  readonly handleAddImage: (image: string) => void;
  readonly onScreenshotAction: (item: ContextSuggestionItem) => void;
  readonly onEscapePressed?: () => void;
  readonly handleTextareaBlur: () => void;
  readonly removeImage: (index: number) => void;
  readonly setDraftToolChoice: (choice: ToolSelection) => void;
};

/**
 * Desktop version of the chat textarea with Tiptap rich text editor.
 * Supports inline context chips via @-mentions, slash commands, and drag-drop from dockview tabs.
 *
 * Architecture note: all callback props MUST be stable (memoized) references.
 * Radix UI's SlotClone (used by TooltipTrigger asChild) calls composeRefs()
 * inline on every render. In React 19, if the parent re-renders and creates
 * a new composed ref, the ref cleanup/set cycle calls setTrigger(null) then
 * setTrigger(domNode), which triggers another re-render -> infinite loop.
 * Keeping props stable means memo() prevents parent re-renders from reaching
 * the tooltip tree entirely.
 */
export const ChatTextareaDesktop = memo(function ({
  className,
  enableAutoFocus = true,
  enableContextActions = true,
  enableKernelSelector = true,

  // State
  isDragging,
  isSubmitting,
  inputText,
  images,
  selectedToolChoice,
  status,
  selectedModel,
  formattedCancelKeyCombination,

  // Context data
  treeService,
  chats,
  actionItems,
  setDraftText,

  // Refs
  fileInputReference,
  containerReference,
  focusEditorRef,

  // Handlers
  handleSubmit,
  handleCancelClick,
  handleDragOver,
  handleDragLeave,
  handleDrop,
  handleFileSelect,
  handleFileChange,
  handleAddImage,
  onScreenshotAction,
  onEscapePressed,
  handleTextareaBlur,
  removeImage,
  setDraftToolChoice,
}: ChatTextareaDesktopProperties): React.JSX.Element {
  const handleEditorUpdate = useCallback(
    (content: { text: string }) => {
      setDraftText(content.text);
    },
    [setDraftText],
  );

  const chatEditor = useChatEditor({
    onSubmit: handleSubmit,
    onEscape: onEscapePressed,
    onUpdate: handleEditorUpdate,
    onImagePaste: handleAddImage,
    treeService,
    chats,
    actionItems,
    onContextAction: createScreenshotContextHandler({
      handleAddImage,
      onScreenshotAction,
    }),
  });

  const { editor } = chatEditor;

  // Store editor in a ref so callbacks below remain stable (empty dep arrays).
  // This breaks the re-render cascade: editor changes (null→Editor) won't
  // recreate focusEditor/handleAtButtonClick, so Tooltip children stay memo'd.
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useEffect(() => {
    if (!editor) {
      return;
    }
    if (inputText === '' && !editor.isEmpty) {
      editor.commands.clearContent(false);
    } else if (inputText !== '' && editor.isEmpty) {
      const lazyTree: Map<string, FileEntry> = treeService?.getTreeSnapshot() ?? new Map<string, FileEntry>();
      const segments = buildPastedContent(inputText, { fileTree: lazyTree, chats, knownSkills: knownSkillIds });
      const json = buildEditorContentJson(segments);
      editor.commands.setContent(json ?? inputText, { emitUpdate: false });
    }
  }, [inputText, editor, treeService, chats]);

  // Expose focus function to parent via mutable ref
  useEffect(() => {
    focusEditorRef.current = () => editorRef.current?.commands.focus('end');
    return () => {
      focusEditorRef.current = undefined;
    };
  }, [focusEditorRef]);

  useEffect(() => {
    if (enableAutoFocus && editor) {
      editor.commands.focus('end');
    }
  }, [enableAutoFocus, editor]);

  const focusEditor = useCallback(() => {
    editorRef.current?.commands.focus('end');
  }, []);

  const handleAtButtonClick = useCallback(() => {
    if (!editorRef.current) {
      return;
    }
    editorRef.current.chain().focus().insertContent('@').run();
  }, []);

  const handleEditorAreaClick = useCallback((event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (!target.closest('.tiptap')) {
      editorRef.current?.commands.focus('end');
    }
  }, []);

  const isDisabled = inputText.trim().length === 0 && images.length === 0;

  return (
    <div
      ref={containerReference}
      className={cn(
        'group/chat-textarea @container',
        'relative flex size-full flex-col rounded-2xl border bg-background',
        'cursor-text overflow-auto',
        'shadow-md',
        'focus-within:border-primary/50',
        className,
      )}
      onBlur={handleTextareaBlur}
    >
      {/* Editor */}
      <div
        className={cn('flex size-full flex-col overflow-auto')}
        onClick={handleEditorAreaClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <ChatEditor
          editor={editor}
          className={cn(images.length > 0 ? 'pt-10' : 'pt-2')}
          contextSuggestionState={chatEditor.contextSuggestionState}
          slashCommandState={chatEditor.slashCommandState}
          contextKeydownRef={chatEditor.contextKeydownRef}
          slashKeydownRef={chatEditor.slashKeydownRef}
        />
      </div>

      {/* Images overlay */}
      <ChatTextareaDesktopImages images={images} onRemoveImage={removeImage} />

      {/* Drag and drop feedback */}
      {isDragging ? (
        <div className='pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-primary/10 backdrop-blur-xs'>
          <p className='rounded-md bg-background/50 px-2 font-medium text-primary'>Add image(s)</p>
        </div>
      ) : null}

      {/* Bottom-left controls — wrapped in memo'd component to isolate Radix tooltip re-renders */}
      <ChatTextareaLeftControls
        selectedModel={selectedModel}
        enableKernelSelector={enableKernelSelector}
        selectedToolChoice={selectedToolChoice}
        focusEditor={focusEditor}
        setDraftToolChoice={setDraftToolChoice}
        fileInputReference={fileInputReference}
        handleFileChange={handleFileChange}
      />

      {/* Bottom-right controls */}
      <ChatTextareaRightControls
        enableContextActions={enableContextActions}
        handleAtButtonClick={handleAtButtonClick}
        handleFileSelect={handleFileSelect}
        status={status}
        isSubmitting={isSubmitting}
        isDisabled={isDisabled}
        formattedCancelKeyCombination={formattedCancelKeyCombination}
        handleSubmit={handleSubmit}
        handleCancelClick={handleCancelClick}
      />
    </div>
  );
});

ChatTextareaDesktop.displayName = 'ChatTextareaDesktop';

/**
 * Memo'd left control bar containing model/kernel/tool selectors.
 * Isolated to prevent Radix TooltipTrigger asChild composeRefs loops.
 */
const ChatTextareaLeftControls = memo(function ({
  selectedModel,
  enableKernelSelector,
  selectedToolChoice,
  focusEditor,
  setDraftToolChoice,
  fileInputReference,
  handleFileChange,
}: {
  readonly selectedModel: ReturnType<typeof useModels>['selectedModel'];
  readonly enableKernelSelector: boolean;
  readonly selectedToolChoice: ToolSelection;
  readonly focusEditor: () => void;
  readonly setDraftToolChoice: (choice: ToolSelection) => void;
  // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- React ref object
  readonly fileInputReference: React.RefObject<HTMLInputElement | null>;
  readonly handleFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}): React.JSX.Element {
  return (
    <div className='absolute bottom-2 left-2 flex flex-row items-center gap-1 text-muted-foreground'>
      <ChatTextareaModeControl />
      {/* Model selector */}
      <Tooltip>
        <ChatModelSelector
          data-chat-textarea-focustrap
          popoverProperties={{ align: 'start' }}
          onSelect={focusEditor}
          onClose={focusEditor}
        >
          {(_properties) => (
            <TooltipTrigger asChild>
              <Button
                variant='outline'
                size='sm'
                className='h-7 cursor-pointer! rounded-full text-muted-foreground hover:text-foreground @max-[22rem]:w-7 @xs:max-w-fit @[22rem]:pr-2'
              >
                <span className='hidden truncate text-xs @[22rem]:block'>{selectedModel?.name ?? 'Offline'}</span>
                <span className='relative flex size-4 items-center justify-center'>
                  <ChevronDown className='absolute scale-0 transition-transform duration-200 ease-in-out group-hover:scale-0 @[22rem]:scale-100' />
                  <SvgIcon
                    id={selectedModel?.details.family ?? 'anthropic'}
                    className='absolute scale-100 grayscale transition-transform duration-200 ease-in-out group-hover:scale-100 @[22rem]:scale-0'
                  />
                </span>
              </Button>
            </TooltipTrigger>
          )}
        </ChatModelSelector>
        <TooltipContent>
          <span>Select model{` `}</span>
          <span>({selectedModel?.slug ?? 'Offline'})</span>
        </TooltipContent>
      </Tooltip>
      {/* Kernel selector */}
      {enableKernelSelector ? (
        <Tooltip>
          <ChatKernelSelector
            data-chat-textarea-focustrap
            popoverProperties={{ align: 'start' }}
            onSelect={focusEditor}
            onClose={focusEditor}
          >
            {({ selectedKernel }) => (
              <TooltipTrigger asChild>
                <Button
                  variant='outline'
                  size='sm'
                  className='h-7 cursor-pointer! rounded-full text-muted-foreground hover:text-foreground @max-[22rem]:w-7 @xs:max-w-fit @[22rem]:pr-2'
                >
                  <span className='hidden truncate text-xs @[22rem]:block'>{selectedKernel?.name ?? 'OpenSCAD'}</span>
                  <span className='relative flex size-4 items-center justify-center'>
                    <ChevronDown className='absolute scale-0 transition-transform duration-200 ease-in-out group-hover:scale-0 @[22rem]:scale-100' />
                    <SvgIcon
                      id={selectedKernel?.id ?? 'openscad'}
                      className='absolute scale-100 grayscale transition-transform duration-200 ease-in-out group-hover:scale-100 @[22rem]:scale-0'
                    />
                  </span>
                </Button>
              </TooltipTrigger>
            )}
          </ChatKernelSelector>
          <TooltipContent>
            <span>Select kernel</span>
          </TooltipContent>
        </Tooltip>
      ) : null}
      {/* Tool selector */}
      <Tooltip>
        <ChatToolSelector value={selectedToolChoice} onValueChange={setDraftToolChoice}>
          {({ selectedMode, selectedTools, toolMetadata }) => (
            <TooltipTrigger asChild>
              <Button
                data-chat-textarea-focustrap={focusTrapAttribute}
                variant='outline'
                size='sm'
                className={cn(
                  'h-7 rounded-full pr-2 text-muted-foreground hover:text-foreground @max-[22rem]:w-7',
                  selectedTools.length > 0 && 'px-2 @max-[22rem]:w-auto',
                  // oxlint-disable-next-line no-warning-comments -- keeping this file clean.
                  'hidden', // TODO: add back when MCP is added.
                )}
              >
                <span className='hidden text-xs @[22rem]:block'>
                  {selectedMode === 'auto' && 'Auto'}
                  {selectedMode === 'none' && 'No tools'}
                  {selectedMode === 'any' && 'Any tool'}
                  {selectedMode === 'custom' && 'Custom'}
                </span>
                {selectedMode === 'custom' && selectedTools.length > 0 ? (
                  <span className='flex items-center gap-1'>
                    {selectedTools.map((tool) => {
                      const Icon = toolMetadata[tool]?.icon;
                      if (!Icon) {
                        return null;
                      }

                      return <Icon key={tool} className='size-4' />;
                    })}
                  </span>
                ) : (
                  <Wrench className='size-4' />
                )}
              </Button>
            </TooltipTrigger>
          )}
        </ChatToolSelector>
        <TooltipContent>
          <p>Tool selection</p>
        </TooltipContent>
      </Tooltip>

      <input
        ref={fileInputReference}
        multiple
        type='file'
        accept='image/*'
        className='hidden'
        onChange={handleFileChange}
      />
    </div>
  );
});

/**
 * Memo'd right control bar containing @-mention, upload, and submit buttons.
 * Isolated to prevent Radix TooltipTrigger asChild composeRefs loops.
 */
const ChatTextareaRightControls = memo(function ({
  enableContextActions,
  handleAtButtonClick,
  handleFileSelect,
  status,
  isSubmitting,
  isDisabled,
  formattedCancelKeyCombination,
  handleSubmit,
  handleCancelClick,
}: {
  readonly enableContextActions: boolean;
  readonly handleAtButtonClick: () => void;
  readonly handleFileSelect: () => void;
  readonly status: string;
  readonly isSubmitting: boolean;
  readonly isDisabled: boolean;
  readonly formattedCancelKeyCombination: string;
  readonly handleSubmit: () => Promise<void>;
  readonly handleCancelClick: () => void;
}): React.JSX.Element {
  return (
    <div className='absolute right-2 bottom-2 flex flex-row items-center gap-1'>
      <ChatContextIndicator />

      {/* @ context button — hidden when no project/context to attach (e.g. homepage) */}
      {enableContextActions ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              data-chat-textarea-focustrap={focusTrapAttribute}
              variant='outline'
              size='icon'
              className='size-6 rounded-full text-muted-foreground hover:text-foreground'
              onClick={handleAtButtonClick}
            >
              <AtSign className='size-3.5' />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add context</TooltipContent>
        </Tooltip>
      ) : null}

      {/* Upload button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant='outline'
            size='icon'
            className='size-6 rounded-full text-muted-foreground hover:text-foreground'
            title='Add image'
            onClick={handleFileSelect}
          >
            <Paperclip className='size-3.5' />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Upload an image</p>
        </TooltipContent>
      </Tooltip>

      {/* Submit button */}
      <ChatTextareaSubmitButton
        status={status}
        isSubmitting={isSubmitting}
        isDisabled={isDisabled}
        formattedCancelKeyCombination={formattedCancelKeyCombination}
        onSubmit={handleSubmit}
        onCancel={handleCancelClick}
      />
    </div>
  );
});

function ChatTextareaModeControl(): React.JSX.Element | undefined {
  const planModeEnabled = useFeature('planMode');
  const { draftActorRef } = useChatContext();
  const mode = useSelector(draftActorRef, (state) => state.context.draftMode);
  const { setDraftMode } = useChatActions();

  if (!planModeEnabled) {
    return undefined;
  }

  return (
    <Tooltip>
      <ChatAgentSelector
        data-chat-textarea-focustrap
        mode={mode}
        onModeChange={setDraftMode}
        popoverProperties={{ align: 'start' }}
      >
        {({ currentConfig }) => (
          <TooltipTrigger asChild>
            <Button
              variant='outline'
              size='sm'
              className={cn(
                'h-7 cursor-pointer! rounded-full text-muted-foreground hover:text-foreground @max-[22rem]:w-7 @xs:max-w-fit @[22rem]:pr-2',
                currentConfig.activeClass,
              )}
            >
              <currentConfig.icon className='size-4' />
              <span className='hidden text-xs @[22rem]:block'>{currentConfig.label}</span>
            </Button>
          </TooltipTrigger>
        )}
      </ChatAgentSelector>
      <TooltipContent>
        <span className='flex items-center gap-1.5'>
          Switch agent mode
          <KeyShortcut variant='tooltip'>{formatKeyCombination(toggleModeKeyCombination)}</KeyShortcut>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
