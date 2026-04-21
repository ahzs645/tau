import { memo, useCallback } from 'react';
import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { KernelProvider } from '@taucad/runtime';
import { kernelConfigurations } from '@taucad/types/constants';
import { ComboBoxResponsive } from '#components/ui/combobox-responsive.js';
import { SvgIcon } from '#components/icons/svg-icon.js';
import { useActiveChatKernel } from '#hooks/use-active-chat-kernel.js';

type ChatKernelSelectorProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'onSelect'> & {
  readonly onSelect?: (kernelId: KernelProvider) => void;
  readonly onClose?: () => void;
  readonly children: (props: { selectedKernel?: (typeof kernelConfigurations)[number] }) => ReactNode;
  readonly popoverProperties?: React.ComponentProps<typeof ComboBoxResponsive>['popoverProperties'];
  readonly isNested?: boolean;
};

export const ChatKernelSelector = memo(function ({
  onSelect,
  onClose,
  children,
  isNested,
  ...properties
}: ChatKernelSelectorProps): React.JSX.Element {
  // R6 / decision C: read AND write through the chat-scoped resolver so a
  // kernel switch inside chat A patches `Chat.activeKernel` for A *and*
  // updates the cookie default for future new chats. The selector no
  // longer touches `useKernel` directly.
  const { kernel: selectedKernel, setActiveKernel } = useActiveChatKernel();

  const handleSelectKernel = useCallback(
    (item: string) => {
      const kernel = kernelConfigurations.find((k) => k.id === item);

      if (kernel) {
        setActiveKernel(kernel.id);
        onSelect?.(kernel.id);
      }
    },
    [onSelect, setActiveKernel],
  );

  return (
    <ComboBoxResponsive
      {...properties}
      popoverProperties={properties.popoverProperties}
      emptyListMessage='No kernels found.'
      searchPlaceHolder='Search kernels...'
      title='Select a kernel'
      description='Select the kernel to use for the chat. This will be used to generate a response.'
      groupedItems={[
        {
          name: 'CAD Kernels',
          items: [...kernelConfigurations],
        },
      ]}
      renderLabel={(item, selectedItem) => (
        <span className='flex w-full items-center justify-between'>
          <div className='flex items-center gap-2'>
            <SvgIcon id={item.id} />
            <div className='flex flex-col'>
              <span>{item.name}</span>
              <span className='text-xs text-muted-foreground'>{item.description}</span>
            </div>
          </div>
          {selectedItem?.id === item.id ? <Check /> : null}
        </span>
      )}
      getValue={(item) => item.id}
      placeholder='Select a kernel'
      defaultValue={selectedKernel}
      isNested={isNested}
      onSelect={handleSelectKernel}
      onClose={onClose}
    >
      {children({ selectedKernel })}
    </ComboBoxResponsive>
  );
});
