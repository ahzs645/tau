/* eslint-disable @typescript-eslint/member-ordering -- NestJS gateway has specific method ordering requirements */
/* eslint-disable new-cap -- NestJS decorators use PascalCase */
import { Inject, Logger } from '@nestjs/common';
import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit } from '@nestjs/websockets';
import { WebSocketGateway, WebSocketServer, SubscribeMessage, ConnectedSocket, MessageBody } from '@nestjs/websockets';
import type { Server, Socket, Namespace } from 'socket.io';
import type { Auth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import type { RpcResponse } from '@taucad/chat';
import { authInstanceKey } from '#constants/auth.constant.js';
import { ChatRpcService } from '#api/chat/chat-rpc.service.js';
import { DevWebSocketService } from '#api/websocket/dev-websocket.service.js';

const chatRpcPath = '/v1/chat/rpc';

/**
 * WebSocket Gateway for chat RPC execution using Socket.IO.
 *
 * Provides a bidirectional channel for executing client-side RPC operations
 * during LLM chat sessions. The backend sends RPC requests,
 * and the client executes them and returns results.
 *
 * In development: Uses DevWebSocketService's Socket.IO server on port+1
 * because vite-plugin-node doesn't support WebSocket connections.
 *
 * In production: Uses Socket.IO with Redis adapter for horizontal scaling
 * across multiple API instances.
 */
@WebSocketGateway({
  path: chatRpcPath,
  transports: ['websocket'],
  cors: false, // CORS handled by NestJS/Fastify
})
export class ChatRpcGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  @WebSocketServer()
  // @ts-expect-error Injected by NestJS in production, manually set in dev
  private readonly server!: Server;

  private readonly logger = new Logger(ChatRpcGateway.name);
  private devServer: Namespace | undefined;

  public constructor(
    private readonly chatRpcService: ChatRpcService,
    private readonly devWebSocketService: DevWebSocketService,
    @Inject(authInstanceKey) private readonly auth: Auth,
  ) {}

  /**
   * Initialize the gateway based on environment.
   */
  public onModuleInit(): void {
    if (import.meta.env.DEV) {
      this.initDevSocketIo();
    }
  }

  /**
   * Clean up when module is destroyed.
   */
  public onModuleDestroy(): void {
    // DevWebSocketService handles its own cleanup
  }

  /**
   * Initialize Socket.IO handlers for development mode.
   * Uses the shared DevWebSocketService's Socket.IO server.
   */
  private initDevSocketIo(): void {
    const io = this.devWebSocketService.getSocketIoServer();

    // Create a namespace for chat RPC
    this.devServer = io.of(chatRpcPath);

    // Set up connection handling
    this.devServer.on('connection', (socket: Socket) => {
      void this.handleDevConnection(socket);
    });

    const port = this.devWebSocketService.getPort();
    this.logger.log(`Chat RPC Socket.IO available at http://localhost:${port}${chatRpcPath} (dev mode)`);
  }

  /**
   * Handle connection in dev mode (manually wired up).
   */
  private async handleDevConnection(client: Socket): Promise<void> {
    this.logger.debug(`[Dev] Client connecting: ${client.id}`);

    try {
      // Authenticate using cookies from the handshake request
      const session = await this.auth.api.getSession({
        headers: fromNodeHeaders(client.handshake.headers),
      });

      if (!session) {
        this.logger.warn(`[Dev] Unauthenticated connection rejected: ${client.id}`);
        client.emit('error', { code: 'UNAUTHENTICATED', message: 'Authentication required' });
        client.disconnect(true);
        return;
      }

      // Store user info on socket for later use
      client.data.userId = session.user.id;
      this.logger.debug(`[Dev] Authenticated connection: ${client.id} (user: ${session.user.id})`);

      // Set up message handlers
      client.on('join', (data: { chatId: string }) => {
        const result = this.handleJoinMessage(client, data);
        // Socket.IO acknowledgment
        client.emit('join_ack', result);
      });

      client.on('leave', (data: { chatId: string }) => {
        this.handleLeaveMessage(client, data);
      });

      client.on('rpc_response', (message: RpcResponse) => {
        this.chatRpcService.handleRpcResponse(message);
      });

      client.on('disconnect', () => {
        this.handleDevDisconnect(client);
      });
    } catch (authError) {
      this.logger.error(`[Dev] Authentication error for ${client.id}:`, authError);
      client.emit('error', { code: 'AUTH_ERROR', message: 'Authentication failed' });
      client.disconnect(true);
    }
  }

  /**
   * Handle disconnect in dev mode.
   */
  private handleDevDisconnect(client: Socket): void {
    // Clean up all chat registrations for this socket
    this.chatRpcService.handleSocketDisconnect(client);
    this.logger.debug(`[Dev] Client disconnected: ${client.id}`);
  }

  /**
   * Shared join logic for both dev and prod.
   * Supports joining multiple rooms - doesn't leave previous rooms.
   */
  private handleJoinMessage(client: Socket, data: { chatId: string } | undefined): { success: boolean } {
    const chatId = data?.chatId;

    if (!chatId) {
      this.logger.warn(`Join request without chatId from ${client.id}`);
      return { success: false };
    }

    // Join chat room and register connection
    void client.join(chatId);
    this.chatRpcService.registerConnection(chatId, client);

    this.logger.debug(`Client ${client.id} joined chat: ${chatId}`);
    return { success: true };
  }

  /**
   * Shared leave logic for both dev and prod.
   */
  private handleLeaveMessage(client: Socket, data: { chatId: string } | undefined): void {
    const chatId = data?.chatId;

    if (!chatId) {
      this.logger.warn(`Leave request without chatId from ${client.id}`);
      return;
    }

    // Leave the room and unregister
    void client.leave(chatId);
    this.chatRpcService.unregisterConnection(chatId, client);

    this.logger.debug(`Client ${client.id} left chat: ${chatId}`);
  }

  // ============================================
  // Production mode handlers (NestJS decorators)
  // ============================================

  /**
   * Called when the Socket.IO server is initialized (production only).
   */
  public afterInit(_server: Server): void {
    if (import.meta.env.PROD) {
      this.logger.log('Chat RPC Socket.IO gateway initialized (production)');
    }
  }

  /**
   * Handle client joining a chat room (production only).
   */
  @SubscribeMessage('join')
  public handleJoin(@ConnectedSocket() client: Socket, @MessageBody() data: { chatId: string }): { success: boolean } {
    // In dev mode, this is handled by the dev connection handler
    if (import.meta.env.DEV) {
      return { success: false };
    }

    return this.handleJoinMessage(client, data);
  }

  /**
   * Handle client leaving a chat room (production only).
   */
  @SubscribeMessage('leave')
  public handleLeave(@ConnectedSocket() client: Socket, @MessageBody() data: { chatId: string }): void {
    // In dev mode, this is handled by the dev connection handler
    if (import.meta.env.DEV) {
      return;
    }

    this.handleLeaveMessage(client, data);
  }

  /**
   * Handle RPC responses from the client (production only).
   */
  @SubscribeMessage('rpc_response')
  public handleRpcResponse(@ConnectedSocket() _client: Socket, @MessageBody() message: RpcResponse): void {
    // In dev mode, this is handled by the dev connection handler
    if (import.meta.env.DEV) {
      return;
    }

    this.chatRpcService.handleRpcResponse(message);
  }

  /**
   * Handle a new client connection (production only).
   */
  public async handleConnection(client: Socket): Promise<void> {
    // In dev mode, this is handled by handleDevConnection
    if (import.meta.env.DEV) {
      return;
    }

    this.logger.debug(`Client connecting: ${client.id}`);

    try {
      const session = await this.auth.api.getSession({
        headers: fromNodeHeaders(client.handshake.headers),
      });

      if (!session) {
        this.logger.warn(`Unauthenticated connection rejected: ${client.id}`);
        client.emit('error', { code: 'UNAUTHENTICATED', message: 'Authentication required' });
        client.disconnect(true);
        return;
      }

      client.data.userId = session.user.id;
      this.logger.debug(`Authenticated connection: ${client.id} (user: ${session.user.id})`);
    } catch (authError) {
      this.logger.error(`Authentication error for ${client.id}:`, authError);
      client.emit('error', { code: 'AUTH_ERROR', message: 'Authentication failed' });
      client.disconnect(true);
    }
  }

  /**
   * Handle client disconnection (production only).
   */
  public handleDisconnect(client: Socket): void {
    // In dev mode, this is handled by handleDevDisconnect
    if (import.meta.env.DEV) {
      return;
    }

    // Clean up all chat registrations for this socket
    this.chatRpcService.handleSocketDisconnect(client);
    this.logger.debug(`Client disconnected: ${client.id}`);
  }
}
