import { Global, Module } from '@nestjs/common';
import { DevWebSocketService } from '#api/websocket/dev-websocket.service.js';

/**
 * WebSocket module providing shared WebSocket infrastructure.
 *
 * In dev mode, provides DevWebSocketService which runs on port+1 and handles:
 * - Raw WebSocket connections (for Zoo proxy) via path handlers
 * - Socket.IO connections (for chat tools) via Socket.IO namespaces
 */
@Global()
@Module({
  providers: [DevWebSocketService],
  exports: [DevWebSocketService],
})
export class WebSocketModule {}
