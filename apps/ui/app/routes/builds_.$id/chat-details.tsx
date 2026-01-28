import { XIcon, Info } from 'lucide-react';
import { useCallback } from 'react';
import { useSelector } from '@xstate/react';
import { KeyShortcut } from '#components/ui/key-shortcut.js';
import {
  FloatingPanel,
  FloatingPanelClose,
  FloatingPanelContent,
  FloatingPanelContentHeader,
  FloatingPanelContentTitle,
  FloatingPanelContentBody,
  FloatingPanelTrigger,
} from '#components/ui/floating-panel.js';
import { Input } from '#components/ui/input.js';
import { Textarea } from '#components/ui/textarea.js';
import { Tags, TagsTrigger } from '#components/ui/input-tags.js';
import { FileSelector } from '#components/files/file-selector.js';
import { ChatDetailsUsage } from '#routes/builds_.$id/chat-details-usage.js';
import { useKeydown } from '#hooks/use-keydown.js';
import { useBuild } from '#hooks/use-build.js';
import type { KeyCombination } from '#utils/keys.utils.js';
import { formatKeyCombination } from '#utils/keys.utils.js';
import { useFileManager } from '#hooks/use-file-manager.js';

const keyCombinationEditor = {
  key: 'i',
  ctrlKey: true,
} as const satisfies KeyCombination;

// Details Trigger Component
export function ChatDetailsTrigger({
  isOpen,
  onToggle,
}: {
  readonly isOpen: boolean;
  readonly onToggle: () => void;
}): React.JSX.Element {
  return (
    <FloatingPanelTrigger
      icon={Info}
      tooltipContent={
        <div className="flex items-center gap-2">
          {isOpen ? 'Close' : 'Open'} Details
          <KeyShortcut variant="tooltip">{formatKeyCombination(keyCombinationEditor)}</KeyShortcut>
        </div>
      }
      tooltipSide="left"
      className={isOpen ? 'text-primary' : undefined}
      onClick={onToggle}
    />
  );
}

export function ChatDetails({
  isExpanded = true,
  setIsExpanded,
}: {
  readonly isExpanded?: boolean;
  readonly setIsExpanded?: (value: boolean | ((current: boolean) => boolean)) => void;
}): React.JSX.Element {
  const { buildRef, updateName, updateDescription, updateTags } = useBuild();

  const buildName = useSelector(buildRef, (state) => state.context.build?.name ?? '');
  const buildDescription = useSelector(buildRef, (state) => state.context.build?.description ?? '');
  const buildTags = useSelector(buildRef, (state) => state.context.build?.tags ?? []);
  const mainFile = useSelector(buildRef, (state) => state.context.build?.assets.mechanical?.main ?? '');
  const { fileManagerRef } = useFileManager();
  const availableFiles = useSelector(fileManagerRef, (state) => [...state.context.fileTree.entries()].map(([k]) => k));

  const toggleDetails = (): void => {
    setIsExpanded?.((current) => !current);
  };

  const handleTagsChange = useCallback(
    (newTags: string[]) => {
      // Deduplicate tags to prevent duplicates from accumulating
      const uniqueTags = [...new Set(newTags)];
      updateTags(uniqueTags);
    },
    [updateTags],
  );

  const handleMainFileChange = useCallback(
    (path: string) => {
      buildRef.send({ type: 'setMainFile', path });
    },
    [buildRef],
  );

  const { formattedKeyCombination: formattedEditorKeyCombination } = useKeydown(keyCombinationEditor, toggleDetails);

  return (
    <FloatingPanel isOpen={isExpanded} side="right" onOpenChange={setIsExpanded}>
      <FloatingPanelClose
        icon={XIcon}
        tooltipContent={(isOpen) => (
          <div className="flex items-center gap-2">
            {isOpen ? 'Close' : 'Open'} Details
            <KeyShortcut variant="tooltip">{formattedEditorKeyCombination}</KeyShortcut>
          </div>
        )}
      />
      <FloatingPanelContent>
        <FloatingPanelContentHeader>
          <FloatingPanelContentTitle>Details</FloatingPanelContentTitle>
        </FloatingPanelContentHeader>
        <FloatingPanelContentBody className="px-3 py-2">
          <div className="space-y-4">
            {/* Project Information */}
            <div className="space-y-3">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground" htmlFor="project-name">
                  Name:
                </label>
                <Input
                  id="project-name"
                  value={buildName}
                  placeholder="Enter your build name..."
                  onChange={(event) => {
                    updateName(event.target.value);
                  }}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground" htmlFor="project-description">
                  Description:
                </label>
                <Textarea
                  id="project-description"
                  value={buildDescription}
                  placeholder="Describe what you're building..."
                  className="min-h-20"
                  onChange={(event) => {
                    updateDescription(event.target.value);
                  }}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Tags:</label>
                <Tags tags={buildTags} onTagsChange={handleTagsChange}>
                  <TagsTrigger placeholder="Add tags..." />
                </Tags>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Main File:</label>
                <FileSelector
                  files={availableFiles.map((path) => ({ path }))}
                  selectedFile={mainFile}
                  placeholder="Select main file..."
                  title="Select Main File"
                  description="Choose the main file for your build"
                  emptyMessage="No files available"
                  isDisabled={availableFiles.length === 0}
                  onSelect={handleMainFileChange}
                />
              </div>
            </div>

            {/* Usage Statistics */}
            <ChatDetailsUsage />
          </div>
        </FloatingPanelContentBody>
      </FloatingPanelContent>
    </FloatingPanel>
  );
}
