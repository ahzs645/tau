// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import nodeEndpoint from '#components/geometry/kernel/utils/comlink-node-endpoint.js';
import type { NodeEndpoint } from '#components/geometry/kernel/utils/comlink-node-endpoint.js';

describe('comlink-node-endpoint', () => {
  let mockNodePort: NodeEndpoint;

  beforeEach(() => {
    mockNodePort = {
      postMessage: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
  });

  describe('nodeEndpoint', () => {
    it('should return an endpoint with required methods', () => {
      const endpoint = nodeEndpoint(mockNodePort);

      expect(endpoint).toHaveProperty('postMessage');
      expect(endpoint).toHaveProperty('addEventListener');
      expect(endpoint).toHaveProperty('removeEventListener');
    });

    it('should delegate postMessage to the underlying port', () => {
      const endpoint = nodeEndpoint(mockNodePort);
      const message = { type: 'test', data: 42 };
      const transfer = [new ArrayBuffer(8)];

      endpoint.postMessage(message, transfer);

      expect(mockNodePort.postMessage).toHaveBeenCalledWith(message, transfer);
    });

    it('should bind postMessage to the port context', () => {
      const endpoint = nodeEndpoint(mockNodePort);

      // Call postMessage as a standalone function
      const { postMessage } = endpoint;
      postMessage({ test: true });

      expect(mockNodePort.postMessage).toHaveBeenCalledWith({ test: true });
    });

    it('should register message listeners via addEventListener', () => {
      const endpoint = nodeEndpoint(mockNodePort);
      const handler = vi.fn();

      endpoint.addEventListener('message', handler);

      expect(mockNodePort.on).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('should call function handler with message event when receiving data', () => {
      const endpoint = nodeEndpoint(mockNodePort);
      const handler = vi.fn();

      endpoint.addEventListener('message', handler);

      // Get the listener that was registered
      const registeredListener = vi.mocked(mockNodePort.on).mock.calls[0]?.[1] as (data: unknown) => void;

      // Simulate receiving a message
      const testData = { result: 42 };
      registeredListener(testData);

      expect(handler).toHaveBeenCalledWith({ data: testData });
    });

    it('should call handleEvent on EventListener objects when receiving data', () => {
      const endpoint = nodeEndpoint(mockNodePort);
      const handleEvent = vi.fn();
      const eventListener: EventListenerObject = { handleEvent };

      endpoint.addEventListener('message', eventListener);

      // Get the listener that was registered
      const registeredListener = vi.mocked(mockNodePort.on).mock.calls[0]?.[1] as (data: unknown) => void;

      // Simulate receiving a message
      const testData = { result: 'hello' };
      registeredListener(testData);

      expect(handleEvent).toHaveBeenCalledWith({ data: testData });
    });

    it('should remove listeners via removeEventListener', () => {
      const endpoint = nodeEndpoint(mockNodePort);
      const handler = vi.fn();

      // Add and then remove the listener
      endpoint.addEventListener('message', handler);
      endpoint.removeEventListener('message', handler);

      expect(mockNodePort.off).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('should not call off if listener was not registered', () => {
      const endpoint = nodeEndpoint(mockNodePort);
      const unregisteredHandler = vi.fn();

      // Try to remove a listener that was never added
      endpoint.removeEventListener('message', unregisteredHandler);

      expect(mockNodePort.off).not.toHaveBeenCalled();
    });

    it('should handle ports with optional start method', () => {
      const mockStart = vi.fn();
      const portWithStart: NodeEndpoint = {
        ...mockNodePort,
        start: mockStart,
      };

      const endpoint = nodeEndpoint(portWithStart);

      expect(endpoint.start).toBeDefined();
      endpoint.start?.();

      expect(mockStart).toHaveBeenCalled();
    });

    it('should handle ports without start method', () => {
      const portWithoutStart: NodeEndpoint = {
        postMessage: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        // No start method
      };

      const endpoint = nodeEndpoint(portWithoutStart);

      expect(endpoint.start).toBeUndefined();
    });

    it('should maintain separate listener maps for different handlers', () => {
      const endpoint = nodeEndpoint(mockNodePort);
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      endpoint.addEventListener('message', handler1);
      endpoint.addEventListener('message', handler2);

      // Both should be registered
      expect(mockNodePort.on).toHaveBeenCalledTimes(2);

      // Remove only handler1
      endpoint.removeEventListener('message', handler1);

      // Should only remove one
      expect(mockNodePort.off).toHaveBeenCalledTimes(1);

      // Can still remove handler2
      endpoint.removeEventListener('message', handler2);
      expect(mockNodePort.off).toHaveBeenCalledTimes(2);
    });
  });
});
