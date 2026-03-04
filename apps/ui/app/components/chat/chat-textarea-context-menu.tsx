import { memo } from 'react';
import { ChatContextActions } from '#components/chat/chat-context-actions.js';

type ChatTextareaContextMenuProperties = {
  readonly searchQuery: string;
  readonly selectedIndex: number;
  readonly onSelectedIndexChange: (index: number) => void;
  readonly onAddImage: (image: string) => void;
  readonly onAddText: (text: string) => void;
  readonly onClose: () => void;
};

/**
 * Shared context menu component for the chat textarea.
 * Displays the @ mention context menu for both desktop and mobile.
 */
export const ChatTextareaContextMenu = memo(function ({
  searchQuery,
  selectedIndex,
  onSelectedIndexChange,
  onAddImage,
  onAddText,
  onClose,
}: ChatTextareaContextMenuProperties): React.JSX.Element {
  return (
    <div className='absolute bottom-full left-2 z-50 mb-2 w-60 rounded-md border bg-popover p-0 text-popover-foreground shadow-md'>
      <ChatContextActions
        asPopoverMenu
        addImage={onAddImage}
        addText={onAddText}
        searchQuery={searchQuery}
        selectedIndex={selectedIndex}
        onSelectedIndexChange={onSelectedIndexChange}
        onSelectItem={onAddText}
        onClose={onClose}
      />
    </div>
  );
});

ChatTextareaContextMenu.displayName = 'ChatTextareaContextMenu';
