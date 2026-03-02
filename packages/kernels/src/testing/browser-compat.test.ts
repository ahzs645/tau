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
    expect(mod.presets).toBeDefined();
    expect(mod.createBridgePort).toBeTypeOf('function');
    expect(mod.createKernelSuccess).toBeTypeOf('function');
    expect(mod.createKernelError).toBeTypeOf('function');
    expect(mod.fromFsLike).toBeTypeOf('function');
  });

  it('should import the filesystem subpath without errors', async () => {
    const mod = await import('#filesystem/index.js');
    expect(mod.exposeFileSystem).toBeTypeOf('function');
    expect(mod.createFileSystemBridge).toBeTypeOf('function');
    expect(mod.createBridgeServer).toBeTypeOf('function');
    expect(mod.createBridgeProxy).toBeTypeOf('function');
    expect(mod.createBridgePort).toBeTypeOf('function');
  });

  it('should import the middleware entry point without errors', async () => {
    const mod = await import('#middleware/kernel-middleware.js');
    expect(mod.defineMiddleware).toBeTypeOf('function');
    expect(mod.createMiddlewareRuntime).toBeTypeOf('function');
  });

  it('presets.all() should return valid plugin configuration', async () => {
    const { presets } = await import('#plugins/presets.js');
    const config = presets.all();

    expect(config.kernels).toBeInstanceOf(Array);
    expect(config.middleware).toBeInstanceOf(Array);
    expect(config.bundlers).toBeInstanceOf(Array);
    expect(config.kernels.length).toBeGreaterThan(0);
  });
});
