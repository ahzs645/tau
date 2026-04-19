import { describe, it, expect } from 'vitest';
import { isWorkerContext, getWorkerMessagePort } from '#framework/runtime-message-adapter.js';

describe('isWorkerContext', () => {
  it('should return false when running on the main thread', async () => {
    await expect(isWorkerContext()).resolves.toBe(false);
  });
});

describe('getWorkerMessagePort', () => {
  it('should reject when called outside a worker context', async () => {
    await expect(getWorkerMessagePort()).rejects.toThrow('getWorkerMessagePort() must be called from a worker context');
  });

  it('should reject with an Error instance with the expected message', async () => {
    try {
      await getWorkerMessagePort();
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('getWorkerMessagePort() must be called from a worker context');
    }
  });
});
