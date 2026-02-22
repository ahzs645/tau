/**
 * BackendSelector Component
 *
 * Shared filesystem backend selector used in the Settings pane and the /files route.
 * Renders a ComboBoxResponsive with backend options, feature detection, and icons.
 */

import { useMemo } from 'react';
import { Check, ChevronDown, Database, FolderOpen, HardDrive, MemoryStick } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FilesystemBackend } from '@taucad/types';
import { filesystemBackendMeta } from '@taucad/types/constants';
import { Button } from '#components/ui/button.js';
import { ComboBoxResponsive } from '#components/ui/combobox-responsive.js';
import { Loader } from '#components/ui/loader.js';
import { isFileSystemAccessSupported } from '#constants/browser.constants.js';

/**
 * Backend option for the selector dropdown.
 */
export type BackendOption = {
  value: FilesystemBackend;
  label: string;
  description: string;
  icon: LucideIcon;
};

/**
 * All available backend options with their icons.
 */
export const backendOptions: BackendOption[] = [
  {
    value: 'indexeddb',
    ...filesystemBackendMeta.indexeddb,
    icon: Database,
  },
  {
    value: 'opfs',
    ...filesystemBackendMeta.opfs,
    icon: HardDrive,
  },
  {
    value: 'webaccess',
    ...filesystemBackendMeta.webaccess,
    icon: FolderOpen,
  },
  {
    value: 'memory',
    ...filesystemBackendMeta.memory,
    icon: MemoryStick,
  },
];

type BackendSelectorProps = {
  readonly value: FilesystemBackend;
  readonly onSelect: (backend: string) => void | Promise<void>;
  readonly isLoading?: boolean;
  /** Whether to hide internal-only backends like memory. Defaults to false. */
  readonly isInternalHidden?: boolean;
};

/**
 * Filesystem backend selector dropdown.
 *
 * Renders a ComboBoxResponsive with all available backends, feature detection
 * for disabling unsupported ones, and a trigger button showing the current selection.
 */
export function BackendSelector({
  value,
  onSelect,
  isLoading = false,
  isInternalHidden = false,
}: BackendSelectorProps): React.JSX.Element {
  const filteredOptions = useMemo(
    () =>
      backendOptions.filter(
        (option) =>
          // OPFS is disabled due to file corruption issues -- hide from all selectors
          option.value !== 'opfs' &&
          // Memory is internal-only
          (!isInternalHidden || option.value !== 'memory'),
      ),
    [isInternalHidden],
  );

  const currentOption = useMemo(
    () => filteredOptions.find((option) => option.value === value) ?? filteredOptions[0]!,
    [filteredOptions, value],
  );

  return (
    <ComboBoxResponsive
      groupedItems={[{ name: 'Storage Backends', items: filteredOptions }]}
      defaultValue={currentOption}
      getValue={(item) => item.value}
      renderLabel={(item, selectedItem) => (
        <span className="flex w-full items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <item.icon className="size-4" />
            <div className="flex flex-col items-start gap-0.5">
              <span className="font-medium">{item.label}</span>
              <span className="text-xs text-muted-foreground">{item.description}</span>
            </div>
          </div>
          {selectedItem?.value === item.value ? <Check className="size-4 shrink-0" /> : undefined}
        </span>
      )}
      popoverProperties={{ className: 'w-[340px]' }}
      isDisabled={(item) => item.value === 'webaccess' && !isFileSystemAccessSupported}
      title="Select Storage Backend"
      description="Choose where to store files"
      isSearchEnabled={false}
      onSelect={onSelect}
    >
      <Button variant="outline" className="w-[160px] justify-between" disabled={isLoading}>
        <span className="flex items-center gap-2">
          {isLoading ? <Loader className="size-4" /> : <currentOption.icon className="size-4" />}
          <span className="truncate">{currentOption.label}</span>
        </span>
        <ChevronDown className="size-4 shrink-0 opacity-50" />
      </Button>
    </ComboBoxResponsive>
  );
}
