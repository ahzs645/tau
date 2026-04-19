import { useParams } from 'react-router';
import { useSelector } from '@xstate/react';
import { toast } from 'sonner';
import type { Route } from './+types/route.js';
import { ChatInterface } from '#routes/projects_.$id/chat-interface.js';
import { ProjectProvider, useProject } from '#hooks/use-project.js';
import type { Handle } from '#types/matches.types.js';
import { ChatProvider, useChatContext } from '#hooks/use-chat.js';
import { ProjectNameEditor } from '#routes/projects_.$id/project-name-editor.js';
import { ViewContextProvider } from '#routes/projects_.$id/chat-interface-view-context.js';
import { useKeybinding } from '#hooks/use-keyboard.js';
import { ProjectCommandPaletteItems } from '#routes/projects_.$id/project-command-items.js';
import { ProjectExportAction } from '#routes/projects_.$id/project-export-action.js';
import { FileManagerProvider, SharedWorkerGate } from '#hooks/use-file-manager.js';
import { ChatRpcSocketProvider, useChatRpcConnection } from '#hooks/use-chat-rpc-socket.js';
import { MonacoModelServiceProvider } from '#hooks/use-monaco-model-service.js';
import { useFlushOnClose } from '#hooks/use-flush-on-close.js';
import { useBlockBrowserNavigation } from '#hooks/use-block-browser-navigation.js';
import { debugKernelOptions } from '#constants/kernel-worker.constants.js';
import { WebglContextTrackerProvider } from '#hooks/use-webgl-context-tracker.js';

// Define provider component at module level for stable reference across HMR
function RouteProvider({ children }: { readonly children?: React.ReactNode }): React.JSX.Element {
  const { id } = useParams();
  return (
    <SharedWorkerGate>
      <FileManagerProvider projectId={id} rootDirectory={`/projects/${id}`}>
        <ChatRpcSocketProvider>
          <WebglContextTrackerProvider>
            <ProjectProvider projectId={id!} kernelOptions={debugKernelOptions}>
              <MonacoModelServiceProvider>{children}</MonacoModelServiceProvider>
            </ProjectProvider>
          </WebglContextTrackerProvider>
        </ChatRpcSocketProvider>
      </FileManagerProvider>
    </SharedWorkerGate>
  );
}

export const handle: Handle = {
  breadcrumb(match) {
    const { id } = match.params as Route.LoaderArgs['params'];

    return [
      //
      <ProjectNameEditor key={`${id}-project-name-editor`} />,
      // Disabled until publishing is implemented
      // <ChatModeSelector key={`${id}-chat-mode-selector`} />
    ];
  },
  actions() {
    return <ProjectExportAction />;
  },
  commandPalette(match) {
    return <ProjectCommandPaletteItems match={match} />;
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
      toast.success('Your project is saved automatically');
    },
  );

  return <ChatInterface />;
}

// Wrapper component that has access to project context and can configure ChatProvider
function ChatWithProvider(): React.JSX.Element {
  const { projectId, projectRef, editorRef } = useProject();
  const name = useSelector(projectRef, (state) => state.context.project?.name);
  const description = useSelector(projectRef, (state) => state.context.project?.description);
  const activeChatId = useSelector(editorRef, (state) => state.context.lastChatId);

  return (
    <ViewContextProvider>
      <ChatProvider chatId={activeChatId} resourceId={projectId}>
        {name ? <title>{name}</title> : null}
        {description ? <meta name='description' content={description} /> : null}
        <FlushOnCloseGuard />
        <Chat />
      </ChatProvider>
    </ViewContextProvider>
  );
}

/**
 * Inner component that wires up the flush-on-close handler.
 * Needs to be a child of both ProjectProvider and ChatProvider to access all refs.
 */
function FlushOnCloseGuard(): React.JSX.Element {
  const { projectRef, editorRef } = useProject();
  const { persistenceActorRef, draftActorRef } = useChatContext();

  useFlushOnClose(() => {
    projectRef.send({ type: 'flushNow' });
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

  // oxlint-disable-next-line react/jsx-no-useless-fragment -- Headless component
  return <></>;
}

export default function ChatRoute(): React.JSX.Element {
  useBlockBrowserNavigation();

  return <ChatWithProvider />;
}
