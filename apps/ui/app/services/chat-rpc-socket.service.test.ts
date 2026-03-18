import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Socket, Manager } from 'socket.io-client';

type SocketEventHandler = (...args: unknown[]) => void;
type ManagerEventHandler = (...args: unknown[]) => void;

const socketHandlers = new Map<string, SocketEventHandler[]>();
const managerHandlers = new Map<string, ManagerEventHandler[]>();

const mockSocket = {
  connected: false,
  on: vi.fn((event: string, handler: SocketEventHandler) => {
    const handlers = socketHandlers.get(event) ?? [];
    handlers.push(handler);
    socketHandlers.set(event, handlers);
  }),
  emit: vi.fn(),
  disconnect: vi.fn(),
  connect: vi.fn(),
  io: {
    on: vi.fn((event: string, handler: ManagerEventHandler) => {
      const handlers = managerHandlers.get(event) ?? [];
      handlers.push(handler);
      managerHandlers.set(event, handlers);
    }),
  } as unknown as Manager,
} as unknown as Socket;

let capturedOptions: Record<string, unknown> | undefined;

vi.mock('socket.io-client', () => ({
  io: (_url: string, options: Record<string, unknown>) => {
    capturedOptions = options;
    return mockSocket;
  },
}));

vi.mock('#environment.config.js', () => ({
  ENV: {
    TAU_WEBSOCKET_URL: 'http://localhost:3001',
  },
}));

const { ChatRpcSocketService } = await import('#services/chat-rpc-socket.service.js');

function emitSocketEvent(event: string, ...args: unknown[]): void {
  const handlers = socketHandlers.get(event);
  if (handlers) {
    for (const handler of handlers) {
      handler(...args);
    }
  }
}

function emitManagerEvent(event: string, ...args: unknown[]): void {
  const handlers = managerHandlers.get(event);
  if (handlers) {
    for (const handler of handlers) {
      handler(...args);
    }
  }
}

describe('ChatRpcSocketService', () => {
  let service: ChatRpcSocketService;

  beforeEach(() => {
    socketHandlers.clear();
    managerHandlers.clear();
    vi.clearAllMocks();
    mockSocket.connected = false;
    capturedOptions = undefined;

    // Reset singleton for each test
    // @ts-expect-error -- accessing private static for test isolation
    ChatRpcSocketService.instance = undefined;
    service = ChatRpcSocketService.getInstance();
  });

  afterEach(() => {
    service.disconnect();
  });

  describe('configuration', () => {
    it('should set reconnectionDelayMax to 5000ms', () => {
      service.connect();
      expect(capturedOptions?.reconnectionDelayMax).toBe(5_000);
    });

    it('should use websocket transport only', () => {
      service.connect();
      expect(capturedOptions?.transports).toEqual(['websocket']);
    });

    it('should enable infinite reconnection attempts', () => {
      service.connect();
      expect(capturedOptions?.reconnectionAttempts).toBe(Infinity);
    });
  });

  describe('disconnect reason logging', () => {
    it('should log disconnect reason via console.warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      service.connect();

      emitSocketEvent('disconnect', 'transport close');

      expect(warnSpy).toHaveBeenCalledWith('[ChatRpcSocket] Disconnected (reason: transport close)');
      warnSpy.mockRestore();
    });

    it('should log ping timeout disconnect reason', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      service.connect();

      emitSocketEvent('disconnect', 'ping timeout');

      expect(warnSpy).toHaveBeenCalledWith('[ChatRpcSocket] Disconnected (reason: ping timeout)');
      warnSpy.mockRestore();
    });

    it('should set status to disconnected with mapped error message', () => {
      service.connect();
      const listener = vi.fn();
      service.subscribe(listener);

      emitSocketEvent('disconnect', 'transport close');

      expect(listener).toHaveBeenCalledWith('disconnected', 'Connection lost');
    });

    it('should not log when disconnect is due to auth failure', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      service.connect();

      // Simulate auth failure first
      emitSocketEvent('connect_error', new Error('UNAUTHENTICATED'));

      warnSpy.mockClear();

      // Disconnect after auth failure should be silent
      emitSocketEvent('disconnect', 'io client disconnect');

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[ChatRpcSocket] Disconnected'));
      warnSpy.mockRestore();
    });
  });

  describe('join with retry', () => {
    it('should emit join with callback ack on connect', () => {
      service.connect();
      const handler = vi.fn();
      service.joinChat('chat_1', handler);

      mockSocket.connected = true;
      emitSocketEvent('connect');

      expect(mockSocket.emit).toHaveBeenCalledWith('join', { chatId: 'chat_1' }, expect.any(Function));
    });

    it('should emit join with callback ack on reconnect', () => {
      service.connect();
      const handler = vi.fn();
      service.joinChat('chat_1', handler);

      // Simulate reconnect
      mockSocket.connected = true;
      emitManagerEvent('reconnect');

      expect(mockSocket.emit).toHaveBeenCalledWith('join', { chatId: 'chat_1' }, expect.any(Function));
    });

    it('should emit join with callback when joinChat is called while connected', () => {
      service.connect();
      mockSocket.connected = true;

      service.joinChat('chat_new', vi.fn());

      expect(mockSocket.emit).toHaveBeenCalledWith('join', { chatId: 'chat_new' }, expect.any(Function));
    });
  });
});
