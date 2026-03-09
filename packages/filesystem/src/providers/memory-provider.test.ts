import { describe, it, expect } from 'vitest';
import { createMemoryProvider } from '#providers/memory-provider.js';

describe('createMemoryProvider', () => {
  it('should return a provider with id "memory"', async () => {
    const provider = await createMemoryProvider();
    expect(provider.id).toBe('memory');
  });

  it('should have correct capabilities', async () => {
    const provider = await createMemoryProvider();
    expect(provider.capabilities).toEqual({
      persistent: false,
      writable: true,
      quotaBased: false,
    });
  });

  it('should support basic write and read operations', async () => {
    const provider = await createMemoryProvider();
    await provider.writeFile('/test.txt', 'hello memory');
    const content = await provider.readFile('/test.txt', 'utf8');
    expect(content).toBe('hello memory');
  });

  it('should create an independent provider per factory call', async () => {
    const a = await createMemoryProvider();
    const b = await createMemoryProvider();
    await a.writeFile('/only-in-a.txt', 'a');
    expect(await a.exists('/only-in-a.txt')).toBe(true);
    expect(await b.exists('/only-in-a.txt')).toBe(false);
  });
});
