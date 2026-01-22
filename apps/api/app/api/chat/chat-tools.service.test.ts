import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Socket } from 'socket.io';
import { ChatToolsService } from '#api/chat/chat-tools.service.js';

// Mock the dependencies
vi.mock('@taucad/utils/id', () => ({
  generatePrefixedId: vi.fn(() => 'req_test123'),
}));

vi.mock('@taucad/chat', () => ({
  clientToolSchemasRegistry: {
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
    it('should return NO_CLIENT_CONNECTION error when no socket is registered', async () => {
      const result = await service.sendToolCallRequest('chat_123', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(result).toEqual({
        errorCode: 'NO_CLIENT_CONNECTION',
        message: expect.stringContaining('No WebSocket connection to the browser'),
        toolName: 'read_file',
        toolCallId: 'call_1',
      });
    });

    it('should return NO_CLIENT_CONNECTION error when socket is disconnected', async () => {
      const mockSocket = {
        id: 'socket_123',
        connected: false,
      } as unknown as Socket;
      service.registerConnection('chat_123', mockSocket);

      const result = await service.sendToolCallRequest('chat_123', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(result).toEqual({
        errorCode: 'NO_CLIENT_CONNECTION',
        message: expect.stringContaining('No WebSocket connection to the browser'),
        toolName: 'read_file',
        toolCallId: 'call_1',
      });
    });

    it('should include chatId context in error metadata', async () => {
      const result = await service.sendToolCallRequest('chat_456', 'call_2', 'read_file', {
        targetFile: 'another.txt',
      });

      expect(result).toMatchObject({
        errorCode: 'NO_CLIENT_CONNECTION',
        toolName: 'read_file',
        toolCallId: 'call_2',
      });
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
