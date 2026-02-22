import { useParams } from 'react-router';
import { useSelector } from '@xstate/react';
import { toast } from 'sonner';
import type { Route } from './+types/route.js';
import { ChatInterface } from '#routes/builds_.$id/chat-interface.js';
import { BuildProvider, useBuild } from '#hooks/use-build.js';
import type { Handle } from '#types/matches.types.js';
import { ChatProvider, useChatContext } from '#hooks/use-chat.js';
import { BuildNameEditor } from '#routes/builds_.$id/build-name-editor.js';
import { ViewContextProvider } from '#routes/builds_.$id/chat-interface-view-context.js';
import { useKeybinding } from '#hooks/use-keyboard.js';
import { BuildCommandPaletteItems } from '#routes/builds_.$id/build-command-items.js';
import { FileManagerProvider } from '#hooks/use-file-manager.js';
import { useChatRpcConnection } from '#hooks/use-chat-rpc-socket.js';
import { MonacoModelServiceProvider } from '#hooks/use-monaco-model-service.js';
import { useFlushOnClose } from '#hooks/use-flush-on-close.js';
import { debugKernelConfig } from '#constants/kernel-worker.constants.js';

// Define provider component at module level for stable reference across HMR
function RouteProvider({ children }: { readonly children?: React.ReactNode }): React.JSX.Element {
  const { id } = useParams();
  return (
    <FileManagerProvider buildId={id} rootDirectory={`/builds/${id}`}>
      <BuildProvider buildId={id!} kernelConfig={debugKernelConfig}>
        <MonacoModelServiceProvider>{children}</MonacoModelServiceProvider>
      </BuildProvider>
    </FileManagerProvider>
  );
}

export const handle: Handle = {
  breadcrumb(match) {
    const { id } = match.params as Route.LoaderArgs['params'];

    return [
      //
      <BuildNameEditor key={`${id}-build-name-editor`} />,
      // Disabled until publishing is implemented
      // <ChatModeSelector key={`${id}-chat-mode-selector`} />
    ];
  },
  commandPalette(match) {
    return <BuildCommandPaletteItems match={match} />;
  },
  providers: () => RouteProvider,
  enableFloatingSidebar: true,
};

// Chat component - handles keyboard shortcuts and WebSocket tool connection
function Chat(): React.JSX.Element {
  const { activeChatId, isLoadingChat } = useChatContext();

  // Connect to Socket.IO for tool execution (uses singleton service)
  useChatRpcConnection({
    chatId: activeChatId,
    enabled: !isLoadingChat,
  });

  useKeybinding(
    {
      key: 's',
      modKey: true,
    },
    () => {
      toast.success('Your build is saved automatically');
    },
  );

  return <ChatInterface />;
}

// Wrapper component that has access to build context and can configure ChatProvider
function ChatWithProvider(): React.JSX.Element {
  const { buildId, buildRef, editorRef } = useBuild();
  const name = useSelector(buildRef, (state) => state.context.build?.name);
  const description = useSelector(buildRef, (state) => state.context.build?.description);
  const activeChatId = useSelector(editorRef, (state) => state.context.lastChatId);

  return (
    <ViewContextProvider>
      <ChatProvider chatId={activeChatId} resourceId={buildId}>
        {name ? <title>{name}</title> : null}
        {description ? <meta name="description" content={description} /> : null}
        <FlushOnCloseGuard />
        <Chat />
      </ChatProvider>
    </ViewContextProvider>
  );
}

/**
 * Inner component that wires up the flush-on-close handler.
 * Needs to be a child of both BuildProvider and ChatProvider to access all refs.
 */
function FlushOnCloseGuard(): React.JSX.Element {
  const { buildRef, editorRef } = useBuild();
  const { persistenceActorRef, draftActorRef } = useChatContext();

  useFlushOnClose(() => {
    buildRef.send({ type: 'flushNow' });
  });
  useFlushOnClose(() => {
    editorRef.send({ type: 'flushNow' });
  });
  useFlushOnClose(() => {
    persistenceActorRef.send({ type: 'flushNow' });
  });
  useFlushOnClose(() => {
    draftActorRef.send({ type: 'flushNow' });
  });

  // eslint-disable-next-line react/jsx-no-useless-fragment -- Headless component
  return <></>;
}

export default function ChatRoute(): React.JSX.Element {
  return <ChatWithProvider />;
}
