import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Environment } from '#config/environment.config.js';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  /** Primary Redis client for general use */
  public readonly client: Redis;

  private readonly logger = new Logger(RedisService.name);

  public constructor(private readonly configService: ConfigService<Environment, true>) {
    const redisUrl = this.configService.get('REDIS_URL', { infer: true });

    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 10) {
          this.logger.error('Redis connection failed after 10 retries');
          return null; // Stop retrying
        }

        return Math.min(times * 100, 3000); // Exponential backoff, max 3s
      },
      lazyConnect: true, // Don't connect until onModuleInit
    });

    this.client.on('error', (error: Error) => {
      this.logger.error(`Redis client error: ${error.message}`);
    });

    this.client.on('connect', () => {
      this.logger.debug('Redis client connected');
    });
  }

  /**
   * Connect to Redis and verify connection on module init.
   * Throws if connection fails - this prevents app startup with broken Redis.
   */
  public async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      const pong = await this.client.ping();
      if (pong !== ('PONG' as string)) {
        throw new Error(`Unexpected Redis PING response: ${pong}`);
      }

      this.logger.log('Redis connection established');
    } catch (error) {
      this.logger.error('Failed to connect to Redis:', error);
      throw new Error(`Redis connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Gracefully close Redis connection on module destroy.
   */
  public async onModuleDestroy(): Promise<void> {
    await this.client.quit();
    this.logger.log('Redis connection closed');
  }

  /**
   * Create a duplicate client for pub/sub operations.
   * Socket.IO Redis adapter requires separate pub and sub clients.
   */
  public createDuplicateClient(): Redis {
    return this.client.duplicate();
  }
}
