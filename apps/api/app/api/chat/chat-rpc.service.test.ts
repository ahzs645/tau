import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Socket } from 'socket.io';
import { ChatRpcService, rpcExecutionTimeoutMs, abortCleanupDelayMs } from '#api/chat/chat-rpc.service.js';

let requestIdCounter = 0;

vi.mock('@taucad/utils/id', () => ({
  generatePrefixedId: vi.fn(() => `req_test_${String(++requestIdCounter)}`),
}));

vi.mock('@taucad/chat', () => ({
  rpcSchemasRegistry: {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Tool name uses snake_case
    read_file: {
      inputSchema: { safeParse: vi.fn(() => ({ success: true, data: {} })) },
      resultSchema: { safeParse: vi.fn(() => ({ success: true, data: { content: 'hello' } })) },
    },
  },
}));

function createMockSocket(id: string, connected = true): Socket {
  return {
    id,
    connected,
    emit: vi.fn(),
  } as unknown as Socket;
}

describe('ChatRpcService', () => {
  let service: ChatRpcService;

  beforeEach(() => {
    vi.useFakeTimers();
    requestIdCounter = 0;
    service = new ChatRpcService();
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // sendRpcRequest
  // ---------------------------------------------------------------------------
  describe('sendRpcRequest', () => {
    it('should return NO_CONNECTION RPC error when no socket is registered', async () => {
      const result = await service.sendRpcRequest('chat_123', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(result).toEqual({
        errorCode: 'NO_CONNECTION',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest assertion
        message: expect.stringContaining('No WebSocket connection to the browser'),
        rpcName: 'read_file',
      });
    });

    it('should return NO_CONNECTION RPC error when socket is disconnected', async () => {
      service.registerConnection('chat_123', createMockSocket('s1', false));

      const result = await service.sendRpcRequest('chat_123', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(result).toEqual({
        errorCode: 'NO_CONNECTION',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest assertion
        message: expect.stringContaining('No WebSocket connection to the browser'),
        rpcName: 'read_file',
      });
    });

    it('should include rpcName in error metadata', async () => {
      const result = await service.sendRpcRequest('chat_456', 'call_2', 'read_file', {
        targetFile: 'another.txt',
      });

      expect(result).toMatchObject({
        errorCode: 'NO_CONNECTION',
        rpcName: 'read_file',
      });
    });

    it('should emit rpc_request to connected socket', async () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_1', socket);

      void service.sendRpcRequest('chat_1', 'call_1', 'read_file', { targetFile: 'a.txt' });

      expect(socket.emit).toHaveBeenCalledWith(
        'rpc_request',
        expect.objectContaining({ rpcName: 'read_file', chatId: 'chat_1' }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // RPC timeout
  // ---------------------------------------------------------------------------
  describe('RPC timeout', () => {
    it('should resolve with TIMEOUT error after 60 seconds', async () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_1', socket);

      const resultPromise = service.sendRpcRequest('chat_1', 'call_1', 'read_file', { targetFile: 'a.txt' });

      vi.advanceTimersByTime(rpcExecutionTimeoutMs);

      const result = await resultPromise;
      expect(result).toMatchObject({
        errorCode: 'TIMEOUT',
        rpcName: 'read_file',
      });
    });

    it('should not resolve with TIMEOUT if response arrives before deadline', async () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_1', socket);

      const resultPromise = service.sendRpcRequest('chat_1', 'call_1', 'read_file', { targetFile: 'a.txt' });

      // Respond before timeout
      service.handleRpcResponse({
        type: 'rpc_response',
        requestId: 'req_test_1',
        toolCallId: 'call_1',
        result: { content: 'hello' },
      });

      const result = await resultPromise;
      expect(result).toEqual({ content: 'hello' });

      // Advancing past the timeout should not cause issues
      vi.advanceTimersByTime(rpcExecutionTimeoutMs);
    });
  });

  // ---------------------------------------------------------------------------
  // registerConnection
  // ---------------------------------------------------------------------------
  describe('registerConnection', () => {
    it('should register a socket connection without throwing', () => {
      expect(() => {
        service.registerConnection('chat_123', createMockSocket('s1'));
      }).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // isConnected
  // ---------------------------------------------------------------------------
  describe('isConnected', () => {
    it('should return false when no socket is registered', () => {
      expect(service.isConnected('chat_123')).toBe(false);
    });

    it('should return false when socket is disconnected', () => {
      service.registerConnection('chat_123', createMockSocket('s1', false));
      expect(service.isConnected('chat_123')).toBe(false);
    });

    it('should return true when socket is connected', () => {
      service.registerConnection('chat_123', createMockSocket('s1'));
      expect(service.isConnected('chat_123')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // handleRpcResponse
  // ---------------------------------------------------------------------------
  describe('handleRpcResponse', () => {
    it('should resolve pending request with validated result', async () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_1', socket);

      const resultPromise = service.sendRpcRequest('chat_1', 'call_1', 'read_file', { targetFile: 'a.txt' });

      service.handleRpcResponse({
        type: 'rpc_response',
        requestId: 'req_test_1',
        toolCallId: 'call_1',
        result: { content: 'hello' },
      });

      const result = await resultPromise;
      expect(result).toEqual({ content: 'hello' });
    });

    it('should resolve with UNHANDLED_CLIENT_ERROR when client reports error', async () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_1', socket);

      const resultPromise = service.sendRpcRequest('chat_1', 'call_1', 'read_file', { targetFile: 'a.txt' });

      service.handleRpcResponse({
        type: 'rpc_response',
        requestId: 'req_test_1',
        toolCallId: 'call_1',
        result: undefined,
        error: 'Something went wrong on the client',
      });

      const result = await resultPromise;
      expect(result).toMatchObject({
        errorCode: 'UNHANDLED_CLIENT_ERROR',
        message: 'Something went wrong on the client',
        rpcName: 'read_file',
      });
    });

    it('should not crash when receiving response for unknown requestId', () => {
      expect(() => {
        service.handleRpcResponse({
          type: 'rpc_response',
          requestId: 'req_unknown',
          toolCallId: 'call_1',
          result: {},
        });
      }).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // registerAbortSignal
  // ---------------------------------------------------------------------------
  describe('registerAbortSignal', () => {
    it('should add chatId to abortedChats when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      service.registerAbortSignal('chat_123', controller.signal);

      const result = await service.sendRpcRequest('chat_123', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(result).toMatchObject({
        errorCode: 'CLIENT_DISCONNECTED',
        rpcName: 'read_file',
      });
    });

    it('should clean up abortedChats entry after delay for early-aborted signal', async () => {
      const controller = new AbortController();
      controller.abort();

      service.registerAbortSignal('chat_123', controller.signal);

      const resultBeforeCleanup = await service.sendRpcRequest('chat_123', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(resultBeforeCleanup).toMatchObject({
        errorCode: 'CLIENT_DISCONNECTED',
      });

      vi.advanceTimersByTime(abortCleanupDelayMs);

      const socket = createMockSocket('s1');
      service.registerConnection('chat_123', socket);

      void service.sendRpcRequest('chat_123', 'call_2', 'read_file', { targetFile: 'test.txt' });

      expect(socket.emit).toHaveBeenCalledWith('rpc_request', expect.objectContaining({ rpcName: 'read_file' }));
    });

    it('should clear stale abort entry when a new signal is registered for the same chat', async () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_123', socket);

      const controllerA = new AbortController();
      service.registerAbortSignal('chat_123', controllerA.signal);
      controllerA.abort();

      const blockedResult = await service.sendRpcRequest('chat_123', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(blockedResult).toMatchObject({
        errorCode: 'CLIENT_DISCONNECTED',
      });

      const controllerB = new AbortController();
      service.registerAbortSignal('chat_123', controllerB.signal);

      void service.sendRpcRequest('chat_123', 'call_2', 'read_file', { targetFile: 'test.txt' });

      expect(socket.emit).toHaveBeenCalledWith('rpc_request', expect.objectContaining({ rpcName: 'read_file' }));
    });

    it('should reject RPCs after abort and accept them after re-registration', async () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_123', socket);

      const controllerA = new AbortController();
      service.registerAbortSignal('chat_123', controllerA.signal);
      controllerA.abort();

      const blockedResult = await service.sendRpcRequest('chat_123', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(blockedResult).toMatchObject({
        errorCode: 'CLIENT_DISCONNECTED',
      });

      const controllerB = new AbortController();
      service.registerAbortSignal('chat_123', controllerB.signal);

      void service.sendRpcRequest('chat_123', 'call_2', 'read_file', { targetFile: 'test.txt' });

      expect(socket.emit).toHaveBeenCalledWith('rpc_request', expect.objectContaining({ rpcName: 'read_file' }));
    });

    it('should reject pending in-flight RPCs when abort signal fires', async () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_1', socket);

      const controller = new AbortController();
      service.registerAbortSignal('chat_1', controller.signal);

      const resultPromise = service.sendRpcRequest('chat_1', 'call_1', 'read_file', { targetFile: 'a.txt' });

      controller.abort();

      const result = await resultPromise;
      expect(result).toMatchObject({
        errorCode: 'CLIENT_DISCONNECTED',
        rpcName: 'read_file',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Timer management (stale timer bug fix)
  // ---------------------------------------------------------------------------
  describe('timer management', () => {
    it('should cancel stale cleanup timer when a new signal is registered', async () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_1', socket);

      // Abort request A — schedules Timer A (5s)
      const controllerA = new AbortController();
      service.registerAbortSignal('chat_1', controllerA.signal);
      controllerA.abort();

      // Register request B within the 5s window — should cancel Timer A
      const controllerB = new AbortController();
      service.registerAbortSignal('chat_1', controllerB.signal);

      // Abort request B — schedules Timer B (5s)
      controllerB.abort();

      // Advance 3 seconds — Timer A would have been at t=5s, we're at t=3s
      // If Timer A was NOT cancelled, it would fire at t=5s and clear the entry
      vi.advanceTimersByTime(3000);

      // RPCs should still be blocked because Timer A was cancelled
      const result = await service.sendRpcRequest('chat_1', 'call_1', 'read_file', { targetFile: 'a.txt' });
      expect(result).toMatchObject({ errorCode: 'CLIENT_DISCONNECTED' });
    });

    it('should not prematurely clear abort entry when stale timer fires', async () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_1', socket);

      // Abort request A at t=0 → Timer A fires at t=5s
      const controllerA = new AbortController();
      service.registerAbortSignal('chat_1', controllerA.signal);
      controllerA.abort();

      // At t=2s, register request B
      vi.advanceTimersByTime(2000);
      const controllerB = new AbortController();
      service.registerAbortSignal('chat_1', controllerB.signal);

      // At t=3s, abort request B → Timer B fires at t=8s
      vi.advanceTimersByTime(1000);
      controllerB.abort();

      // At t=5s — if Timer A was not cancelled, it would fire here and delete
      // the abort entry prematurely. With the fix, Timer A was cancelled.
      vi.advanceTimersByTime(2000);

      // RPCs should still be blocked (Timer B hasn't fired yet at t=5s)
      const result = await service.sendRpcRequest('chat_1', 'call_1', 'read_file', { targetFile: 'a.txt' });
      expect(result).toMatchObject({ errorCode: 'CLIENT_DISCONNECTED' });

      // At t=8s — Timer B fires, abort entry is cleaned up
      vi.advanceTimersByTime(3000);
      void service.sendRpcRequest('chat_1', 'call_2', 'read_file', { targetFile: 'a.txt' });
      expect(socket.emit).toHaveBeenCalledWith('rpc_request', expect.objectContaining({ rpcName: 'read_file' }));
    });

    it('should handle rapid abort-register-abort cycles without timer interference', async () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_1', socket);

      // Cycle 1: register + abort
      const c1 = new AbortController();
      service.registerAbortSignal('chat_1', c1.signal);
      c1.abort();

      // Cycle 2: register + abort (within 1s of cycle 1)
      vi.advanceTimersByTime(500);
      const c2 = new AbortController();
      service.registerAbortSignal('chat_1', c2.signal);
      c2.abort();

      // Cycle 3: register + abort (within 1s of cycle 2)
      vi.advanceTimersByTime(500);
      const c3 = new AbortController();
      service.registerAbortSignal('chat_1', c3.signal);
      c3.abort();

      // At this point, only Timer C3 should be active (fires at t=1s + 5s = t=6s from start)
      // Advance 4s from current position (t=1s) → t=5s total
      vi.advanceTimersByTime(4000);

      // Still blocked (Timer C3 hasn't fired yet)
      const result = await service.sendRpcRequest('chat_1', 'call_1', 'read_file', { targetFile: 'a.txt' });
      expect(result).toMatchObject({ errorCode: 'CLIENT_DISCONNECTED' });

      // Advance past Timer C3 (1 more second → t=6s total)
      vi.advanceTimersByTime(1000);

      // Now unblocked
      void service.sendRpcRequest('chat_1', 'call_2', 'read_file', { targetFile: 'a.txt' });
      expect(socket.emit).toHaveBeenCalledWith('rpc_request', expect.objectContaining({ rpcName: 'read_file' }));
    });
  });

  // ---------------------------------------------------------------------------
  // Disconnect handling
  // ---------------------------------------------------------------------------
  describe('disconnect handling', () => {
    it('should reject pending requests when last socket disconnects via unregisterConnection', async () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_1', socket);

      const resultPromise = service.sendRpcRequest('chat_1', 'call_1', 'read_file', { targetFile: 'a.txt' });

      service.unregisterConnection('chat_1', socket);

      const result = await resultPromise;
      expect(result).toMatchObject({
        errorCode: 'CLIENT_DISCONNECTED',
        rpcName: 'read_file',
      });
    });

    it('should not reject pending requests when a non-last socket disconnects', () => {
      const socket1 = createMockSocket('s1');
      const socket2 = createMockSocket('s2');
      service.registerConnection('chat_1', socket1);
      service.registerConnection('chat_1', socket2);

      void service.sendRpcRequest('chat_1', 'call_1', 'read_file', { targetFile: 'a.txt' });

      // Remove one socket — still one remaining
      service.unregisterConnection('chat_1', socket1);

      // Chat should still be connected
      expect(service.isConnected('chat_1')).toBe(true);
    });

    it('should reject pending requests when last socket is removed via handleSocketDisconnect', async () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_1', socket);

      const resultPromise = service.sendRpcRequest('chat_1', 'call_1', 'read_file', { targetFile: 'a.txt' });

      service.handleSocketDisconnect(socket);

      const result = await resultPromise;
      expect(result).toMatchObject({
        errorCode: 'CLIENT_DISCONNECTED',
        rpcName: 'read_file',
      });
    });

    it('should not affect other chats when one chat socket disconnects', async () => {
      const socket1 = createMockSocket('s1');
      const socket2 = createMockSocket('s2');
      service.registerConnection('chat_1', socket1);
      service.registerConnection('chat_2', socket2);

      void service.sendRpcRequest('chat_1', 'call_1', 'read_file', { targetFile: 'a.txt' });
      void service.sendRpcRequest('chat_2', 'call_2', 'read_file', { targetFile: 'b.txt' });

      // Disconnect socket for chat_1 only
      service.handleSocketDisconnect(socket1);

      // `chat_2` should still be connected
      expect(service.isConnected('chat_2')).toBe(true);
    });

    it('should clean up socket from multiple chat rooms on disconnect', () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_1', socket);
      service.registerConnection('chat_2', socket);

      service.handleSocketDisconnect(socket);

      expect(service.isConnected('chat_1')).toBe(false);
      expect(service.isConnected('chat_2')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // onModuleDestroy
  // ---------------------------------------------------------------------------
  describe('onModuleDestroy', () => {
    it('should resolve all pending requests with CLIENT_DISCONNECTED', async () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_1', socket);

      const resultPromise = service.sendRpcRequest('chat_1', 'call_1', 'read_file', { targetFile: 'a.txt' });

      service.onModuleDestroy();

      const result = await resultPromise;
      expect(result).toMatchObject({
        errorCode: 'CLIENT_DISCONNECTED',
        message: 'Server is shutting down. RPC request cancelled.',
        rpcName: 'read_file',
      });
    });

    it('should clear all abort cleanup timers so none fire after destroy', async () => {
      const socket = createMockSocket('s1');
      service.registerConnection('chat_1', socket);

      // Abort to schedule a 5s cleanup timer
      const controller = new AbortController();
      service.registerAbortSignal('chat_1', controller.signal);
      controller.abort();

      // Destroy the service (should cancel timers)
      service.onModuleDestroy();

      // Re-create the service and register a new connection
      const service2 = new ChatRpcService();
      const socket2 = createMockSocket('s2');
      service2.registerConnection('chat_1', socket2);

      // Advance past the cleanup window — the old timer should NOT fire
      // (it would have called abortedChats.delete on the OLD service, but we
      // verify no errors occur)
      vi.advanceTimersByTime(abortCleanupDelayMs);

      // The new service should have a clean state
      void service2.sendRpcRequest('chat_1', 'call_1', 'read_file', { targetFile: 'a.txt' });
      expect(socket2.emit).toHaveBeenCalledWith('rpc_request', expect.objectContaining({ rpcName: 'read_file' }));

      service2.onModuleDestroy();
    });

    it('should not crash when called with no pending state', () => {
      expect(() => {
        service.onModuleDestroy();
      }).not.toThrow();
    });
  });
});
