import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { messageRole } from '@taucad/chat/constants';
import type { UsageData } from '@taucad/chat';
import { useChatActions, useChatSelector } from '#hooks/use-chat.js';
import { serializeMessage } from '#utils/chat.utils.js';
import { ChatMessageReasoning } from '#routes/projects_.$id/chat-message-reasoning.js';
import { ChatMessageDataUsage } from '#routes/projects_.$id/chat-message-data-usage.js';
import { ChatMessageContextCompaction } from '#routes/projects_.$id/chat-message-context-compaction.js';
import { ChatMessageText } from '#routes/projects_.$id/chat-message-text.js';
import { Tooltip, TooltipTrigger, TooltipContent } from '#components/ui/tooltip.js';
import { CopyButton } from '#components/copy-button.js';
import { Button } from '#components/ui/button.js';
import { cn } from '#utils/ui.utils.js';
import { menuItemVariants, menuSubTriggerOpenClass } from '#components/ui/menu.variants.js';
import { When } from '#components/ui/utils/when.js';
import { ChatTextarea } from '#components/chat/chat-textarea.js';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '#components/ui/dropdown-menu.js';
import { ChatModelSelector } from '#components/chat/chat-model-selector.js';
import { ChatMessageToolWebSearch } from '#routes/projects_.$id/chat-message-tool-web-search.js';
import { ChatMessageToolWebBrowser } from '#routes/projects_.$id/chat-message-tool-web-browser.js';
import { ChatMessageToolFileEdit } from '#routes/projects_.$id/chat-message-tool-edit-file.js';
import { ChatMessageToolTestModel } from '#routes/projects_.$id/chat-message-tool-test-model.js';
import { ChatMessageToolEditTests } from '#routes/projects_.$id/chat-message-tool-edit-tests.js';
import { ChatMessageToolReadFile } from '#routes/projects_.$id/chat-message-tool-read-file.js';
import { ChatMessageToolListDirectory } from '#routes/projects_.$id/chat-message-tool-list-directory.js';
import { ChatMessageToolCreateFile } from '#routes/projects_.$id/chat-message-tool-create-file.js';
import { ChatMessageToolDeleteFile } from '#routes/projects_.$id/chat-message-tool-delete-file.js';
import { ChatMessageToolGrep } from '#routes/projects_.$id/chat-message-tool-grep.js';
import { ChatMessageToolGlobSearch } from '#routes/projects_.$id/chat-message-tool-glob-search.js';
import { ChatMessageToolGetKernelResult } from '#routes/projects_.$id/chat-message-tool-get-kernel-result.js';
import { ChatMessageToolScreenshot } from '#routes/projects_.$id/chat-message-tool-screenshot.js';
import { ChatMessagePartUnknown } from '#routes/projects_.$id/chat-message-tool-unknown.js';
import { ChatMessageToolTransfer } from '#routes/projects_.$id/chat-message-tool-transfer.js';
import { ChatMessageFile } from '#routes/projects_.$id/chat-message-file.js';
import { ChatMessagePlanning } from '#routes/projects_.$id/chat-message-planning.js';

type ChatMessageProperties = {
  readonly messageId: string;
};

export const ChatMessage = memo(function ({ messageId }: ChatMessageProperties): React.JSX.Element {
  const userMessageCollapseRowThreshold = 8;
  const userMessageCollapseCharacterThreshold = 900;

  const message = useChatSelector((state) => state.messagesById.get(messageId));
  const displayMessage = useChatSelector((state) => state.messageEdits[messageId] ?? state.messagesById.get(messageId));
  const fileParts = useChatSelector(
    (state) => state.messagesById.get(messageId)?.parts.filter((part) => part.type === 'file') ?? [],
  );
  const usageParts = useChatSelector((state) => {
    const message_ = state.messageEdits[messageId] ?? state.messagesById.get(messageId);
    if (!message_) {
      return [];
    }

    const usageDataParts: UsageData[] = [];
    for (const part of message_.parts) {
      if (part.type === 'data-usage') {
        usageDataParts.push(part.data);
      }
    }

    return usageDataParts;
  });
  const { editMessage, retryMessage, startEditingMessage, exitEditMode } = useChatActions();
  const [isEditing, setIsEditing] = useState(false);

  const isUser = message?.role === messageRole.user;
  const isCollapsedUserMessage = isUser && !isEditing;

  const collapsedUserRows = useMemo(() => {
    if (!isCollapsedUserMessage || !displayMessage || fileParts.length > 0) {
      return [];
    }

    const rows: string[] = [];
    for (const part of displayMessage.parts) {
      if (part.type !== 'text') {
        continue;
      }

      const normalizedText = part.text.replaceAll('\r\n', '\n');
      for (const line of normalizedText.split('\n')) {
        if (line.length === 0) {
          rows.push('');
          continue;
        }

        for (let start = 0; start < line.length; start += 220) {
          rows.push(line.slice(start, start + 220));
        }
      }
    }

    return rows.length > 0 ? rows : [''];
  }, [displayMessage, fileParts.length, isCollapsedUserMessage]);

  const collapsedUserCharacterCount = useMemo(() => {
    if (!isCollapsedUserMessage || !displayMessage || fileParts.length > 0) {
      return 0;
    }

    let characterCount = 0;
    for (const part of displayMessage.parts) {
      if (part.type === 'text') {
        characterCount += part.text.length;
      }
    }

    return characterCount;
  }, [displayMessage, fileParts.length, isCollapsedUserMessage]);

  const shouldCollapseUserMessage =
    isCollapsedUserMessage &&
    (collapsedUserRows.length > userMessageCollapseRowThreshold ||
      collapsedUserCharacterCount > userMessageCollapseCharacterThreshold);
  const shouldVirtualizeCollapsedUserMessage = shouldCollapseUserMessage && fileParts.length === 0;

  const renderCollapsedUserRow = useCallback(
    (index: number) => {
      const row = collapsedUserRows[index];
      if (typeof row !== 'string') {
        return null;
      }

      return <p className='text-sm leading-relaxed wrap-break-word whitespace-pre-wrap text-foreground/90'>{row}</p>;
    },
    [collapsedUserRows],
  );

  if (!message || !displayMessage) {
    return <div>Message not found</div>;
  }

  const handleEditClick = () => {
    if (!isUser) {
      return;
    }

    if (!isEditing) {
      startEditingMessage(messageId);
    }

    setIsEditing((previous) => !previous);
  };

  return (
    <article
      className={cn('group/chat-message flex w-full flex-row items-start', isUser && 'items-end gap-2 space-x-reverse')}
    >
      <div
        className={cn(
          'flex flex-col space-y-2 overflow-y-auto',
          'w-full',
          // Vary width for user and assistant messages to achieve visual differentiation
          isUser ? 'mx-2' : 'mx-4',
        )}
      >
        <When shouldRender={isUser ? isEditing : false}>
          <ChatTextarea
            mode='edit'
            className='rounded-sm'
            onSubmit={async (event) => {
              editMessage(messageId, event.content, event.model, event.metadata, event.imageUrls);
              exitEditMode();
              setIsEditing(false);
            }}
            onEscapePressed={() => {
              exitEditMode();
              setIsEditing(false);
            }}
            onBlur={() => {
              exitEditMode();
              setIsEditing(false);
            }}
          />
        </When>
        <When shouldRender={!isEditing}>
          <div
            className={cn(
              'flex flex-col gap-1',
              isUser && 'cursor-pointer rounded-sm border bg-background px-3 py-1 hover:border-primary',
              shouldCollapseUserMessage && 'max-h-58.5 overflow-hidden',
              fileParts.length > 0 && 'pt-3',
            )}
            onClick={handleEditClick}
          >
            {fileParts.length > 0 ? (
              <div className='flex flex-row gap-2'>
                {fileParts.map((part) => (
                  <ChatMessageFile key={part.url} part={part} />
                ))}
              </div>
            ) : null}
            {shouldVirtualizeCollapsedUserMessage ? (
              <Virtuoso
                className='h-58.5'
                totalCount={collapsedUserRows.length}
                itemContent={renderCollapsedUserRow}
                components={{
                  List: (properties) => <div {...properties} className='flex flex-col gap-1 pr-1' />,
                  Header: () => <div className='h-0.5' />,
                  Footer: () => <div className='h-0.5' />,
                }}
              />
            ) : (
              /* oxlint-disable-next-line complexity -- This is a complex switch statement, we want to keep it simple. */
              displayMessage.parts.map((part, index) => {
                switch (part.type) {
                  case 'text': {
                    return (
                      <ChatMessageText
                        // oxlint-disable-next-line react/no-array-index-key -- Index is stable
                        key={`${displayMessage.id}-message-part-${index}`}
                        part={part}
                      />
                    );
                  }

                  case 'reasoning': {
                    const hasPartsAfter = index < displayMessage.parts.length - 1;
                    return (
                      <ChatMessageReasoning
                        // oxlint-disable-next-line react/no-array-index-key -- Index is stable
                        key={`${displayMessage.id}-message-part-${index}`}
                        part={part}
                        hasContent={hasPartsAfter}
                      />
                    );
                  }

                  case 'step-start': {
                    // We are not rendering step-start parts.

                    return null;
                  }

                  case 'file': {
                    // Files are rendered at the top of the message
                    return null;
                  }

                  case 'dynamic-tool': {
                    return <ChatMessagePartUnknown key={part.toolCallId} part={part} />;
                  }

                  case 'source-url': {
                    throw new Error('Source URL rendering is not implemented');
                  }

                  case 'source-document': {
                    throw new Error('Source document rendering is not implemented');
                  }

                  // TOOLS
                  case 'tool-web_search': {
                    const hasPartsAfter = index < displayMessage.parts.length - 1;
                    return <ChatMessageToolWebSearch key={part.toolCallId} part={part} hasContent={hasPartsAfter} />;
                  }

                  case 'tool-web_browser': {
                    const hasPartsAfter = index < displayMessage.parts.length - 1;
                    return <ChatMessageToolWebBrowser key={part.toolCallId} part={part} hasContent={hasPartsAfter} />;
                  }

                  case 'tool-edit_file': {
                    return <ChatMessageToolFileEdit key={part.toolCallId} part={part} />;
                  }

                  case 'tool-test_model': {
                    return <ChatMessageToolTestModel key={part.toolCallId} part={part} />;
                  }

                  case 'tool-edit_tests': {
                    return <ChatMessageToolEditTests key={part.toolCallId} part={part} />;
                  }

                  case 'tool-transfer_to_cad_expert': {
                    return <ChatMessageToolTransfer key={part.toolCallId} part={part} />;
                  }

                  case 'tool-transfer_to_research_expert': {
                    return <ChatMessageToolTransfer key={part.toolCallId} part={part} />;
                  }

                  case 'tool-transfer_back_to_supervisor': {
                    return <ChatMessageToolTransfer key={part.toolCallId} part={part} />;
                  }

                  // FILESYSTEM TOOLS
                  case 'tool-read_file': {
                    return <ChatMessageToolReadFile key={part.toolCallId} part={part} />;
                  }

                  case 'tool-list_directory': {
                    return <ChatMessageToolListDirectory key={part.toolCallId} part={part} />;
                  }

                  case 'tool-create_file': {
                    return <ChatMessageToolCreateFile key={part.toolCallId} part={part} />;
                  }

                  case 'tool-delete_file': {
                    return <ChatMessageToolDeleteFile key={part.toolCallId} part={part} />;
                  }

                  case 'tool-grep': {
                    return <ChatMessageToolGrep key={part.toolCallId} part={part} />;
                  }

                  case 'tool-glob_search': {
                    return <ChatMessageToolGlobSearch key={part.toolCallId} part={part} />;
                  }

                  case 'tool-get_kernel_result': {
                    return <ChatMessageToolGetKernelResult key={part.toolCallId} part={part} />;
                  }

                  case 'tool-screenshot': {
                    return <ChatMessageToolScreenshot key={part.toolCallId} part={part} />;
                  }

                  case 'data-usage': {
                    // Usage data parts are rendered separately in the footer
                    return null;
                  }

                  case 'data-context-compaction': {
                    return (
                      <ChatMessageContextCompaction
                        // oxlint-disable-next-line react/no-array-index-key -- Index is stable
                        key={`${displayMessage.id}-compaction-${index}`}
                        data={part.data}
                      />
                    );
                  }

                  case 'data-context-usage': {
                    return null;
                  }

                  default: {
                    const unknownPart: never = part;
                    return <ChatMessagePartUnknown key={String(unknownPart)} part={unknownPart} />;
                  }
                }
              })
            )}
          </div>
        </When>
        <ChatMessagePlanning messageId={messageId} />
        <When shouldRender={!isUser}>
          <div className='mt-1 flex flex-row items-start justify-start text-muted-foreground'>
            <CopyButton
              tooltipContentProperties={{ side: 'bottom' }}
              size='icon'
              getText={() => serializeMessage(displayMessage)}
              tooltip='Copy message'
              className='size-7'
            />
            <Tooltip>
              <DropdownMenu>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button size='xs' variant='ghost' className='h-7 gap-1 has-[>svg]:px-1.5'>
                      <RefreshCw className='size-4' />
                      <ChevronDown className='size-4' />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <DropdownMenuContent align='start' side='top' className='min-w-50'>
                  <DropdownMenuLabel>Switch model</DropdownMenuLabel>
                  <ChatModelSelector
                    popoverProperties={{ side: 'right', align: 'start' }}
                    className='h-fit w-full'
                    onSelect={(modelId) => {
                      retryMessage(messageId, modelId);
                    }}
                  >
                    {({ selectedModel }) => (
                      <button
                        type='button'
                        className={cn(
                          menuItemVariants(),
                          menuSubTriggerOpenClass,
                          'group w-full hover:bg-neutral/30 hover:text-foreground',
                        )}
                      >
                        <span>{selectedModel?.name ?? 'Offline'}</span>
                        <ChevronRight className='ml-auto size-3.5 text-muted-foreground transition-transform duration-200 ease-in-out group-data-[state=open]:rotate-90' />
                      </button>
                    )}
                  </ChatModelSelector>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className='flex justify-between'
                    onClick={() => {
                      retryMessage(messageId);
                    }}
                  >
                    <p>Try again</p>
                    <RefreshCw className='text-muted-foreground' />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <TooltipContent side='bottom'>Switch model</TooltipContent>
            </Tooltip>
            <div className='flex flex-row items-center justify-end gap-1'>
              {usageParts.length > 0 ? <ChatMessageDataUsage usageParts={usageParts} /> : null}
            </div>
          </div>
        </When>
      </div>
    </article>
  );
});
