import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Socket } from 'socket.io';
import { ChatToolsService } from '#api/chat/chat-tools.service.js';

// Mock the dependencies
vi.mock('@taucad/utils/id', () => ({
  generatePrefixedId: vi.fn(() => 'req_test123'),
}));

vi.mock('@taucad/chat', () => ({
  toolSchemasRegistry: {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Tool name uses snake_case
    read_file: {
      inputSchema: { safeParse: vi.fn(() => ({ success: true, data: {} })) },
      outputSchema: { safeParse: vi.fn(() => ({ success: true, data: {} })) },
    },
  },
}));

describe('ChatToolsService', () => {
  let service: ChatToolsService;

  beforeEach(() => {
    service = new ChatToolsService();
  });

  describe('sendToolCallRequest', () => {
    it('should throw CLIENT_DISCONNECTED error when no socket is registered', async () => {
      await expect(
        service.sendToolCallRequest('chat_123', 'call_1', 'read_file', {
          targetFile: 'test.txt',
        }),
      ).rejects.toThrow('CLIENT_DISCONNECTED');
    });

    it('should throw CLIENT_DISCONNECTED error when socket is disconnected', async () => {
      const mockSocket = {
        id: 'socket_123',
        connected: false,
      } as unknown as Socket;
      service.registerConnection('chat_123', mockSocket);

      await expect(
        service.sendToolCallRequest('chat_123', 'call_1', 'read_file', {
          targetFile: 'test.txt',
        }),
      ).rejects.toThrow('CLIENT_DISCONNECTED');
    });
  });

  describe('registerConnection', () => {
    it('should register a socket connection without throwing', () => {
      const mockSocket = {
        id: 'socket_123',
        connected: true,
      } as unknown as Socket;

      expect(() => {
        service.registerConnection('chat_123', mockSocket);
      }).not.toThrow();
    });
  });

  describe('isConnected', () => {
    it('should return false when no socket is registered', () => {
      expect(service.isConnected('chat_123')).toBe(false);
    });

    it('should return false when socket is disconnected', () => {
      const mockSocket = {
        id: 'socket_123',
        connected: false,
      } as unknown as Socket;
      service.registerConnection('chat_123', mockSocket);

      expect(service.isConnected('chat_123')).toBe(false);
    });

    it('should return true when socket is connected', () => {
      const mockSocket = {
        id: 'socket_123',
        connected: true,
      } as unknown as Socket;
      service.registerConnection('chat_123', mockSocket);

      expect(service.isConnected('chat_123')).toBe(true);
    });
  });
});
