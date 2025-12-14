import { memo, useState } from 'react';
import { Plus, ChevronDown, Paperclip, CircuitBoard } from 'lucide-react';
import type { ToolSelection } from '@taucad/chat';
import { ChatModelSelector } from '#components/chat/chat-model-selector.js';
import { ChatKernelSelector } from '#components/chat/chat-kernel-selector.js';
import { Button } from '#components/ui/button.js';
import { Textarea } from '#components/ui/textarea.js';
import { SvgIcon } from '#components/icons/svg-icon.js';
import { cn } from '#utils/ui.utils.js';
import { ChatContextActions } from '#components/chat/chat-context-actions.js';
import { ChatTextareaImages } from '#components/chat/chat-textarea-images.js';
import { ChatTextareaSubmitButton } from '#components/chat/chat-textarea-submit-button.js';
import { focusTrapAttribute } from '#components/chat/chat-textarea-types.js';
import { Drawer, DrawerClose, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from '#components/ui/drawer.js';
import type { useModels } from '#hooks/use-models.js';

type ChatTextareaMobileProperties = {
  readonly className?: string;
  readonly enableAutoFocus?: boolean;
  readonly enableContextActions?: boolean;
  readonly enableKernelSelector?: boolean;

  // State from hook
  readonly isDragging: boolean;
  readonly showContextMenu: boolean;
  readonly contextSearchQuery: string;
  readonly selectedMenuIndex: number;
  readonly isSubmitting: boolean;
  readonly inputText: string;
  readonly images: string[];
  readonly selectedToolChoice: ToolSelection;
  readonly status: string;
  readonly selectedModel: ReturnType<typeof useModels>['selectedModel'];
  readonly formattedCancelKeyCombination: string;

  // Refs
  readonly textareaReference: React.RefObject<HTMLTextAreaElement | undefined>;
  readonly fileInputReference: React.RefObject<HTMLInputElement | undefined>;
  readonly containerReference: React.RefObject<HTMLDivElement | undefined>;

  // Handlers
  readonly handleSubmit: () => Promise<void>;
  readonly handleCancelClick: () => void;
  readonly handleTextareaKeyDown: (event: React.KeyboardEvent) => void;
  readonly handleDragOver: (event: React.DragEvent) => void;
  readonly handleDragLeave: () => void;
  readonly handleDrop: (event: React.DragEvent) => void;
  readonly handleFileSelect: () => void;
  readonly handleFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  readonly handleTextChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  readonly handleContextMenuSelect: (text: string) => void;
  readonly handleContextImageAdd: (image: string) => void;
  readonly handleAddText: (text: string) => void;
  readonly handleAddImage: (image: string) => void;
  readonly handleTextareaBlur: () => void;
  readonly handlePointerDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  readonly focusInput: () => void;
  readonly removeImage: (index: number) => void;
  readonly setShowContextMenu: (show: boolean) => void;
  readonly setAtSymbolPosition: (position: number) => void;
  readonly setContextSearchQuery: (query: string) => void;
  readonly setSelectedMenuIndex: (index: number) => void;
};

/**
 * Mobile version of the chat textarea with minimal UI.
 * Shows only a "+" button (opens drawer with all actions) and submit button.
 * Like ChatGPT's mobile interface.
 */
export const ChatTextareaMobile = memo(function ({
  className,
  enableAutoFocus = true,
  enableContextActions = true,
  enableKernelSelector = true,

  // State
  isDragging,
  showContextMenu,
  contextSearchQuery,
  selectedMenuIndex,
  isSubmitting,
  inputText,
  images,
  status,
  selectedModel,
  formattedCancelKeyCombination,

  // Refs
  textareaReference,
  fileInputReference,
  containerReference,

  // Handlers
  handleSubmit,
  handleCancelClick,
  handleTextareaKeyDown,
  handleDragOver,
  handleDragLeave,
  handleDrop,
  handleFileSelect,
  handleFileChange,
  handleTextChange,
  handleContextMenuSelect,
  handleContextImageAdd,
  handleAddText,
  handleAddImage,
  handleTextareaBlur,
  handlePointerDown,
  focusInput,
  removeImage,
  setShowContextMenu,
  setAtSymbolPosition,
  setContextSearchQuery,
  setSelectedMenuIndex,
}: ChatTextareaMobileProperties): React.JSX.Element {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  const handleDrawerAddImage = (image: string): void => {
    handleAddImage(image);
    setIsDrawerOpen(false);
  };

  const handleDrawerAddText = (text: string): void => {
    handleAddText(text);
    setIsDrawerOpen(false);
  };

  const handleDrawerFileSelect = (): void => {
    handleFileSelect();
    setIsDrawerOpen(false);
  };

  return (
    <div
      ref={containerReference}
      className={cn(
        'group/chat-textarea',
        'relative flex size-full flex-row items-center gap-2 rounded-2xl border bg-background',
        'overflow-hidden',
        'shadow-md',
        'focus-within:border-primary',
        'px-2 py-1.5',
        className,
      )}
      onBlur={handleTextareaBlur}
    >
      {/* Plus button - opens drawer with all actions */}
      <Drawer open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
        <DrawerTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-5" />
          </Button>
        </DrawerTrigger>
        <DrawerContent className="z-9999" data-chat-textarea-focustrap={focusTrapAttribute}>
          <DrawerHeader>
            <DrawerTitle>Add to message</DrawerTitle>
          </DrawerHeader>
          <div className="flex flex-col gap-4 px-4 pb-8">
            {/* Model Selector */}
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-muted-foreground">Model</span>
              <ChatModelSelector
                data-chat-textarea-focustrap={focusTrapAttribute}
                popoverProperties={{
                  align: 'start',
                }}
                onSelect={() => {
                  setIsDrawerOpen(false);
                  focusInput();
                }}
                onClose={focusInput}
              >
                {(_properties) => (
                  <DrawerClose asChild>
                    <Button variant="outline" className="h-12 w-full justify-between rounded-xl text-left">
                      <span className="flex items-center gap-2">
                        <CircuitBoard className="size-5" />
                        <span>{selectedModel?.name ?? 'Offline'}</span>
                      </span>
                      <ChevronDown className="size-4" />
                    </Button>
                  </DrawerClose>
                )}
              </ChatModelSelector>
            </div>

            {/* Kernel Selector */}
            {enableKernelSelector ? (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-muted-foreground">Kernel</span>
                <ChatKernelSelector
                  data-chat-textarea-focustrap={focusTrapAttribute}
                  popoverProperties={{
                    align: 'start',
                  }}
                  onSelect={() => {
                    setIsDrawerOpen(false);
                    focusInput();
                  }}
                  onClose={focusInput}
                >
                  {({ selectedKernel }) => (
                    <DrawerClose asChild>
                      <Button variant="outline" className="h-12 w-full justify-between rounded-xl text-left">
                        <span className="flex items-center gap-2">
                          <SvgIcon id={selectedKernel?.id ?? 'openscad'} className="size-5" />
                          <span>{selectedKernel?.name ?? 'OpenSCAD'}</span>
                        </span>
                        <ChevronDown className="size-4" />
                      </Button>
                    </DrawerClose>
                  )}
                </ChatKernelSelector>
              </div>
            ) : null}

            {/* Upload Image */}
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-muted-foreground">Attachments</span>
              <Button
                variant="outline"
                className="h-12 w-full justify-start gap-2 rounded-xl text-left"
                onClick={handleDrawerFileSelect}
              >
                <Paperclip className="size-5" />
                <span>Upload an image</span>
              </Button>
            </div>

            {/* Context Actions */}
            {enableContextActions ? (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-muted-foreground">Context</span>
                <div className="rounded-xl border">
                  <ChatContextActions
                    asPopoverMenu
                    data-chat-textarea-focustrap={focusTrapAttribute}
                    addImage={handleDrawerAddImage}
                    addText={handleDrawerAddText}
                    onClose={() => {
                      setIsDrawerOpen(false);
                    }}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </DrawerContent>
      </Drawer>

      {/* Textarea area */}
      <div
        className={cn('flex flex-1 flex-col overflow-auto')}
        onClick={focusInput}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPointerDown={handlePointerDown}
      >
        {/* Images preview (compact) */}
        {images.length > 0 ? (
          <div className="mb-1 flex flex-wrap gap-1">
            {images.map((image, index) => (
              <div key={image} className="relative">
                <img src={image} alt="Uploaded" className="size-8 rounded-xs border object-cover" />
                <button
                  type="button"
                  className="text-destructive-foreground absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-destructive"
                  onClick={() => {
                    removeImage(index);
                  }}
                >
                  <Plus className="size-3 rotate-45" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/* Input */}
        <Textarea
          ref={textareaReference}
          className={cn(
            'size-full max-h-24 min-h-4 resize-none border-none bg-transparent p-0 dark:bg-transparent',
            'shadow-none ring-0 focus-visible:ring-0 focus-visible:outline-none',
            'text-sm',
          )}
          rows={1}
          autoFocus={enableAutoFocus}
          value={inputText}
          placeholder="Ask anything..."
          onChange={handleTextChange}
          onKeyDown={handleTextareaKeyDown}
        />
      </div>

      {/* Context Menu - hidden on mobile but still functional via @ typing */}
      {showContextMenu ? (
        <div className="absolute bottom-full left-2 z-50 mb-2 w-60 rounded-md border bg-popover p-0 text-popover-foreground shadow-md">
          <ChatContextActions
            asPopoverMenu
            addImage={handleContextImageAdd}
            addText={handleContextMenuSelect}
            searchQuery={contextSearchQuery}
            selectedIndex={selectedMenuIndex}
            onSelectedIndexChange={setSelectedMenuIndex}
            onSelectItem={(text: string) => {
              handleContextMenuSelect(text);
            }}
            onClose={() => {
              setShowContextMenu(false);
              setAtSymbolPosition(-1);
              setContextSearchQuery('');
              setSelectedMenuIndex(0);
            }}
          />
        </div>
      ) : null}

      {/* Drag and drop feedback */}
      {isDragging ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-primary/10 backdrop-blur-xs">
          <p className="rounded-md bg-background/50 px-2 font-medium text-primary">Add image(s)</p>
        </div>
      ) : null}

      {/* Hidden file input */}
      <input
        ref={fileInputReference}
        multiple
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Submit button */}
      <ChatTextareaSubmitButton
        status={status}
        isSubmitting={isSubmitting}
        isDisabled={inputText.trim().length === 0}
        formattedCancelKeyCombination={formattedCancelKeyCombination}
        onSubmit={() => void handleSubmit()}
        onCancel={handleCancelClick}
      />
    </div>
  );
});
