import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { KernelsService } from '#api/kernels/kernels.service.js';
import { DevWebSocketService } from '#api/websocket/dev-websocket.service.js';

const zooWebSocketPath = '/v1/kernels/zoo';

/**
 * WebSocket Gateway for Zoo API proxy.
 *
 * In development: Uses the shared DevWebSocketService on port+1 because
 * vite-plugin-node doesn't support WebSocket connections.
 *
 * In production: Uses @fastify/websocket on the main Fastify server
 * for simpler deployment (single port).
 */
@Injectable()
export class KernelsGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KernelsGateway.name);

  public constructor(
    private readonly kernelsService: KernelsService,
    private readonly devWebSocketService: DevWebSocketService,
    @Inject(HttpAdapterHost) private readonly httpAdapterHost: HttpAdapterHost,
  ) {}

  /**
   * Start the WebSocket server when the module initializes.
   */
  public onModuleInit(): void {
    // Use import.meta.env.DEV to detect Vite dev mode
    // vite-plugin-node doesn't support WebSockets, so we use a standalone server in dev
    if (import.meta.env.DEV) {
      this.initDevWebSocket();
    } else {
      this.initFastifyWebSocket();
    }
  }

  /**
   * Clean up when the module is destroyed.
   */
  public onModuleDestroy(): void {
    if (import.meta.env.DEV) {
      this.devWebSocketService.unregisterPathHandler(zooWebSocketPath);
    }
  }

  /**
   * Initialize WebSocket handler for development mode.
   * Uses the shared DevWebSocketService.
   */
  private initDevWebSocket(): void {
    this.devWebSocketService.registerPathHandler(zooWebSocketPath, (socket, request) => {
      const url = new URL(request.url ?? '/', `http://localhost:${this.devWebSocketService.getPort()}`);
      this.handleZooProxy(socket, url.searchParams);
    });

    const wsPort = this.devWebSocketService.getPort();
    this.logger.log(`Zoo proxy available at ws://localhost:${wsPort}${zooWebSocketPath} (dev mode)`);
  }

  /**
   * Initialize WebSocket routes on Fastify for production.
   * Uses @fastify/websocket which works when NestJS runs directly (not through vite-plugin-node).
   */
  private initFastifyWebSocket(): void {
    const fastify = this.httpAdapterHost.httpAdapter.getInstance<FastifyInstance>();

    // Register the Zoo WebSocket proxy route
    fastify.get(zooWebSocketPath, { websocket: true }, (socket: WebSocket, request) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      this.handleZooProxy(socket, url.searchParams);
    });

    this.logger.log(`Zoo WebSocket proxy registered at ${zooWebSocketPath} (production mode)`);
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
