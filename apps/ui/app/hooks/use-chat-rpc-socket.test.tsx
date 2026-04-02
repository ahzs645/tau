// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ChatRpcSocketProvider, useChatRpcSocket } from '#hooks/use-chat-rpc-socket.js';
import { ChatRpcSocketService } from '#services/chat-rpc-socket.service.js';

vi.mock('#services/chat-rpc-socket.service.js', () => {
  const mockService = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getStatus: vi.fn().mockReturnValue('disconnected'),
    getError: vi.fn(),
    subscribe: vi.fn().mockReturnValue(vi.fn()),
  };

  return {
    ChatRpcSocketService: {
      getInstance: vi.fn().mockReturnValue(mockService),
    },
  };
});

describe('ChatRpcSocketProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call connect when ChatRpcSocketProvider mounts', () => {
    const mockService = ChatRpcSocketService.getInstance();

    render(
      <ChatRpcSocketProvider>
        <div>test</div>
      </ChatRpcSocketProvider>,
    );

    expect(mockService.connect).toHaveBeenCalledOnce();
  });

  it('should throw when useChatRpcSocket is used outside provider', () => {
    expect(() => {
      renderHook(() => useChatRpcSocket());
    }).toThrow('useChatRpcSocket must be used within a ChatRpcSocketProvider');
  });

  it('should return the service instance when used within provider', () => {
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <ChatRpcSocketProvider>{children}</ChatRpcSocketProvider>
    );

    const { result } = renderHook(() => useChatRpcSocket(), { wrapper });

    expect(result.current).toBe(ChatRpcSocketService.getInstance());
  });
});
