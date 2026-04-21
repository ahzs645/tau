// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { KernelConfiguration, KernelId } from '@taucad/types/constants';
import { kernelConfigurations } from '@taucad/types/constants';

// E5 (R6 / decision C): the chat kernel selector must read AND write
// through `useActiveChatKernel` so the chat row gets patched alongside
// the cookie default. These tests capture the props the component hands
// to ComboBoxResponsive and assert the chat-scoped resolver is the only
// kernel state surface used.

const stubKernel: KernelConfiguration = kernelConfigurations.find((k) => k.id === 'manifold')!;

const chatKernelState: { current: KernelConfiguration | undefined } = { current: stubKernel };
const setActiveKernel = vi.fn();

const useActiveChatKernelMock = vi.fn(() => ({
  kernelId: chatKernelState.current?.id as KernelId,
  kernel: chatKernelState.current,
  setActiveKernel,
}));

vi.mock('#hooks/use-active-chat-kernel.js', () => ({
  useActiveChatKernel: () => useActiveChatKernelMock(),
}));

// The selector must NOT import `useKernel` anymore — guard with a
// throwing mock so any regression is caught at module load.
vi.mock('#hooks/use-kernel.js', () => ({
  useKernel: () => {
    throw new Error('chat-kernel-selector should no longer call useKernel — switch to useActiveChatKernel');
  },
}));

const capturedComboBox: { onSelect?: (id: string) => void; defaultValue?: unknown } = {};
vi.mock('#components/ui/combobox-responsive.js', () => ({
  ComboBoxResponsive: (properties: {
    readonly onSelect?: (id: string) => void;
    readonly defaultValue?: unknown;
    readonly children?: React.ReactNode;
  }): React.JSX.Element => {
    capturedComboBox.onSelect = properties.onSelect;
    capturedComboBox.defaultValue = properties.defaultValue;
    return <div data-testid='combobox'>{properties.children}</div>;
  },
}));

vi.mock('#components/icons/svg-icon.js', () => ({
  SvgIcon: ({ id }: { readonly id?: string }) => <span data-testid='svg-icon'>{id}</span>,
}));

const { ChatKernelSelector } = await import('#components/chat/chat-kernel-selector.js');

function renderSelector(onSelect?: (id: KernelId) => void) {
  return render(
    <ChatKernelSelector onSelect={onSelect}>
      {({ selectedKernel }) => <span data-testid='child'>{selectedKernel?.name ?? 'none'}</span>}
    </ChatKernelSelector>,
  );
}

describe('ChatKernelSelector — chat-scoped read + dual-write (E5, R6, decision C)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatKernelState.current = stubKernel;
    capturedComboBox.onSelect = undefined;
    capturedComboBox.defaultValue = undefined;
  });

  it('renders the selected kernel from useActiveChatKernel (not useKernel)', () => {
    renderSelector();
    expect(useActiveChatKernelMock).toHaveBeenCalled();
    expect(capturedComboBox.defaultValue).toBe(stubKernel);
  });

  it('reflects the chat-local active kernel when it diverges from the cookie default', () => {
    const chatLocal = kernelConfigurations.find((k) => k.id === 'jscad')!;
    chatKernelState.current = chatLocal;
    renderSelector();
    expect(capturedComboBox.defaultValue).toBe(chatLocal);
  });

  it('routes the picked kernel id through setActiveKernel (dual-write to chat + cookie)', () => {
    const onSelect = vi.fn();
    renderSelector(onSelect);
    capturedComboBox.onSelect?.('replicad');

    expect(setActiveKernel).toHaveBeenCalledTimes(1);
    expect(setActiveKernel).toHaveBeenCalledWith('replicad');
    expect(onSelect).toHaveBeenCalledWith('replicad');
  });

  it('ignores selections that do not resolve to a known kernel id', () => {
    renderSelector();
    capturedComboBox.onSelect?.('does-not-exist');
    expect(setActiveKernel).not.toHaveBeenCalled();
  });
});
