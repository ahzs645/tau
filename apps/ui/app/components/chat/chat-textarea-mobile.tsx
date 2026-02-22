import { memo, useState } from 'react';
import { Plus, CircuitBoard, Wrench, Paperclip, ChevronRight } from 'lucide-react';
import type { ToolSelection } from '@taucad/chat';
import { kernelConfigurations } from '@taucad/types/constants';
import { Button } from '#components/ui/button.js';
import { Textarea } from '#components/ui/textarea.js';
import { SvgIcon } from '#components/icons/svg-icon.js';
import { cn } from '#utils/ui.utils.js';
import { menuItemVariants } from '#components/ui/menu.variants.js';
import { ChatModelSelector } from '#components/chat/chat-model-selector.js';
import { ChatKernelSelector } from '#components/chat/chat-kernel-selector.js';
import { ChatToolSelector } from '#components/chat/chat-tool-selector.js';
import { ChatContextActions } from '#components/chat/chat-context-actions.js';
import { ChatTextareaContextMenu } from '#components/chat/chat-textarea-context-menu.js';
import { ChatTextareaMobileImages } from '#components/chat/chat-textarea-mobile-images.js';
import { ChatTextareaSubmitButton } from '#components/chat/chat-textarea-submit-button.js';
import { focusTrapAttribute } from '#components/chat/chat-textarea-types.js';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle, DrawerTrigger } from '#components/ui/drawer.js';
import { Command, CommandGroup, CommandItem, CommandList } from '#components/ui/command.js';
import type { useModels } from '#hooks/use-models.js';

// Styled div that looks like CommandItem but works as a trigger for nested drawers.
// Uses menuItemVariants with mobile-specific size overrides (gap-1, px-2, py-1.5, text-sm, size-5 icons).
const menuItemClassName = cn(
  menuItemVariants({ highlight: 'selected' }),
  "gap-1 px-2 py-1.5 text-sm [&_svg:not([class*='size-'])]:size-5",
);

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
  readonly setDraftToolChoice: (choice: ToolSelection) => void;
  readonly status: string;
  readonly selectedModel: ReturnType<typeof useModels>['selectedModel'];
  readonly formattedCancelKeyCombination: string;

  // Refs
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- React ref object
  readonly textareaReference: React.RefObject<HTMLTextAreaElement | null>;
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- React ref object
  readonly fileInputReference: React.RefObject<HTMLInputElement | null>;
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- React ref object
  readonly containerReference: React.RefObject<HTMLDivElement | null>;

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

const getToolModeLabel = (value?: ToolSelection): string => {
  if (!value || value === 'auto') {
    return 'Auto';
  }

  if (value === 'none') {
    return 'No tools';
  }

  if (value === 'any') {
    return 'Any tool';
  }

  if (Array.isArray(value)) {
    return `${value.length} tool${value.length === 1 ? '' : 's'}`;
  }

  return 'Auto';
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
  selectedToolChoice,
  setDraftToolChoice,
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

  const selectedKernel = kernelConfigurations.find((k) => k.id === 'openscad');

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
        'relative flex size-full flex-row items-end gap-1 border bg-background',
        'overflow-hidden',
        'shadow-md',
        'focus-within:border-primary',
        'h-auto min-h-9 p-1.25 md:min-h-10',
        className,
        'rounded-2xl',
      )}
      onBlur={handleTextareaBlur}
    >
      {/* Plus button - opens drawer with all actions */}
      <Drawer open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
        <DrawerTrigger asChild>
          <Button
            data-chat-textarea-focustrap={focusTrapAttribute}
            variant="outline"
            size="icon"
            className="size-7 shrink-0 rounded-full border-none text-muted-foreground not-dark:bg-muted hover:text-foreground"
          >
            <Plus className="size-5" />
          </Button>
        </DrawerTrigger>
        <DrawerContent data-chat-textarea-focustrap={focusTrapAttribute}>
          <DrawerTitle className="sr-only">Chat Options</DrawerTitle>
          <DrawerDescription className="sr-only">Configure chat settings and add context</DrawerDescription>
          <Command className="bg-transparent">
            <CommandList className="max-h-none">
              {/* Settings Group */}
              <CommandGroup heading="Settings">
                {/* Model Selector */}
                <ChatModelSelector
                  isNested
                  data-chat-textarea-focustrap={focusTrapAttribute}
                  popoverProperties={{ align: 'start' }}
                  onSelect={() => {
                    setIsDrawerOpen(false);
                    focusInput();
                  }}
                >
                  {() => (
                    <div className={menuItemClassName}>
                      <span className="flex w-full items-center justify-between">
                        <div className="flex items-center gap-2">
                          <CircuitBoard className="size-4" />
                          <div className="flex flex-col items-start">
                            <span>{selectedModel?.name ?? 'Select model'}</span>
                            <span className="text-xs text-muted-foreground">AI model for responses</span>
                          </div>
                        </div>
                        <ChevronRight className="size-4 text-muted-foreground" />
                      </span>
                    </div>
                  )}
                </ChatModelSelector>

                {/* Kernel Selector */}
                {enableKernelSelector ? (
                  <ChatKernelSelector
                    isNested
                    data-chat-textarea-focustrap={focusTrapAttribute}
                    popoverProperties={{ align: 'start' }}
                    onSelect={() => {
                      setIsDrawerOpen(false);
                      focusInput();
                    }}
                  >
                    {({ selectedKernel: kernel }) => (
                      <div className={menuItemClassName}>
                        <span className="flex w-full items-center justify-between">
                          <div className="flex items-center gap-2">
                            <SvgIcon id={kernel?.id ?? selectedKernel?.id ?? 'openscad'} className="size-4" />
                            <div className="flex flex-col items-start">
                              <span>{kernel?.name ?? selectedKernel?.name ?? 'OpenSCAD'}</span>
                              <span className="text-xs text-muted-foreground">CAD kernel for code execution</span>
                            </div>
                          </div>
                          <ChevronRight className="size-4 text-muted-foreground" />
                        </span>
                      </div>
                    )}
                  </ChatKernelSelector>
                ) : null}

                {/* Tool Selector */}
                <ChatToolSelector isNested value={selectedToolChoice} onValueChange={setDraftToolChoice}>
                  {() => (
                    <div
                      // Tool selector hidden for now until it's hooked up in backend.
                      className={cn(menuItemClassName, 'hidden')}
                    >
                      <span className="flex w-full items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Wrench className="size-4" />
                          <div className="flex flex-col items-start">
                            <span>{getToolModeLabel(selectedToolChoice)}</span>
                            <span className="text-xs text-muted-foreground">Tool usage mode</span>
                          </div>
                        </div>
                        <ChevronRight className="size-4 text-muted-foreground" />
                      </span>
                    </div>
                  )}
                </ChatToolSelector>
              </CommandGroup>

              {/* Actions Group */}
              <CommandGroup heading="Actions">
                {/* Upload Image */}
                <CommandItem value="upload-image" onSelect={handleDrawerFileSelect}>
                  <span className="flex w-full items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Paperclip className="size-4" />
                      <div className="flex flex-col items-start">
                        <span>Upload image</span>
                        <span className="text-xs text-muted-foreground">Attach an image to your message</span>
                      </div>
                    </div>
                  </span>
                </CommandItem>

                {/* Context Actions - inline as menu items */}
                {enableContextActions ? (
                  <ChatContextActions
                    asPopoverMenu
                    data-chat-textarea-focustrap={focusTrapAttribute}
                    addImage={handleDrawerAddImage}
                    addText={handleDrawerAddText}
                    onClose={() => {
                      setIsDrawerOpen(false);
                    }}
                  />
                ) : null}
              </CommandGroup>
            </CommandList>
          </Command>
        </DrawerContent>
      </Drawer>

      {/* Textarea area */}
      <div
        className={cn('flex flex-1 flex-col overflow-auto')}
        onClick={(event) => {
          if (event.target !== textareaReference.current) {
            focusInput();
          }
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPointerDown={handlePointerDown}
      >
        <ChatTextareaMobileImages images={images} onRemoveImage={removeImage} />
        {/*
         * Grid overlay technique for cross-browser textarea auto-resize.
         * Safari doesn't support `field-sizing: content`, so we stack a hidden div
         * and textarea in the same grid cell. The hidden div expands naturally with
         * content, and the textarea inherits that height via the grid.
         */}
        <div className="grid max-h-48">
          {/* Hidden div that expands naturally with content - drives the grid cell size */}
          <div
            className="invisible py-0.5 text-base wrap-break-word whitespace-pre-wrap [grid-area:1/1]"
            aria-hidden="true"
          >
            {inputText || 'A'}
          </div>
          <Textarea
            ref={textareaReference}
            className={cn(
              'p-0 py-0.5',
              'h-full min-h-4 w-full resize-none overflow-hidden rounded-none border-none bg-transparent dark:bg-transparent',
              'shadow-none ring-0 focus-visible:ring-0 focus-visible:outline-none',
              '[grid-area:1/1]',
            )}
            rows={1}
            autoFocus={enableAutoFocus}
            value={inputText}
            placeholder="Ask Tau to build anything..."
            onChange={handleTextChange}
            onKeyDown={handleTextareaKeyDown}
          />
        </div>
      </div>

      {/* Context Menu */}
      {showContextMenu ? (
        <ChatTextareaContextMenu
          searchQuery={contextSearchQuery}
          selectedIndex={selectedMenuIndex}
          onSelectedIndexChange={setSelectedMenuIndex}
          onAddImage={handleContextImageAdd}
          onAddText={handleContextMenuSelect}
          onClose={() => {
            setShowContextMenu(false);
            setAtSymbolPosition(-1);
            setContextSearchQuery('');
            setSelectedMenuIndex(0);
          }}
        />
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
        isDisabled={inputText.trim().length === 0 && images.length === 0}
        formattedCancelKeyCombination={formattedCancelKeyCombination}
        onSubmit={handleSubmit}
        onCancel={handleCancelClick}
      />
    </div>
  );
});
