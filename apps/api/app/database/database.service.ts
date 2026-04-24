import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { Environment } from '#config/environment.config.js';
import * as schema from '#database/schema.js';
import { SqlLogger } from '#database/database.logger.js';
import { mapPostgresErrorToHint } from '#database/postgres-error-hint.utils.js';

export type DatabaseType = ReturnType<typeof drizzle<typeof schema>>;

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  public readonly database: DatabaseType;

  private readonly client: postgres.Sql;
  private readonly connectionString: string;
  private get isNoticeLogEnabled() {
    // Toggle to enable/disable verbose postgres notices logging.
    // Disabled by default as it is noisy during startup.
    return false;
  }

  public constructor(
    private readonly configService: ConfigService<Environment, true>,
    // oxlint-disable-next-line new-cap -- @InjectPinoLogger is a Nest decorator factory, not a constructor
    @InjectPinoLogger(DatabaseService.name) private readonly logger: PinoLogger,
  ) {
    this.connectionString = this.configService.get<string>('DATABASE_URL', { infer: true });

    this.client = postgres(this.connectionString, {
      prepare: false,
      onnotice: (notice) => {
        if (this.isNoticeLogEnabled) {
          this.logger.info(`${notice['message']}`);
        }
      },
    });
    this.database = drizzle(this.client, { schema, logger: new SqlLogger() });
  }

  public async onModuleDestroy(): Promise<void> {
    await this.client.end();
    this.logger.info('Database connection closed');
  }

  public async onModuleInit(): Promise<void> {
    await this.probeDatabaseConnectivity();
    await this.runMigrations();
    this.logger.info('Database service initialized');
  }

  /**
   * Pre-migration connectivity probe.
   *
   * Drizzle's migrator fails on its first DDL statement (`CREATE SCHEMA …`) for
   * every connection-level failure mode (paused project, DNS, TCP timeout, role
   * rotation, pooler exhaustion). The opaque `Failed query: …` error it emits
   * makes it impossible to distinguish "DB unreachable" from "DB rejected my
   * SQL" in Fly logs. A standalone `SELECT 1` probe with structured error
   * mapping closes that observability gap in Fly logs and operator dashboards.
   */
  private async probeDatabaseConnectivity(): Promise<void> {
    this.logger.info('Starting database connectivity probe...');
    try {
      await this.database.execute(sql`select 1`);
      this.logger.info('Database connectivity probe succeeded');
    } catch (error) {
      const { host, port } = this.extractConnectionTarget();
      const hint = mapPostgresErrorToHint(error);
      this.logger.error({ err: error, host, port, hint }, 'Database connectivity probe failed');
      throw new Error('Database connectivity probe failed', { cause: error });
    }
  }

  private async runMigrations(): Promise<void> {
    try {
      this.logger.info('Starting database migrations...');

      // Use the same database instance for migrations to ensure consistency
      await migrate(this.database, {
        migrationsFolder: path.join(import.meta.dirname, 'migrations'),
      });

      this.logger.info('Database migrations completed successfully');
    } catch (error) {
      const hint = mapPostgresErrorToHint(error);
      this.logger.error({ err: error, hint }, 'Database migration failed');
      throw new Error('Migration failed', { cause: error });
    }
  }

  /**
   * Parses `DATABASE_URL` for structured logging. Returns `undefined` host/port
   * when the URL cannot be parsed (e.g. masked secret) so the probe still
   * surfaces an error log without a secondary URL-parse failure.
   */
  private extractConnectionTarget(): { host: string | undefined; port: string | undefined } {
    try {
      const parsed = new URL(this.connectionString);
      return { host: parsed.hostname, port: parsed.port };
    } catch {
      return { host: undefined, port: undefined };
    }
  }
}
