import { describe, it, expect } from 'vitest';
import { isWorkerContext, getWorkerMessagePort } from '#framework/kernel-message-adapter.js';

describe('isWorkerContext', () => {
  it('should return false when running on the main thread', () => {
    expect(isWorkerContext()).toBe(false);
  });
});

describe('getWorkerMessagePort', () => {
  it('should throw when called outside a worker context', () => {
    expect(() => getWorkerMessagePort()).toThrow('getWorkerMessagePort() must be called from a worker context');
  });

  it('should throw an Error instance with the expected message', () => {
    try {
      getWorkerMessagePort();
      expect.fail('should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('getWorkerMessagePort() must be called from a worker context');
    }
  });
});
