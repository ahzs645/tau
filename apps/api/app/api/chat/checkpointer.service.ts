import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '#config/environment.config.js';

/**
 * Manages the PostgresSaver checkpointer for LangGraph agent state persistence.
 *
 * This service handles the database connection lifecycle:
 * - Eagerly connects on module initialization (fail-fast)
 * - Properly closes the connection on module destroy
 * - Provides a singleton instance to prevent connection leaks
 */
@Injectable()
export class CheckpointerService implements OnModuleInit, OnModuleDestroy {
  private checkpointer!: PostgresSaver;
  private destroyed = false;

  public constructor(private readonly configService: ConfigService<Environment, true>) {}

  public async onModuleInit(): Promise<void> {
    const databaseUrl = this.configService.get('DATABASE_URL', { infer: true });
    this.checkpointer = PostgresSaver.fromConnString(databaseUrl, {
      schema: 'langgraph',
    });
    await this.checkpointer.setup();
    this.destroyed = false;
  }

  public async onModuleDestroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    await this.checkpointer.end();
  }

  public getCheckpointer(): PostgresSaver {
    return this.checkpointer;
  }
}
