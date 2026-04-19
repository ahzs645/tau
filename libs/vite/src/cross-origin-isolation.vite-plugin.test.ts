import { describe, it, expect, vi } from 'vitest';
import { crossOriginIsolation } from '#cross-origin-isolation.vite-plugin.js';

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

describe('crossOriginIsolation', () => {
  const plugin = crossOriginIsolation();

  it('should have correct metadata', () => {
    expect(plugin.name).toBe('vite:cross-origin-isolation');
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

  it('should set Cross-Origin-Opener-Policy header', () => {
    const server = createMockServer();
    (plugin.configureServer as (server: unknown) => void)(server);

    const response = { setHeader: vi.fn() };
    const next = vi.fn();
    server.handlers[0]!({}, response, next);

    expect(response.setHeader).toHaveBeenCalledWith('Cross-Origin-Opener-Policy', 'same-origin');
  });

  it('should set Cross-Origin-Embedder-Policy header', () => {
    const server = createMockServer();
    (plugin.configureServer as (server: unknown) => void)(server);

    const response = { setHeader: vi.fn() };
    const next = vi.fn();
    server.handlers[0]!({}, response, next);

    expect(response.setHeader).toHaveBeenCalledWith('Cross-Origin-Embedder-Policy', 'require-corp');
  });

  it('should set Cross-Origin-Resource-Policy header', () => {
    const server = createMockServer();
    (plugin.configureServer as (server: unknown) => void)(server);

    const response = { setHeader: vi.fn() };
    const next = vi.fn();
    server.handlers[0]!({}, response, next);

    expect(response.setHeader).toHaveBeenCalledWith('Cross-Origin-Resource-Policy', 'same-origin');
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
