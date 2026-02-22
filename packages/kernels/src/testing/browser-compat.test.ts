/**
 * @vitest-environment jsdom
 *
 * Browser compatibility gate.
 * Verifies that the main entry point and key modules can be imported
 * without relying on Node.js-only APIs at import time.
 */

import { describe, it, expect } from 'vitest';

describe('Browser compatibility (jsdom)', () => {
  it('should import the main entry point without errors', async () => {
    const mod = await import('#index.js');
    expect(mod.createDefaultConfig).toBeTypeOf('function');
    expect(mod.createFileManagerPort).toBeTypeOf('function');
    expect(mod.createKernelSuccess).toBeTypeOf('function');
    expect(mod.createKernelError).toBeTypeOf('function');
  });

  it('should import the middleware entry point without errors', async () => {
    const mod = await import('#middleware/kernel-middleware.js');
    expect(mod.createKernelMiddleware).toBeTypeOf('function');
    expect(mod.createMiddlewareRuntime).toBeTypeOf('function');
  });

  it('should import the config module without errors', async () => {
    const mod = await import('#config.js');
    expect(mod.createDefaultConfig).toBeTypeOf('function');
  });

  it('createDefaultConfig should return valid configuration', async () => {
    const { createDefaultConfig } = await import('#config.js');
    const config = createDefaultConfig();

    expect(config.workerUrl).toBeTypeOf('string');
    expect(config.kernelConfig).toBeInstanceOf(Array);
    expect(config.middlewareConfig).toBeInstanceOf(Array);
    expect(config.bundlerConfig).toBeInstanceOf(Array);
    expect(config.kernelConfig.length).toBeGreaterThan(0);
  });

  it('createDefaultConfig should support disabling kernels', async () => {
    const { createDefaultConfig } = await import('#config.js');
    const config = createDefaultConfig({
      kernels: { zoo: { enabled: false } },
    });

    const zooKernel = config.kernelConfig.find((k) => k.id === 'zoo');
    expect(zooKernel).toBeUndefined();
  });
});
