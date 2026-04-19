/* oxlint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- vitest mocks lose type safety */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreateAdapter, mockSocketIoAdapter, mockSocketIoClose, mockSocketIoOn, mockListen } = vi.hoisted(() => ({
  mockCreateAdapter: vi.fn(() => 'mock-adapter-constructor'),
  mockSocketIoAdapter: vi.fn(),
  mockSocketIoClose: vi.fn(),
  mockSocketIoOn: vi.fn(),
  mockListen: vi.fn((_port: number, callback?: () => void) => callback?.()),
}));

let capturedSocketIoOptions: Record<string, unknown> | undefined;

vi.mock('@socket.io/redis-streams-adapter', () => ({
  createAdapter: mockCreateAdapter,
}));

vi.mock('socket.io', () => {
  class MockServer {
    public adapter = mockSocketIoAdapter;
    public close = mockSocketIoClose;
    public on = mockSocketIoOn;
    public constructor(_httpServer: unknown, options: Record<string, unknown>) {
      capturedSocketIoOptions = options;
    }
  }

  return {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- socket.io class name
    Server: MockServer,
  };
});

vi.mock('node:http', () => ({
  createServer: vi.fn(() => ({ on: vi.fn(), listen: mockListen, close: vi.fn() })),
}));

vi.mock('ws', () => {
  class MockWebSocketServer {
    public close = vi.fn();
  }

  return {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- ws class name
    WebSocketServer: MockWebSocketServer,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- ws class name
    WebSocket: { OPEN: 1 },
  };
});

vi.mock('#api/chat/chat-rpc.gateway.js', () => ({
  chatRpcPath: '/v1/chat/rpc',
}));

function createMockDuplicateClient() {
  return {
    on: vi.fn(),
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    quit: vi.fn<() => Promise<string>>().mockResolvedValue('OK'),
  };
}

function createMockRedisService(duplicateClient = createMockDuplicateClient()) {
  return { createDuplicateClient: vi.fn(() => duplicateClient) };
}

function createMockConfigService() {
  return {
    get: vi.fn((key: string) => {
      if (key === 'PORT') {
        return '3001';
      }
      if (key === 'TAU_FRONTEND_URL') {
        return 'http://localhost:3000';
      }
      return undefined;
    }),
  };
}

describe('DevWebSocketService', () => {
  beforeEach(() => {
    capturedSocketIoOptions = undefined;
    vi.clearAllMocks();
  });

  async function createService(overrides?: { duplicateClient?: ReturnType<typeof createMockDuplicateClient> }) {
    const duplicateClient = overrides?.duplicateClient ?? createMockDuplicateClient();
    const redisService = createMockRedisService(duplicateClient);
    const configService = createMockConfigService();

    // eslint-disable-next-line @typescript-eslint/naming-convention -- class import from dynamic module
    const { DevWebSocketService } = await import('#api/websocket/dev-websocket.service.js');
    const service = new DevWebSocketService(configService as any, redisService as any);

    return { service, redisService, configService, duplicateClient };
  }

  describe('onModuleInit (Redis Streams adapter)', () => {
    it('should create a duplicate Redis client and build the Streams adapter', async () => {
      const { service, redisService, duplicateClient } = await createService();

      await service.onModuleInit();

      expect(redisService.createDuplicateClient).toHaveBeenCalledOnce();
      expect(duplicateClient.connect).toHaveBeenCalledOnce();
      expect(mockCreateAdapter).toHaveBeenCalledWith(duplicateClient, {
        streamName: 'tau:socketio',
        maxLen: 10_000,
      });
    });

    it('should register error/connect/close listeners on the adapter client', async () => {
      const { service, duplicateClient } = await createService();

      await service.onModuleInit();

      expect(duplicateClient.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(duplicateClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(duplicateClient.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should fall back to in-memory adapter if Redis connection fails', async () => {
      const duplicateClient = createMockDuplicateClient();
      duplicateClient.connect.mockRejectedValue(new Error('Redis unavailable'));

      const { service } = await createService({ duplicateClient });

      await service.onModuleInit();

      expect(mockCreateAdapter).not.toHaveBeenCalled();
    });
  });

  describe('initServer (adapter application)', () => {
    it('should apply the Redis Streams adapter to the Socket.IO server', async () => {
      const { service } = await createService();

      await service.onModuleInit();
      service.getSocketIoServer();

      expect(mockSocketIoAdapter).toHaveBeenCalledWith('mock-adapter-constructor');
    });

    it('should not apply adapter if Redis initialization failed', async () => {
      const duplicateClient = createMockDuplicateClient();
      duplicateClient.connect.mockRejectedValue(new Error('Redis unavailable'));

      const { service } = await createService({ duplicateClient });

      await service.onModuleInit();
      service.getSocketIoServer();

      expect(mockSocketIoAdapter).not.toHaveBeenCalled();
    });
  });

  describe('CORS origin', () => {
    it('should use TAU_FRONTEND_URL as CORS origin instead of true', async () => {
      const { service } = await createService();

      await service.onModuleInit();
      service.getSocketIoServer();

      expect(capturedSocketIoOptions).toBeDefined();
      const cors = capturedSocketIoOptions!['cors'] as { origin: string; credentials: boolean };
      expect(cors.origin).toBe('http://localhost:3000');
      expect(cors.credentials).toBe(true);
    });
  });

  describe('onModuleDestroy (adapter cleanup)', () => {
    it('should quit the adapter Redis client on destroy', async () => {
      const { service, duplicateClient } = await createService();

      await service.onModuleInit();
      service.getSocketIoServer();
      await service.onModuleDestroy();

      expect(duplicateClient.quit).toHaveBeenCalledOnce();
    });

    it('should not fail if adapter was never initialized', async () => {
      const duplicateClient = createMockDuplicateClient();
      duplicateClient.connect.mockRejectedValue(new Error('Redis unavailable'));

      const { service } = await createService({ duplicateClient });

      await service.onModuleInit();
      await service.onModuleDestroy();

      expect(duplicateClient.quit).not.toHaveBeenCalled();
    });
  });
});
