import { describe, it, expect } from 'vitest';
import { createNodeClient } from '#node.js';

describe('createNodeClient', () => {
  it('should return a client with render, export, and terminate methods', async () => {
    const client = await createNodeClient();

    expect(client.render).toBeTypeOf('function');
    expect(client.export).toBeTypeOf('function');
    expect(client.terminate).toBeTypeOf('function');
    expect(client.on).toBeTypeOf('function');
    expect(client.connect).toBeTypeOf('function');

    client.terminate();
  });

  it('should accept a project path for filesystem-backed rendering', async () => {
    const client = await createNodeClient('/tmp');

    expect(client.render).toBeTypeOf('function');

    client.terminate();
  });
});
