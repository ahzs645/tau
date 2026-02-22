import { XIcon, FileBox, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { KeyShortcut } from '#components/ui/key-shortcut.js';
import {
  FloatingPanel,
  FloatingPanelClose,
  FloatingPanelContent,
  FloatingPanelContentHeader,
  FloatingPanelContentHeaderActions,
  FloatingPanelContentTitle,
  FloatingPanelContentBody,
  FloatingPanelTrigger,
} from '#components/ui/floating-panel.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible.js';
import { useKeybinding } from '#hooks/use-keyboard.js';
import type { KeyCombination } from '#utils/keys.utils.js';
import { formatKeyCombination } from '#utils/keys.utils.js';
import { ChatEditorExplorerFiles } from '#routes/builds_.$id/chat-explorer-files.js';
import { ChatEditorExplorerMaterials } from '#routes/builds_.$id/chat-explorer-materials.js';
import { ChatEditorExplorerMeshes } from '#routes/builds_.$id/chat-explorer-meshes.js';
import { ChatEditorExplorerObjects } from '#routes/builds_.$id/chat-explorer-objects.js';
import { ChatEditorExplorerAnimations } from '#routes/builds_.$id/chat-explorer-animations.js';
import { ChatEditorExplorerEnvironment } from '#routes/builds_.$id/chat-explorer-environment.js';

const keyCombinationEditor = {
  key: 'a',
  ctrlKey: true,
} as const satisfies KeyCombination;

// Items Trigger Component
export function ChatExplorerTrigger({
  isOpen,
  onToggle,
}: {
  readonly isOpen: boolean;
  readonly onToggle: () => void;
}): React.JSX.Element {
  return (
    <FloatingPanelTrigger
      icon={FileBox}
      tooltipContent={
        <div className="flex items-center gap-2">
          {isOpen ? 'Close' : 'Open'} Explorer
          <KeyShortcut variant="tooltip">{formatKeyCombination(keyCombinationEditor)}</KeyShortcut>
        </div>
      }
      className={isOpen ? 'text-primary' : undefined}
      tooltipSide="right"
      onClick={onToggle}
    />
  );
}

export function ChatExplorerTree({
  className,
  isExpanded = true,
  setIsExpanded,
}: {
  readonly className?: string;
  readonly isExpanded: boolean;
  readonly setIsExpanded?: (value: boolean | ((current: boolean) => boolean)) => void;
}): React.JSX.Element {
  // Section collapse states
  const [isFilesOpen, setIsFilesOpen] = useState(true);
  const [isMaterialsOpen, setIsMaterialsOpen] = useState(true);
  const [isMeshesOpen, setIsMeshesOpen] = useState(false);
  const [isAnimationsOpen, setIsAnimationsOpen] = useState(false);
  const [isObjectsOpen, setIsObjectsOpen] = useState(false);
  const [isEnvironmentOpen, setIsEnvironmentOpen] = useState(true);

  const toggleEditor = () => {
    setIsExpanded?.((current) => !current);
  };

  const { formattedKeyCombination: formattedEditorKeyCombination } = useKeybinding(keyCombinationEditor, toggleEditor);

  return (
    <FloatingPanel isOpen={isExpanded} side="right" className={className} onOpenChange={setIsExpanded}>
      <FloatingPanelContent className="text-sm">
        <FloatingPanelContentHeader>
          <FloatingPanelContentTitle>Explorer</FloatingPanelContentTitle>
          <FloatingPanelContentHeaderActions>
            <FloatingPanelClose
              icon={XIcon}
              tooltipContent={(isOpen) => (
                <div className="flex items-center gap-2">
                  {isOpen ? 'Close' : 'Open'} Explorer
                  <KeyShortcut variant="tooltip">{formattedEditorKeyCombination}</KeyShortcut>
                </div>
              )}
            />
          </FloatingPanelContentHeaderActions>
        </FloatingPanelContentHeader>
        <FloatingPanelContentBody className="flex flex-col px-0 py-0">
          {/* Files Section */}
          <ExplorerCollapsibleSection title="Files" count={1} isOpen={isFilesOpen} onOpenChange={setIsFilesOpen}>
            <ChatEditorExplorerFiles />
          </ExplorerCollapsibleSection>

          {/* Materials Section */}
          <ExplorerCollapsibleSection
            title="Materials"
            count={3}
            isOpen={isMaterialsOpen}
            onOpenChange={setIsMaterialsOpen}
          >
            <ChatEditorExplorerMaterials />
          </ExplorerCollapsibleSection>

          {/* Meshes Section */}
          <ExplorerCollapsibleSection title="Meshes" count={9} isOpen={isMeshesOpen} onOpenChange={setIsMeshesOpen}>
            <ChatEditorExplorerMeshes />
          </ExplorerCollapsibleSection>

          {/* Animations Section */}
          <ExplorerCollapsibleSection
            title="Animations"
            count={3}
            isOpen={isAnimationsOpen}
            onOpenChange={setIsAnimationsOpen}
          >
            <ChatEditorExplorerAnimations />
          </ExplorerCollapsibleSection>

          {/* Objects Section */}
          <ExplorerCollapsibleSection title="Objects" count={10} isOpen={isObjectsOpen} onOpenChange={setIsObjectsOpen}>
            <ChatEditorExplorerObjects />
          </ExplorerCollapsibleSection>

          {/* Environment Section */}
          <ExplorerCollapsibleSection
            title="Environment"
            count={1}
            isOpen={isEnvironmentOpen}
            onOpenChange={setIsEnvironmentOpen}
          >
            <ChatEditorExplorerEnvironment />
          </ExplorerCollapsibleSection>
        </FloatingPanelContentBody>
      </FloatingPanelContent>
    </FloatingPanel>
  );
}

type ExplorerCollapsibleSectionProps = {
  readonly title: string;
  readonly count: number;
  readonly isOpen: boolean;
  readonly onOpenChange: (isOpen: boolean) => void;
  readonly children: React.ReactNode;
};

function ExplorerCollapsibleSection({
  title,
  count,
  isOpen,
  onOpenChange,
  children,
}: ExplorerCollapsibleSectionProps): React.JSX.Element {
  return (
    <Collapsible open={isOpen} className="w-full border-b border-border/50 last:border-b-0" onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="group/collapsible flex h-8 w-full items-center justify-between px-3 py-1.5 transition-colors hover:bg-muted/50">
        <h3 className="flex min-w-0 flex-1 items-center text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          <span className="truncate">{title}</span>
          <span className="ml-1.5 shrink-0 text-muted-foreground/50">({count})</span>
        </h3>
        <ChevronRight className="size-3.5 text-muted-foreground transition-transform duration-200 ease-in-out group-data-[state=open]/collapsible:rotate-90" />
      </CollapsibleTrigger>

      <CollapsibleContent className="px-0 py-1">{children}</CollapsibleContent>
    </Collapsible>
  );
}
