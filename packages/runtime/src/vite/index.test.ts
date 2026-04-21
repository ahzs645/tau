import { describe, it, expect, vi } from 'vitest';
import { crossOriginIsolation } from '#vite/index.js';
import { documentHeaders } from '#cross-origin-isolation/index.js';

type MiddlewareHandler = (
  request: unknown,
  response: { setHeader: ReturnType<typeof vi.fn> },
  next: ReturnType<typeof vi.fn>,
) => void;

function createMockServer() {
  const handlers: MiddlewareHandler[] = [];
  return {
    middlewares: {
      use: vi.fn((handler: MiddlewareHandler) => {
        handlers.push(handler);
      }),
    },
    handlers,
  };
}

describe('crossOriginIsolation (vite plugin)', () => {
  const plugin = crossOriginIsolation();

  it('should have taucad-namespaced metadata and both server hooks', () => {
    expect(plugin.name).toBe('taucad-runtime:cross-origin-isolation');
    expect(plugin.configureServer).toBeTypeOf('function');
    expect(plugin.configurePreviewServer).toBeTypeOf('function');
  });

  it('should register middleware on dev server', () => {
    const server = createMockServer();
    (plugin.configureServer as (server: unknown) => void)(server);
    expect(server.middlewares.use).toHaveBeenCalledOnce();
  });

  it('should register middleware on preview server', () => {
    const server = createMockServer();
    (plugin.configurePreviewServer as (server: unknown) => void)(server);
    expect(server.middlewares.use).toHaveBeenCalledOnce();
  });

  it('should set all three COI headers on a request', () => {
    const server = createMockServer();
    (plugin.configureServer as (server: unknown) => void)(server);

    const response = { setHeader: vi.fn() };
    const next = vi.fn();
    server.handlers[0]!({}, response, next);

    expect(response.setHeader).toHaveBeenCalledWith('Cross-Origin-Opener-Policy', 'same-origin');
    expect(response.setHeader).toHaveBeenCalledWith('Cross-Origin-Embedder-Policy', 'require-corp');
    expect(response.setHeader).toHaveBeenCalledWith('Cross-Origin-Resource-Policy', 'same-origin');
  });

  it('should stay in sync with the canonical documentHeaders from @taucad/runtime/cross-origin-isolation', () => {
    const server = createMockServer();
    (plugin.configureServer as (server: unknown) => void)(server);

    const response = { setHeader: vi.fn() };
    const next = vi.fn();
    server.handlers[0]!({}, response, next);

    for (const [name, value] of Object.entries(documentHeaders)) {
      expect(response.setHeader).toHaveBeenCalledWith(name, value);
    }
    expect(response.setHeader).toHaveBeenCalledTimes(Object.keys(documentHeaders).length);
  });

  it('should call next() to continue the middleware chain', () => {
    const server = createMockServer();
    (plugin.configureServer as (server: unknown) => void)(server);

    const response = { setHeader: vi.fn() };
    const next = vi.fn();
    server.handlers[0]!({}, response, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('should set all headers on every request', () => {
    const server = createMockServer();
    (plugin.configureServer as (server: unknown) => void)(server);

    const response = { setHeader: vi.fn() };
    const next = vi.fn();

    server.handlers[0]!({}, response, next);
    server.handlers[0]!({}, response, next);

    expect(response.setHeader).toHaveBeenCalledTimes(6);
  });
});
