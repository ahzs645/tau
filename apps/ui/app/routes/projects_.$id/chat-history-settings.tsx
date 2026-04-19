import { useCallback } from 'react';
import { Settings, Download } from 'lucide-react';
import { FloatingPanelMenuButton } from '#components/ui/floating-panel.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.js';
import { useChatContext } from '#hooks/use-chat.js';
import { downloadBlob } from '@taucad/utils/file';
import { serializeTranscript } from '#utils/chat.utils.js';
import { toSnakeCase } from '#utils/string.utils.js';

export function ChatHistorySettings(): React.ReactNode {
  const { chat, chatName } = useChatContext();

  const handleExport = useCallback(() => {
    const transcript = serializeTranscript(chat.messages, chatName);
    const blob = new Blob([transcript], {
      type: 'text/markdown;charset=utf-8',
    });
    const timestamp = new Date().toISOString().slice(0, 16).replaceAll(':', '-');
    const snakeName = toSnakeCase(chatName) || 'chat_transcript';
    downloadBlob(blob, `${snakeName}_${timestamp}.md`);
  }, [chat.messages, chatName]);

  return (
    <DropdownMenu modal={false}>
      <FloatingPanelMenuButton asChild tooltip='Chat settings' aria-label='Chat settings'>
        <DropdownMenuTrigger>
          <Settings className='size-4' />
        </DropdownMenuTrigger>
      </FloatingPanelMenuButton>
      <DropdownMenuContent
        align='end'
        side='bottom'
        className='w-56'
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
      >
        <DropdownMenuLabel>Export</DropdownMenuLabel>
        <DropdownMenuItem disabled={chat.messages.length === 0} onSelect={handleExport}>
          <Download />
          Export Transcript
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
