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
    const module_ = await import('#index.js');
    expect(module_.presets).toBeDefined();
    expect(module_.createBridgePort).toBeTypeOf('function');
    expect(module_.createKernelSuccess).toBeTypeOf('function');
    expect(module_.createKernelError).toBeTypeOf('function');
    expect(module_.fromFsLike).toBeTypeOf('function');
  });

  it('should import the filesystem subpath without errors', async () => {
    const module_ = await import('#filesystem/index.js');
    expect(module_.exposeFileSystem).toBeTypeOf('function');
    expect(module_.createFileSystemBridge).toBeTypeOf('function');
    expect(module_.createBridgeServer).toBeTypeOf('function');
    expect(module_.createBridgeProxy).toBeTypeOf('function');
    expect(module_.createBridgePort).toBeTypeOf('function');
  });

  it('should import the middleware entry point without errors', async () => {
    const module_ = await import('#middleware/runtime-middleware.js');
    expect(module_.defineMiddleware).toBeTypeOf('function');
    expect(module_.createMiddlewareRuntime).toBeTypeOf('function');
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
