import { useSelector } from '@xstate/react';
import { useCallback } from 'react';
import { Sparkles } from 'lucide-react';
import type { KernelProvider, KernelError, KernelStackFrame } from '@taucad/types';
import { languageFromKernel } from '@taucad/types/constants';
import { messageRole, messageStatus } from '@taucad/chat/constants';
import { Button } from '#components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { FileLink } from '#components/files/file-link.js';
import { MarkdownViewer } from '#components/markdown/markdown-viewer.js';
import { KeyShortcut } from '#components/ui/key-shortcut.js';
import { useChatActions } from '#hooks/use-chat.js';
import { useChats } from '#hooks/use-chats.js';
import { useKeydown } from '#hooks/use-keydown.js';
import { cookieName } from '#constants/cookie.constants.js';
import { useBuild } from '#hooks/use-build.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cn } from '#utils/ui.utils.js';
import { createMessage } from '#utils/chat.utils.js';
import { decodeTextFile } from '#utils/filesystem.utils.js';
import { useModels } from '#hooks/use-models.js';
import { defaultChatModel } from '#constants/chat.constants.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { useKernel } from '#hooks/use-kernel.js';
import { useChatSnapshot } from '#hooks/use-chat-snapshot.js';

const shiftKeyCombination = { key: 'Shift' } as const;

type FormatErrorPromptOptions = {
  error: KernelError;
  filePath: string;
  code: string;
  kernel: KernelProvider;
};

/**
 * Formats a kernel error into a prompt for AI assistance.
 */
function formatErrorPrompt({ error, filePath, code, kernel }: FormatErrorPromptOptions): string {
  // Format error location
  const locationText = error.location
    ? `Line ${error.location.startLineNumber}, Column ${error.location.startColumn}`
    : 'Unknown location';

  // Format stack trace
  const stackTraceText = error.stackFrames
    ?.map(
      (frame, index) =>
        `    ${index + 1}. ${frame.functionName ?? '<anonymous>'} (${frame.fileName ?? '<unknown>'}:${frame.lineNumber}:${frame.columnNumber})`,
    )
    .join('\n');

  const errorText = `- **Message:** ${error.message}
- **Location:** ${locationText}
${stackTraceText ? `- **Stack Trace:**\n${stackTraceText}` : ''}`;

  // Get code context around the error's line (if available)
  let codeContext = '';
  const errorLine = error.location?.startLineNumber;
  if (code && errorLine) {
    const lines = code.split('\n');
    const startLine = Math.max(0, errorLine - 3);
    const endLine = Math.min(lines.length, errorLine + 3);
    const contextLines = lines.slice(startLine, endLine);
    codeContext = contextLines
      .map((line, index) => {
        const lineNumber = startLine + index + 1;
        const marker = lineNumber === errorLine ? '> ' : '  ';

        return `${marker}${lineNumber} | ${line}`;
      })
      .join('\n');
  }

  return `I'm getting an error in my ${kernel} code and need help fixing it.

**File:** ${filePath}

${errorText}

${
  codeContext
    ? `**Code Context:**
\`\`\`
${codeContext}
\`\`\`
`
    : ''
}
${
  code
    ? `**Full Code:**
\`\`\`${languageFromKernel[kernel]}
${code}
\`\`\`
`
    : ''
}

Please analyze the error and fix the code. Focus on:
1. Identifying the root cause of the error
2. Providing a corrected version of the code
3. Explaining what was wrong and why the fix works

Please update the code to resolve this error.`;
}

function StackFrame({ frame, index }: { readonly frame: KernelStackFrame; readonly index: number }): React.JSX.Element {
  const fileName = frame.fileName ?? '<unknown>';
  const isClickable = Boolean(frame.fileName);

  const locationContent = (
    <>
      <span className="shrink-0 text-muted-foreground">(</span>
      <span className="min-w-0 truncate text-muted-foreground" dir="rtl" title={fileName}>
        {fileName}
      </span>
      {frame.lineNumber !== undefined && frame.columnNumber !== undefined ? (
        <span className="shrink-0 text-muted-foreground">
          :{frame.lineNumber}:{frame.columnNumber}
        </span>
      ) : null}
      <span className="shrink-0 text-muted-foreground">)</span>
    </>
  );

  return (
    <div className="flex min-w-0 items-center gap-2 font-mono text-[0.625rem]">
      <span className="w-3 shrink-0 text-right text-muted-foreground">{index + 1}</span>
      <span className="shrink-0 text-muted-foreground">|</span>
      <span className="shrink-0 text-foreground">{frame.functionName ?? '<anonymous>'}</span>
      {isClickable ? (
        <FileLink
          path={frame.fileName!}
          lineNumber={frame.lineNumber}
          column={frame.columnNumber}
          className="flex min-w-0 hover:text-foreground"
        >
          {locationContent}
        </FileLink>
      ) : (
        <div className="flex min-w-0">{locationContent}</div>
      )}
    </div>
  );
}

function getBasename(path: string): string {
  return path.split('/').pop() ?? path;
}

function formatLocation(fileName?: string, lineNumber?: number, column?: number): string {
  if (!fileName) {
    return '';
  }

  const basename = getBasename(fileName);

  if (lineNumber === undefined) {
    return basename;
  }

  if (column === undefined) {
    return `${basename}:${lineNumber}`;
  }

  return `${basename}:${lineNumber}:${column}`;
}

function ErrorStackTrace({
  message,
  fileName,
  startLineNumber,
  startColumn,
  stackFrames,
  onFixWithAi,
}: {
  readonly message: string;
  readonly fileName?: string;
  readonly startLineNumber?: number;
  readonly startColumn?: number;
  readonly stackFrames?: KernelStackFrame[];
  readonly onFixWithAi?: (createNewChat: boolean) => void;
}): React.JSX.Element {
  const isLocationClickable = Boolean(fileName && startLineNumber);
  const locationText = formatLocation(fileName, startLineNumber, startColumn);

  // Track shift key state for "new chat" functionality
  const { isKeyPressed: isShiftHeld, formattedKeyCombination: shiftKey } = useKeydown(
    shiftKeyCombination,
    () => {
      // No-op callback - we only care about isKeyPressed state
    },
    { preventDefault: false, stopPropagation: false },
  );

  return (
    <div className="flex flex-col gap-2 rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs">
      {/* Error message with Fix button */}
      <div className="flex flex-row items-start justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-x-1.5 font-medium text-destructive">
          <MarkdownViewer
            className={cn(
              'inline w-auto! text-xs text-inherit',
              // Inline-code styles
              '[&_code]:text-destructive',
              '[&_code]:border-destructive/30',
              '[&_code]:bg-background/80',
            )}
          >
            {message}
          </MarkdownViewer>
          {locationText ? (
            <span className="font-mono font-normal text-muted-foreground">
              (
              {isLocationClickable ? (
                <FileLink
                  path={fileName!}
                  lineNumber={startLineNumber}
                  column={startColumn}
                  className="hover:text-foreground"
                >
                  {locationText}
                </FileLink>
              ) : (
                locationText
              )}
              )
            </span>
          ) : null}
        </div>
        {onFixWithAi ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                className="size-6 shrink-0 border-destructive/30 bg-background/80 hover:border-destructive/50 hover:bg-background"
                onClick={() => {
                  onFixWithAi(isShiftHeld);
                }}
              >
                <Sparkles className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="flex flex-col gap-1">
              <span>{isShiftHeld ? 'Fix in new chat' : 'Fix with AI'}</span>
              <span className="flex items-center gap-1 text-xs opacity-70">
                <KeyShortcut variant="tooltip">{shiftKey}</KeyShortcut> for new chat
              </span>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {/* Stack trace */}
      {stackFrames && stackFrames.length > 0 ? (
        <div className="space-y-1">
          <div className="font-medium text-muted-foreground">Stack trace:</div>
          <div className="space-y-0.5 rounded border border-destructive/20 bg-background/80 p-2">
            {stackFrames.map((frame, index) => (
              <StackFrame
                key={`${frame.functionName}-${frame.fileName}-${frame.lineNumber}-${frame.columnNumber}`}
                frame={frame}
                index={index}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ChatStackTrace({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactNode {
  const { getMainFilename, cadRef, fileExplorerRef, buildId, setLastChatId } = useBuild();
  const fileManager = useFileManager();
  const { createChat } = useChats(buildId);
  // Get the active file path from file explorer
  const activeFilePath = useSelector(fileExplorerRef, (state) => state.context.activeFilePath);

  // Get all kernel errors for the active file
  const errors = useSelector(cadRef, (state) => {
    if (!activeFilePath) {
      return undefined;
    }

    return state.context.kernelErrors.get(activeFilePath);
  });

  const { sendMessage } = useChatActions();
  const { selectedModel } = useModels();
  const [, setIsChatOpen] = useCookie(cookieName.chatOpHistory, true);
  const { kernel } = useKernel();
  const snapshot = useChatSnapshot();

  const handleFixWithAi = useCallback(
    async (errorIndex: number, createNewChat: boolean) => {
      if (!errors || errors.length === 0) {
        return;
      }

      const targetError = errors[errorIndex];
      if (!targetError) {
        return;
      }

      // Get the current code and build context
      const filePath = await getMainFilename();
      const fileContent = await fileManager.readFile(filePath);
      const code = decodeTextFile(fileContent);

      // Format the error into a prompt
      const errorPrompt = formatErrorPrompt({
        error: targetError,
        filePath,
        code,
        kernel,
      });

      // Open the chat panel
      setIsChatOpen(true);

      // Create the error fixing message
      const message = createMessage({
        content: errorPrompt,
        role: messageRole.user,
        metadata: {
          model: selectedModel?.id ?? defaultChatModel,
          status: messageStatus.pending,
          kernel,
          snapshot,
        },
      });

      // Create a new chat if shift was held
      if (createNewChat) {
        // Create the chat with the message already included.
        // When ChatProvider loads this chat, it will see the pending user message
        // and automatically trigger the AI response via regenerate().
        const newChat = await createChat({
          name: 'New chat',
          messages: [message],
        });
        setLastChatId(newChat.id);
      } else {
        // Send to current chat
        sendMessage(message);
      }
    },
    [
      errors,
      getMainFilename,
      fileManager,
      kernel,
      setIsChatOpen,
      createChat,
      setLastChatId,
      selectedModel?.id,
      sendMessage,
      snapshot,
    ],
  );

  if (!errors || errors.length === 0) {
    return null;
  }

  return (
    <div {...props} className={cn('space-y-2', className)}>
      {errors.map((error, errorIndex) => {
        // Create a unique key from error properties
        const errorKey = `${error.message}-${error.location?.startLineNumber ?? 'unknown'}-${error.location?.startColumn ?? 'unknown'}`;

        return (
          <ErrorStackTrace
            key={errorKey}
            message={error.message}
            fileName={error.location?.fileName}
            startLineNumber={error.location?.startLineNumber}
            startColumn={error.location?.startColumn}
            stackFrames={error.stackFrames}
            onFixWithAi={async (createNewChat) => handleFixWithAi(errorIndex, createNewChat)}
          />
        );
      })}
    </div>
  );
}
