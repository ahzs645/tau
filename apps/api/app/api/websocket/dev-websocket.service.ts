import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as SocketIoServer } from 'socket.io';
import type { Environment } from '#config/environment.config.js';
// oxlint-disable-next-line eslint-plugin-import/no-cycle -- gateway and dev-websocket are tightly coupled
import { chatRpcPath } from '#api/chat/chat-rpc.gateway.js';

export type WebSocketConnectionHandler = (socket: WebSocket, request: IncomingMessage) => void | Promise<void>;

/**
 * Shared WebSocket server for development mode.
 *
 * In dev mode, vite-plugin-node doesn't support WebSocket connections,
 * so we need a standalone server on a separate port.
 *
 * This service provides a single HTTP server on port+1 that handles:
 * - Raw WebSocket connections (for Zoo proxy) via path handlers
 * - Socket.IO connections (for chat RPC) via the configured Socket.IO path
 *
 * The upgrade event is intercepted to route connections based on path:
 * - Paths starting with chatRpcPath (/v1/chat/rpc) go to Socket.IO
 * - Other registered paths go to raw WebSocket handlers
 */
@Injectable()
export class DevWebSocketService implements OnModuleDestroy {
  private readonly logger = new Logger(DevWebSocketService.name);
  private httpServer: HttpServer | undefined;
  private wss: WebSocketServer | undefined;
  private io: SocketIoServer | undefined;
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
   * Get the Socket.IO server instance.
   * Initializes the server if not already done.
   */
  public getSocketIoServer(): SocketIoServer {
    if (!this.initialized) {
      this.initServer();
    }

    return this.io!;
  }

  /**
   * Register a handler for a specific raw WebSocket path.
   * The handler will be called when a WebSocket connection is made to that path.
   */
  public registerPathHandler(path: string, handler: WebSocketConnectionHandler): void {
    if (this.pathHandlers.has(path)) {
      this.logger.warn(`Path handler for ${path} already registered, overwriting`);
    }

    this.pathHandlers.set(path, handler);
    this.logger.debug(`Registered raw WebSocket handler for path: ${path}`);

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
   * Stop the servers when the module is destroyed.
   */
  public onModuleDestroy(): void {
    if (this.io) {
      void this.io.close();
    }

    if (this.wss) {
      this.wss.close();
    }

    if (this.httpServer) {
      this.httpServer.close();
    }

    this.logger.log('Dev WebSocket server stopped');
  }

  /**
   * Initialize the combined HTTP/WebSocket/Socket.IO server.
   */
  private initServer(): void {
    if (this.initialized) {
      return;
    }

    this.initialized = true;

    // Create HTTP server
    this.httpServer = createServer((_request, response) => {
      response.writeHead(200);
      response.end('Tau Dev WebSocket Server');
    });

    // Create raw WebSocket server with noServer mode
    this.wss = new WebSocketServer({ noServer: true });

    // Create Socket.IO server attached to HTTP server
    // Uses chatRpcPath to match production configuration
    this.io = new SocketIoServer(this.httpServer, {
      path: chatRpcPath,
      cors: {
        origin: true, // Allow all origins in dev
        credentials: true,
      },
      transports: ['websocket'],
    });

    // Handle upgrade requests manually to route between Socket.IO and raw WebSocket
    // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- Buffer required by ws library
    this.httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const { pathname } = new URL(request.url ?? '/', `http://localhost:${this.wsPort}`);

      // Check if this is the Socket.IO path (configured to chatRpcPath to match production)
      // Socket.IO's engine handles paths starting with the configured path
      if (pathname.startsWith(chatRpcPath)) {
        // Socket.IO handles this via its attachment to httpServer
        // The upgrade event is already being listened to by Socket.IO
        return;
      }

      // Check for registered raw WebSocket paths
      const handler = this.pathHandlers.get(pathname);
      if (handler) {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
          void this.handleConnection(ws, request, handler);
        });
        return;
      }

      // No handler found
      this.logger.warn(`No handler registered for WebSocket path: ${pathname}`);
      socket.destroy();
    });

    this.httpServer.listen(this.wsPort, () => {
      this.logger.log(`Dev WebSocket server started on port ${this.wsPort}`);
      this.logger.log(`  - Raw WebSocket: ws://localhost:${this.wsPort}/v1/kernels/zoo`);
      this.logger.log(`  - Socket.IO: ws://localhost:${this.wsPort}${chatRpcPath}`);
    });
  }

  /**
   * Handle a WebSocket connection with error handling.
   */
  private async handleConnection(
    ws: WebSocket,
    request: IncomingMessage,
    handler: WebSocketConnectionHandler,
  ): Promise<void> {
    try {
      await handler(ws, request);
    } catch (error) {
      this.logger.error('WebSocket handler error', error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, 'Internal server error');
      }
    }
  }
}
