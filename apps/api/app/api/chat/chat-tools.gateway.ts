import type { IncomingMessage } from 'node:http';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import type { Auth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { wsCloseCode } from '@taucad/chat/constants';
import { authInstanceKey } from '#constants/auth.constant.js';
import { ChatToolsService } from '#api/chat/chat-tools.service.js';
import { DevWebSocketService } from '#api/websocket/dev-websocket.service.js';

const chatToolsWebSocketPath = '/v1/chat/tools';

/**
 * WebSocket Gateway for chat tool execution.
 *
 * Provides a bidirectional channel for executing client-side tools
 * during LLM chat sessions. The backend sends tool call requests,
 * and the client executes them and returns results.
 *
 * In development: Uses the shared DevWebSocketService on port+1 because
 * vite-plugin-node doesn't support WebSocket connections.
 *
 * In production: Uses @fastify/websocket on the main Fastify server
 * for simpler deployment (single port).
 */
@Injectable()
export class ChatToolsGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatToolsGateway.name);

  public constructor(
    private readonly chatToolsService: ChatToolsService,
    private readonly devWebSocketService: DevWebSocketService,
    @Inject(HttpAdapterHost) private readonly httpAdapterHost: HttpAdapterHost,
    @Inject(authInstanceKey) private readonly auth: Auth,
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
      this.devWebSocketService.unregisterPathHandler(chatToolsWebSocketPath);
    }
  }

  /**
   * Initialize WebSocket handler for development mode.
   * Uses the shared DevWebSocketService.
   */
  private initDevWebSocket(): void {
    this.devWebSocketService.registerPathHandler(chatToolsWebSocketPath, async (socket, request) => {
      await this.handleConnection(socket, request);
    });

    const wsPort = this.devWebSocketService.getPort();
    this.logger.log(`Chat tools available at ws://localhost:${wsPort}${chatToolsWebSocketPath} (dev mode)`);
  }

  /**
   * Initialize WebSocket routes on Fastify for production.
   * Uses @fastify/websocket which works when NestJS runs directly (not through vite-plugin-node).
   */
  private initFastifyWebSocket(): void {
    const fastify = this.httpAdapterHost.httpAdapter.getInstance<FastifyInstance>();

    // Register the chat tools WebSocket route
    fastify.get(chatToolsWebSocketPath, { websocket: true }, async (socket: WebSocket, request) => {
      await this.handleConnection(socket, request.raw);
    });

    this.logger.log(`Chat tools WebSocket registered at ${chatToolsWebSocketPath} (production mode)`);
  }

  /**
   * Handle a new WebSocket connection.
   * Authenticates the connection and sets up message handling.
   */
  private async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    this.logger.debug('New chat tools WebSocket connection');

    // Authenticate the connection using better-auth
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });

    if (!session) {
      this.logger.warn('Unauthenticated WebSocket connection rejected');
      socket.close(wsCloseCode.unauthenticated, 'Authentication required');
      return;
    }

    this.logger.debug(`Authenticated chat tools connection for user ${session.user.id}`);

    // Set up message handling
    socket.on('message', (data, isBinary) => {
      // WebSocket messages for chat tools are always JSON text, never binary
      if (isBinary) {
        this.logger.warn('Received unexpected binary WebSocket message');
        return;
      }

      // Convert RawData to string - data is either a string or Uint8Array in text mode
      const messageString = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
      this.chatToolsService.handleMessage(socket, messageString);
    });

    socket.on('close', () => {
      this.logger.debug('Chat tools WebSocket connection closed');
    });

    socket.on('error', (socketError) => {
      this.logger.error('Chat tools WebSocket error:', socketError);
    });
  }
}
