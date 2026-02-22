import { memo } from 'react';
import { useSelector } from '@xstate/react';
import { ChatHistory } from '#routes/builds_.$id/chat-history.js';
import { ChatFileTree } from '#routes/builds_.$id/chat-file-tree.js';
import { ChatParameters } from '#routes/builds_.$id/chat-parameters.js';
import { ChatEditorLayout } from '#routes/builds_.$id/chat-editor-layout.js';
import { ChatDetails } from '#routes/builds_.$id/chat-details.js';
import { ChatConverter } from '#routes/builds_.$id/chat-converter.js';
import { BuildNotFound } from '#routes/builds_.$id/build-not-found.js';
import { cn } from '#utils/ui.utils.js';
import { ChatInterfaceNav } from '#routes/builds_.$id/chat-interface-nav.js';
import { Tabs, TabsContent } from '#components/ui/tabs.js';
import { useChatInterfaceState } from '#routes/builds_.$id/use-chat-interface-state.js';
import { ViewerDockview } from '#routes/builds_.$id/chat-viewer-dockview.js';
import { Drawer, DrawerContent, DrawerTitle, DrawerDescription } from '#components/ui/drawer.js';
import { useBuild } from '#hooks/use-build.js';

export const ChatInterfaceMobile = memo(function (): React.JSX.Element {
  const { activeTab, handleTabChange, drawerOpen, handleDrawerChange, snapPoints, activeSnapPoint, handleSnapChange } =
    useChatInterfaceState();

  const { buildRef } = useBuild();
  const isBuildError = useSelector(buildRef, (state) => state.matches('error'));

  const isViewerTab = activeTab === 'viewer';

  return (
    <div className={cn('absolute inset-0 size-full', '[--nav-height:calc(var(--spacing)*10)]', 'md:hidden')}>
      {/* Main viewer - always visible */}
      <div
        className="relative h-full transition-all duration-200 ease-linear"
        style={{
          paddingBottom: isViewerTab ? '0' : `calc(${Number(activeSnapPoint) - 0.07} * 100dvh)`,
        }}
      >
        <ViewerDockview />

        {/* Build Not Found Overlay */}
        {isBuildError ? <BuildNotFound /> : null}
      </div>

      <Drawer
        handleOnly
        open={drawerOpen}
        snapPoints={snapPoints}
        activeSnapPoint={activeSnapPoint}
        setActiveSnapPoint={handleSnapChange}
        modal={false}
        onOpenChange={handleDrawerChange}
      >
        <DrawerTitle className="sr-only" id="drawer-title">
          Chat Interface
        </DrawerTitle>
        <DrawerDescription className="sr-only" id="drawer-description">
          Chat Interface - use navigation tabs to switch between panels
        </DrawerDescription>

        {/* Drawer for content panels */}
        <DrawerContent
          aria-labelledby="drawer-title"
          aria-describedby="drawer-description"
          className={cn(
            'flex-1 rounded-t-lg border-t bg-sidebar',
            'z-40', // Position below the navigation tabs
            //
            'data-[vaul-drawer-direction=bottom]:max-h-[100dvh]',
            'data-[vaul-drawer-direction=bottom]:mt-0',
            '[&_[data-slot=drawer-handle-indicator]]:bg-sidebar-primary/15',
          )}
          style={{
            height: '100%',
          }}
        >
          {/* Tab contents */}
          <Tabs
            value={activeTab}
            className="flex h-full flex-col p-0"
            style={{
              height: isViewerTab ? '100dvh' : `calc(${Number(activeSnapPoint)} * 100dvh - var(--spacing)*12)`,
            }}
            onValueChange={handleTabChange}
          >
            <TabsContent enableAnimation={false} value="chat" className="flex h-full flex-col">
              <ChatHistory />
            </TabsContent>
            <TabsContent enableAnimation={false} value="files" className="flex h-full flex-col">
              <ChatFileTree />
            </TabsContent>
            <TabsContent enableAnimation={false} value="parameters" className="flex h-full flex-col">
              <ChatParameters />
            </TabsContent>
            <TabsContent enableAnimation={false} value="viewer" className="flex h-full flex-col" />
            <TabsContent enableAnimation={false} value="editor" className="flex h-full flex-col">
              <ChatEditorLayout />
            </TabsContent>
            <TabsContent enableAnimation={false} value="details" className="flex h-full flex-col">
              <ChatDetails />
            </TabsContent>
            <TabsContent enableAnimation={false} value="converter" className="flex h-full flex-col">
              <ChatConverter />
            </TabsContent>
          </Tabs>
        </DrawerContent>
      </Drawer>

      {/* Navigation tabs - Always visible and sticky to bottom */}
      <div className={cn('pointer-events-auto fixed right-0 bottom-0 left-0 z-50')}>
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <ChatInterfaceNav className="h-(--nav-height)" />
        </Tabs>
      </div>
    </div>
  );
});
