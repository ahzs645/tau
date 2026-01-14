import { Global, Module } from '@nestjs/common';
import { DevWebSocketService } from '#api/websocket/dev-websocket.service.js';

/**
 * WebSocket module providing shared WebSocket infrastructure.
 *
 * In dev mode, provides a shared WebSocket server that multiple
 * gateways can register their handlers with.
 */
@Global()
@Module({
  providers: [DevWebSocketService],
  exports: [DevWebSocketService],
})
export class WebSocketModule {}
