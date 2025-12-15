import type { IncomingMessage } from 'node:http';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import type { Environment } from '#config/environment.config.js';
import { KernelsService } from '#api/kernels/kernels.service.js';

/**
 * WebSocket Gateway for Zoo API proxy.
 *
 * In development: Uses a standalone WebSocket server on port+1 because
 * vite-plugin-node doesn't support WebSocket connections.
 *
 * In production: Uses @fastify/websocket on the main Fastify server
 * for simpler deployment (single port).
 */
@Injectable()
export class KernelsGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KernelsGateway.name);
  private wss: WebSocketServer | undefined;
  private readonly wsPort: number;

  public constructor(
    private readonly kernelsService: KernelsService,
    private readonly configService: ConfigService<Environment, true>,
    @Inject(HttpAdapterHost) private readonly httpAdapterHost: HttpAdapterHost,
  ) {
    const mainPort = Number(this.configService.get('PORT', { infer: true }));
    this.wsPort = mainPort + 1;
  }

  /**
   * Start the WebSocket server when the module initializes.
   */
  public onModuleInit(): void {
    // Use import.meta.env.DEV to detect Vite dev mode
    // vite-plugin-node doesn't support WebSockets, so we use a standalone server in dev
    if (import.meta.env.DEV) {
      this.initStandaloneServer();
    } else {
      this.initFastifyWebSocket();
    }
  }

  /**
   * Stop the WebSocket server when the module is destroyed.
   */
  public onModuleDestroy(): void {
    if (this.wss) {
      this.wss.close();
      this.logger.log('WebSocket server stopped');
    }
  }

  /**
   * Initialize standalone WebSocket server for development.
   * Required because vite-plugin-node doesn't support WebSocket connections.
   */
  private initStandaloneServer(): void {
    this.wss = new WebSocketServer({ port: this.wsPort });

    this.wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      const url = new URL(request.url ?? '/', `http://localhost:${this.wsPort}`);
      const { pathname } = url;

      this.logger.debug(`WebSocket connection to ${pathname}`);

      if (pathname === '/v1/kernels/zoo') {
        this.handleZooProxy(socket, url.searchParams);
      } else {
        this.logger.warn(`Unknown WebSocket path: ${pathname}`);
        socket.close(4004, 'Unknown path');
      }
    });

    this.wss.on('error', (error) => {
      this.logger.error('WebSocket server error:', error);
    });

    this.logger.log(`WebSocket server started on port ${this.wsPort} (dev mode)`);
    this.logger.log(`Zoo proxy available at ws://localhost:${this.wsPort}/v1/kernels/zoo`);
  }

  /**
   * Initialize WebSocket routes on Fastify for production.
   * Uses @fastify/websocket which works when NestJS runs directly (not through vite-plugin-node).
   */
  private initFastifyWebSocket(): void {
    const fastify = this.httpAdapterHost.httpAdapter.getInstance<FastifyInstance>();

    // Register the Zoo WebSocket proxy route
    fastify.get('/v1/kernels/zoo', { websocket: true }, (socket: WebSocket, request) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      this.handleZooProxy(socket, url.searchParams);
    });

    this.logger.log('Zoo WebSocket proxy registered at /v1/kernels/zoo (production mode)');
  }

  /**
   * Handle Zoo API proxy connections.
   */
  private handleZooProxy(socket: WebSocket, queryParameters: URLSearchParams): void {
    this.logger.debug('Client connected to Zoo proxy');
    this.kernelsService.createZooProxy(socket, queryParameters);

    socket.on('close', () => {
      this.logger.debug('Client disconnected from Zoo proxy');
    });
  }
}
