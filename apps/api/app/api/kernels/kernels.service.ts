import { Buffer } from 'node:buffer';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import type { Environment } from '#config/environment.config.js';

/**
 * RFC 6455 close codes that are reserved and must not be sent in a close frame.
 * - 1005: No Status Rcvd - must not be sent
 * - 1006: Abnormal Closure - must not be sent
 * - 1015: TLS Handshake - must not be sent
 */
const forbiddenCloseCodes = new Set([1005, 1006, 1015]);

/**
 * Validates a WebSocket close code according to RFC 6455.
 * Returns the original code if valid, otherwise returns 1011 (Internal Error).
 *
 * Valid codes: 1000-4999, excluding 1005, 1006, 1015
 * @param code - The close code to validate (may be undefined)
 * @returns A valid close code safe to send in a WebSocket close frame
 */
function getSafeCloseCode(code: number | undefined): number {
  // Missing or out of valid range (1000-4999)
  if (code === undefined || code < 1000 || code > 4999) {
    return 1011;
  }

  // Forbidden/reserved codes that must not be sent
  if (forbiddenCloseCodes.has(code)) {
    return 1011;
  }

  return code;
}

@Injectable()
export class KernelsService {
  private readonly logger = new Logger(KernelsService.name);
  private readonly zooApiKey: string;
  private readonly zooWebsocketUrl: string;

  public constructor(private readonly configService: ConfigService<Environment, true>) {
    this.zooApiKey = this.configService.get('ZOO_API_KEY', { infer: true });
    this.zooWebsocketUrl = this.configService.get('ZOO_WEBSOCKET_URL', { infer: true });
  }

  /**
   * Create a WebSocket connection to the Zoo API and handle bidirectional proxying.
   * @param clientSocket - The client's WebSocket connection
   * @param queryParameters - Query parameters to forward to Zoo API
   */
  public createZooProxy(clientSocket: WebSocket, queryParameters: URLSearchParams): void {
    // Build the Zoo API WebSocket URL with query parameters
    const zooUrl = new URL('/ws/modeling/commands', this.zooWebsocketUrl);
    for (const [key, value] of queryParameters.entries()) {
      zooUrl.searchParams.set(key, value);
    }

    this.logger.debug(`Connecting to Zoo API: ${zooUrl.toString()}`);

    // Create connection to Zoo API
    const zooSocket = new WebSocket(zooUrl);
    zooSocket.binaryType = 'arraybuffer';

    let isZooAuthenticated = false;
    let clientClosed = false;
    let zooClosed = false;

    // Handle Zoo socket open - send authentication
    zooSocket.addEventListener('open', () => {
      this.logger.debug('Zoo WebSocket connected, sending authentication');

      // Send authentication headers as expected by Zoo API
      const authMessage = JSON.stringify({
        type: 'headers',
        headers: {
          // eslint-disable-next-line @typescript-eslint/naming-convention -- Zoo API expects this format
          Authorization: `Bearer ${this.zooApiKey}`,
        },
      });
      zooSocket.send(authMessage);
    });

    // Handle messages from Zoo -> forward to client
    zooSocket.addEventListener('message', (event) => {
      if (clientClosed) {
        return;
      }

      // Check if this is the authentication success response
      if (!isZooAuthenticated && typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data) as { success?: boolean; resp?: { type?: string } };
          if (message.success && message.resp?.type === 'modeling_session_data') {
            isZooAuthenticated = true;
            this.logger.debug('Zoo authentication successful');
          }
        } catch {
          // Not JSON, continue forwarding
        }
      }

      // Forward message to client
      try {
        if (clientSocket.readyState === WebSocket.OPEN) {
          if (event.data instanceof ArrayBuffer) {
            clientSocket.send(Buffer.from(event.data));
          } else {
            clientSocket.send(event.data);
          }
        }
      } catch (error) {
        this.logger.error('Error forwarding message to client:', error);
      }
    });

    // Handle messages from client -> forward to Zoo
    clientSocket.addEventListener('message', (event) => {
      if (zooClosed) {
        return;
      }

      // Intercept and drop 'headers' messages from client - proxy handles authentication
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data) as { type?: string };
          if (message.type === 'headers') {
            this.logger.debug('Dropping client headers message - proxy handles authentication');
            return;
          }
        } catch {
          // Not JSON, continue forwarding
        }
      }

      try {
        if (zooSocket.readyState === WebSocket.OPEN) {
          // Forward the message as-is (binary or text)
          zooSocket.send(event.data);
        }
      } catch (error) {
        this.logger.error('Error forwarding message to Zoo:', error);
      }
    });

    // Handle Zoo socket close
    zooSocket.addEventListener('close', (event) => {
      zooClosed = true;
      this.logger.debug(`Zoo WebSocket closed: code=${event.code}, reason=${event.reason}`);

      if (!clientClosed && clientSocket.readyState === WebSocket.OPEN) {
        // Forward the close code if valid per RFC 6455, otherwise use 1011 (Internal Error)
        const closeCode = getSafeCloseCode(event.code);
        clientSocket.close(closeCode, event.reason || 'Upstream connection closed');
      }
    });

    // Handle Zoo socket error
    zooSocket.addEventListener('error', (event) => {
      this.logger.error('Zoo WebSocket error:', event);

      if (!clientClosed && clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.close(1011, 'Upstream connection error');
      }
    });

    // Handle client socket close
    clientSocket.addEventListener('close', () => {
      clientClosed = true;
      this.logger.debug('Client WebSocket closed');

      if (!zooClosed && zooSocket.readyState === WebSocket.OPEN) {
        zooSocket.close();
      }
    });

    // Handle client socket error
    clientSocket.addEventListener('error', (event) => {
      this.logger.error('Client WebSocket error:', event);

      if (!zooClosed && zooSocket.readyState === WebSocket.OPEN) {
        zooSocket.close();
      }
    });
  }
}
