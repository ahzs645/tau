import { Buffer } from 'node:buffer';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import type { Environment } from '#config/environment.config.js';

const zooBaseUrl = 'wss://api.zoo.dev';

@Injectable()
export class KernelsService {
  private readonly logger = new Logger(KernelsService.name);
  private readonly zooApiKey: string;

  public constructor(private readonly configService: ConfigService<Environment, true>) {
    this.zooApiKey = this.configService.get('ZOO_API_KEY', { infer: true });
  }

  /**
   * Create a WebSocket connection to the Zoo API and handle bidirectional proxying.
   * @param clientSocket - The client's WebSocket connection
   * @param queryParameters - Query parameters to forward to Zoo API
   */
  public createZooProxy(clientSocket: WebSocket, queryParameters: URLSearchParams): void {
    // Build the Zoo API WebSocket URL with query parameters
    const zooUrl = new URL('/ws/modeling/commands', zooBaseUrl);
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
        // Use a valid close code - some codes like 1006 are reserved and cannot be sent
        // Use 1001 (Going Away) as a generic "upstream closed" indicator
        const closeCode = event.code >= 1000 && event.code <= 1003 ? event.code : 1001;
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
