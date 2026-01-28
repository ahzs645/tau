import type { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { ServerOptions, Server } from 'socket.io';
import type { RedisService } from '#redis/redis.service.js';

/**
 * Socket.IO adapter with Redis pub/sub for horizontal scaling.
 * Enables broadcasting events across multiple API instances.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter> | undefined;

  public constructor(
    app: INestApplication,
    private readonly redisService: RedisService,
  ) {
    super(app);
  }

  /**
   * Initialize Redis adapter with pub/sub clients.
   * Must be called before the adapter is used.
   */
  public async connectToRedis(): Promise<void> {
    const pubClient = this.redisService.createDuplicateClient();
    const subClient = this.redisService.createDuplicateClient();

    await Promise.all([pubClient.connect(), subClient.connect()]);

    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  // eslint-disable-next-line @typescript-eslint/naming-convention -- NestJS IoAdapter method
  public override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      // Force WebSocket transport only - no polling fallback
      transports: ['websocket'],
      // CORS is handled by NestJS/Fastify
      cors: false,
    }) as Server;

    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }

    return server;
  }
}
