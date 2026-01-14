import type { IncomingMessage } from 'node:http';
import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocketServer, WebSocket } from 'ws';
import type { Environment } from '#config/environment.config.js';

export type WebSocketConnectionHandler = (socket: WebSocket, request: IncomingMessage) => void | Promise<void>;

/**
 * Shared WebSocket server for development mode.
 *
 * In dev mode, vite-plugin-node doesn't support WebSocket connections,
 * so we need a standalone WebSocket server on a separate port.
 * This service provides a single shared server that multiple gateways
 * can register their path handlers with.
 *
 * Each gateway registers a handler for its specific path, and this service
 * routes incoming connections to the appropriate handler based on the URL path.
 */
@Injectable()
export class DevWebSocketService implements OnModuleDestroy {
  private readonly logger = new Logger(DevWebSocketService.name);
  private wss: WebSocketServer | undefined;
  private readonly wsPort: number;
  private readonly pathHandlers = new Map<string, WebSocketConnectionHandler>();
  private initialized = false;

  public constructor(private readonly configService: ConfigService<Environment, true>) {
    const mainPort = Number(this.configService.get('PORT', { infer: true }));
    this.wsPort = mainPort + 1;
  }

  /**
   * Get the WebSocket port.
   */
  public getPort(): number {
    return this.wsPort;
  }

  /**
   * Register a handler for a specific path.
   * The handler will be called when a WebSocket connection is made to that path.
   */
  public registerPathHandler(path: string, handler: WebSocketConnectionHandler): void {
    if (this.pathHandlers.has(path)) {
      this.logger.warn(`Path handler for ${path} already registered, overwriting`);
    }

    this.pathHandlers.set(path, handler);
    this.logger.debug(`Registered WebSocket handler for path: ${path}`);

    // Initialize the server if not already done
    if (!this.initialized) {
      this.initServer();
    }
  }

  /**
   * Unregister a handler for a specific path.
   */
  public unregisterPathHandler(path: string): void {
    this.pathHandlers.delete(path);
    this.logger.debug(`Unregistered WebSocket handler for path: ${path}`);
  }

  /**
   * Stop the WebSocket server when the module is destroyed.
   */
  public onModuleDestroy(): void {
    if (this.wss) {
      this.wss.close();
      this.logger.log('Shared WebSocket server stopped');
    }
  }

  /**
   * Initialize the WebSocket server.
   */
  private initServer(): void {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.wss = new WebSocketServer({ port: this.wsPort });

    this.wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      void this.handleConnection(socket, request);
    });

    this.wss.on('error', (error) => {
      this.logger.error(`WebSocket server error: ${error.message}`);
    });

    this.logger.log(`Shared WebSocket server started on port ${this.wsPort} (dev mode)`);
  }

  /**
   * Handle an incoming WebSocket connection by routing to the appropriate handler.
   */
  private async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const url = new URL(request.url ?? '/', `http://localhost:${this.wsPort}`);
    const { pathname } = url;

    this.logger.debug(`WebSocket connection to ${pathname}`);

    const handler = this.pathHandlers.get(pathname);

    if (handler) {
      await handler(socket, request);
    } else {
      this.logger.warn(`No handler registered for WebSocket path: ${pathname}`);
      socket.close(4004, 'Unknown path');
    }
  }
}
