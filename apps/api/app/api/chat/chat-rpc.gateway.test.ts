/* oxlint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- vitest mocks lose type safety */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('better-auth/node', () => ({
  fromNodeHeaders: vi.fn(),
}));

function createMockSocketIoServer() {
  return { use: vi.fn(), on: vi.fn() };
}

function createMockDevWebSocketService(io = createMockSocketIoServer()) {
  return {
    getSocketIoServer: vi.fn(() => io),
    getPort: vi.fn(() => 3002),
  };
}

function createMockChatRpcService() {
  return {
    registerConnection: vi.fn(),
    unregisterConnection: vi.fn(),
    handleSocketDisconnect: vi.fn(),
  };
}

function createMockAuth() {
  return { api: { getSession: vi.fn() } };
}

describe('ChatRpcGateway', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function createGateway(overrides?: { io?: ReturnType<typeof createMockSocketIoServer> }) {
    const io = overrides?.io ?? createMockSocketIoServer();
    const devWebSocketService = createMockDevWebSocketService(io);
    const chatRpcService = createMockChatRpcService();
    const auth = createMockAuth();

    // eslint-disable-next-line @typescript-eslint/naming-convention -- class import from dynamic module
    const { ChatRpcGateway } = await import('#api/chat/chat-rpc.gateway.js');
    const metricsService = { wsActiveConnections: { add: vi.fn() }, wsDisconnections: { add: vi.fn() } };
    const gateway = new ChatRpcGateway(
      chatRpcService as any,
      devWebSocketService as any,
      auth as any,
      metricsService as any,
    );

    return { gateway, io, devWebSocketService };
  }

  describe('initDevSocketIo (connection metrics)', () => {
    it('should bind connection metrics before setting up auth middleware', async () => {
      const { gateway, io } = await createGateway();
      const callOrder: string[] = [];

      io.on.mockImplementation(() => {
        callOrder.push('connection-listener');
      });
      io.use.mockImplementation(() => {
        callOrder.push('middleware');
      });

      gateway.onModuleInit();

      expect(io.on).toHaveBeenCalledWith('connection', expect.any(Function));
      expect(callOrder[0]).toBe('connection-listener');
    }, 30_000);
  });
});
