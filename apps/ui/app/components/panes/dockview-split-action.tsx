import { useCallback } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { Columns2, Rows2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { KeyShortcut } from '#components/ui/key-shortcut.js';
import { DockviewPaneAction } from '#components/panes/dockview-pane-action.js';
import { useModifiers } from '#hooks/use-keyboard.js';
import { formatKeyCombination } from '#utils/keys.utils.js';

const shiftKey = formatKeyCombination({ key: 'Shift' });

/**
 * Right-side header action for Dockview groups.
 *
 * Renders a "split right" button in the tab bar that duplicates the active
 * panel into a new group to the right of the current one. Hold Shift to
 * split down instead. The button is visible on hover via the `.dv-pane-action`
 * CSS (opacity transition on group hover).
 */
export function DockviewSplitAction({ containerApi, group }: IDockviewHeaderActionsProps): React.JSX.Element {
  const { shift: isShiftHeld } = useModifiers();

  const handleSplit = useCallback(() => {
    containerApi.addGroup({
      referenceGroup: group,
      direction: isShiftHeld ? 'below' : 'right',
    });
  }, [containerApi, group, isShiftHeld]);

  const Icon = isShiftHeld ? Rows2 : Columns2;
  const label = isShiftHeld ? 'Split down' : 'Split right';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DockviewPaneAction aria-label={label} onClick={handleSplit}>
          <Icon className="size-3.5" />
        </DockviewPaneAction>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="flex flex-col gap-1">
        <span>{label}</span>
        <span className="flex items-center gap-1 text-xs opacity-70">
          {isShiftHeld ? (
            <>
              Release <KeyShortcut variant="tooltip">{shiftKey}</KeyShortcut> to split right
            </>
          ) : (
            <>
              Hold <KeyShortcut variant="tooltip">{shiftKey}</KeyShortcut> to split down
            </>
          )}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
