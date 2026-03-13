import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import type { Geometry } from '@taucad/types';
import type { RuntimeClient, RuntimeClientOptions, HashedGeometryResult, GetParametersResult } from '@taucad/runtime';
import { createRuntimeClient, createRuntimeClientOptions } from '@taucad/runtime';
import { createMockRuntimeClient } from '@taucad/runtime/testing';
import { replicad } from '@taucad/runtime/kernels';
import { esbuild } from '@taucad/runtime/bundler';
import { useRender } from '#hooks/use-render.js';
import type { UseRenderOptions } from '#hooks/use-render.js';

vi.mock('@taucad/runtime', async (importOriginal) => {
  // oxlint-disable-next-line typescript/consistent-type-imports -- dynamic import required for vi.mock factory
  const original: typeof import('@taucad/runtime') = await importOriginal();
  return {
    ...original,
    createRuntimeClient: vi.fn(),
  };
});

const testClientOptions: RuntimeClientOptions = createRuntimeClientOptions({
  kernels: [replicad()],
  bundlers: [esbuild()],
});

const successGeometries: Geometry[] = [{ format: 'gltf', content: new Uint8Array([1, 2, 3]), hash: 'abc123' }];

const successResult: HashedGeometryResult = {
  success: true,
  data: successGeometries,
  issues: [],
};

const errorResult: HashedGeometryResult = {
  success: false,
  issues: [{ message: 'Kernel error: invalid geometry', severity: 'error' }],
};

function createConfiguredMockClient(result: HashedGeometryResult = successResult): RuntimeClient {
  const client = createMockRuntimeClient();
  vi.mocked(client.render).mockResolvedValue(result);
  vi.mocked(createRuntimeClient).mockReturnValue(client);
  return client;
}

function defaultOptions(overrides: Partial<UseRenderOptions> = {}): UseRenderOptions {
  return {
    clientOptions: testClientOptions,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- file path key
    code: { 'main.ts': 'export default () => ({})' },
    ...overrides,
  };
}

describe('useRender', () => {
  beforeEach(() => {
    vi.mocked(createRuntimeClient).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Initial state ─────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('should return idle status with empty geometries when disabled', () => {
      createConfiguredMockClient();

      const { result } = renderHook(() => useRender(defaultOptions({ enabled: false })));

      expect(result.current.status).toBe('idle');
      expect(result.current.geometries).toEqual([]);
    });

    it('should return undefined error and empty defaults when disabled', () => {
      createConfiguredMockClient();

      const { result } = renderHook(() => useRender(defaultOptions({ enabled: false })));

      expect(result.current.error).toBeUndefined();
      expect(result.current.defaultParameters).toEqual({});
      expect(result.current.jsonSchema).toBeUndefined();
    });
  });

  // ── Rendering lifecycle ───────────────────────────────────────────────────

  describe('rendering lifecycle', () => {
    it('should create a RuntimeClient with the provided client options', () => {
      createConfiguredMockClient();

      renderHook(() => useRender(defaultOptions()));

      expect(createRuntimeClient).toHaveBeenCalledWith(testClientOptions);
    });

    it('should call client.render with code and parameters when enabled', () => {
      const client = createConfiguredMockClient();
      const parameters = { width: 42 };

      renderHook(() => useRender(defaultOptions({ parameters })));

      expect(client.render).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/naming-convention -- file path key in assertion
          code: { 'main.ts': 'export default () => ({})' },
          parameters,
        }),
      );
    });

    it('should transition status to loading then success on successful render', async () => {
      createConfiguredMockClient();

      const { result } = renderHook(() => useRender(defaultOptions()));

      await waitFor(() => {
        expect(result.current.status).toBe('success');
      });
    });

    it('should return geometries from successful render result', async () => {
      createConfiguredMockClient(successResult);

      const { result } = renderHook(() => useRender(defaultOptions()));

      await waitFor(() => {
        expect(result.current.status).toBe('success');
      });

      expect(result.current.geometries).toEqual(successGeometries);
      expect(result.current.error).toBeUndefined();
    });

    it('should transition status to error when render returns unsuccessful result', async () => {
      createConfiguredMockClient(errorResult);

      const { result } = renderHook(() => useRender(defaultOptions()));

      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });
    });

    it('should set error with issue message from unsuccessful render result', async () => {
      createConfiguredMockClient(errorResult);

      const { result } = renderHook(() => useRender(defaultOptions()));

      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe('Kernel error: invalid geometry');
    });

    it('should transition status to error when render rejects with an exception', async () => {
      const client = createMockRuntimeClient();
      vi.mocked(client.render).mockRejectedValue(new Error('Worker crashed'));
      vi.mocked(createRuntimeClient).mockReturnValue(client);

      const { result } = renderHook(() => useRender(defaultOptions()));

      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });
    });

    it('should set error from the rejected exception', async () => {
      const client = createMockRuntimeClient();
      vi.mocked(client.render).mockRejectedValue(new Error('Worker crashed'));
      vi.mocked(createRuntimeClient).mockReturnValue(client);

      const { result } = renderHook(() => useRender(defaultOptions()));

      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe('Worker crashed');
    });

    it('should use fallback message when error result has empty issues array', async () => {
      const emptyIssuesResult: HashedGeometryResult = {
        success: false,
        issues: [],
      };
      createConfiguredMockClient(emptyIssuesResult);

      const { result } = renderHook(() => useRender(defaultOptions()));

      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });

      expect(result.current.error?.message).toBe('Render failed');
    });

    it('should wrap non-Error rejection values in an Error', async () => {
      const client = createMockRuntimeClient();
      vi.mocked(client.render).mockRejectedValue('string error');
      vi.mocked(createRuntimeClient).mockReturnValue(client);

      const { result } = renderHook(() => useRender(defaultOptions()));

      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe('string error');
    });
  });

  // ── Parameter resolution ──────────────────────────────────────────────────

  describe('parameter resolution', () => {
    it('should subscribe to parametersResolved event on client creation', () => {
      const client = createConfiguredMockClient();

      renderHook(() => useRender(defaultOptions()));

      expect(client.on).toHaveBeenCalledWith('parametersResolved', expect.any(Function));
    });

    it('should expose defaultParameters when parametersResolved fires with success', async () => {
      const client = createMockRuntimeClient();
      let parametersHandler: ((result: GetParametersResult) => void) | undefined;

      const unsubscribe = vi.fn();
      vi.mocked(client.on).mockImplementation((event: string, handler: (...args: never[]) => void) => {
        if (event === 'parametersResolved') {
          parametersHandler = handler as (result: GetParametersResult) => void;
        }
        return unsubscribe;
      });
      vi.mocked(client.render).mockResolvedValue(successResult);
      vi.mocked(createRuntimeClient).mockReturnValue(client);

      const { result } = renderHook(() => useRender(defaultOptions()));

      act(() => {
        parametersHandler?.({
          success: true,
          data: {
            defaultParameters: { width: 10, height: 20 },
            jsonSchema: { type: 'object', properties: { width: { type: 'number' } } },
          },
          issues: [],
        });
      });

      expect(result.current.defaultParameters).toEqual({ width: 10, height: 20 });
    });

    it('should expose jsonSchema when parametersResolved fires with success', async () => {
      const client = createMockRuntimeClient();
      let parametersHandler: ((result: GetParametersResult) => void) | undefined;

      const unsubscribe = vi.fn();
      vi.mocked(client.on).mockImplementation((event: string, handler: (...args: never[]) => void) => {
        if (event === 'parametersResolved') {
          parametersHandler = handler as (result: GetParametersResult) => void;
        }
        return unsubscribe;
      });
      vi.mocked(client.render).mockResolvedValue(successResult);
      vi.mocked(createRuntimeClient).mockReturnValue(client);

      const { result } = renderHook(() => useRender(defaultOptions()));

      const schema = { type: 'object', properties: { size: { type: 'number' } } };

      act(() => {
        parametersHandler?.({
          success: true,
          data: { defaultParameters: {}, jsonSchema: schema },
          issues: [],
        });
      });

      expect(result.current.jsonSchema).toEqual(schema);
    });

    it('should not update parameters state when parametersResolved fires with failure', async () => {
      const client = createMockRuntimeClient();
      let parametersHandler: ((result: GetParametersResult) => void) | undefined;

      const unsubscribe = vi.fn();
      vi.mocked(client.on).mockImplementation((event: string, handler: (...args: never[]) => void) => {
        if (event === 'parametersResolved') {
          parametersHandler = handler as (result: GetParametersResult) => void;
        }
        return unsubscribe;
      });
      vi.mocked(client.render).mockResolvedValue(successResult);
      vi.mocked(createRuntimeClient).mockReturnValue(client);

      const { result } = renderHook(() => useRender(defaultOptions()));

      act(() => {
        parametersHandler?.({
          success: false,
          issues: [{ message: 'parse error', severity: 'error' }],
        });
      });

      expect(result.current.defaultParameters).toEqual({});
      expect(result.current.jsonSchema).toBeUndefined();
    });
  });

  // ── Reactive updates ──────────────────────────────────────────────────────

  describe('reactive updates', () => {
    it('should re-render when code reference changes', async () => {
      const client = createConfiguredMockClient();

      // eslint-disable-next-line @typescript-eslint/naming-convention -- file path key
      const code1 = { 'main.ts': 'version 1' };
      // eslint-disable-next-line @typescript-eslint/naming-convention -- file path key
      const code2 = { 'main.ts': 'version 2' };

      const { rerender } = renderHook(({ code }) => useRender(defaultOptions({ code })), {
        initialProps: { code: code1 },
      });

      await waitFor(() => {
        expect(client.render).toHaveBeenCalledTimes(1);
      });

      rerender({ code: code2 });

      await waitFor(() => {
        expect(client.render).toHaveBeenCalledTimes(2);
      });

      expect(client.render).toHaveBeenLastCalledWith(expect.objectContaining({ code: code2 }));
    });

    it('should re-render when parameters reference changes', async () => {
      const client = createConfiguredMockClient();

      const params1 = { width: 10 };
      const params2 = { width: 20 };

      const { result, rerender } = renderHook(({ parameters }) => useRender(defaultOptions({ parameters })), {
        initialProps: { parameters: params1 },
      });

      await waitFor(() => {
        expect(result.current.status).toBe('success');
      });

      rerender({ parameters: params2 });

      await waitFor(() => {
        expect(client.render).toHaveBeenLastCalledWith(expect.objectContaining({ parameters: params2 }));
      });
    });

    it('should not call client.render when enabled is false', () => {
      const client = createConfiguredMockClient();

      renderHook(() => useRender(defaultOptions({ enabled: false })));

      expect(client.render).not.toHaveBeenCalled();
    });

    it('should call client.render when enabled transitions from false to true', async () => {
      const client = createConfiguredMockClient();

      const { rerender } = renderHook(({ enabled }) => useRender(defaultOptions({ enabled })), {
        initialProps: { enabled: false },
      });

      expect(client.render).not.toHaveBeenCalled();

      rerender({ enabled: true });

      await waitFor(() => {
        expect(client.render).toHaveBeenCalled();
      });
    });

    it('should cancel previous render result when inputs change before completion', async () => {
      const client = createMockRuntimeClient();

      let resolveFirst: ((value: HashedGeometryResult) => void) | undefined;
      const firstRender = new Promise<HashedGeometryResult>((resolve) => {
        resolveFirst = resolve;
      });

      const staleGeometries: Geometry[] = [{ format: 'gltf', content: new Uint8Array([99]), hash: 'stale' }];

      vi.mocked(client.render).mockReturnValueOnce(firstRender).mockResolvedValueOnce(successResult);
      vi.mocked(createRuntimeClient).mockReturnValue(client);

      // eslint-disable-next-line @typescript-eslint/naming-convention -- file path key
      const code1 = { 'main.ts': 'v1' };
      // eslint-disable-next-line @typescript-eslint/naming-convention -- file path key
      const code2 = { 'main.ts': 'v2' };

      const { result, rerender } = renderHook(({ code }) => useRender(defaultOptions({ code })), {
        initialProps: { code: code1 },
      });

      rerender({ code: code2 });

      await act(async () => {
        resolveFirst?.({ success: true, data: staleGeometries, issues: [] });
      });

      await waitFor(() => {
        expect(result.current.status).toBe('success');
      });

      expect(result.current.geometries).toEqual(successGeometries);
    });
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('should terminate the client on unmount', () => {
      const client = createConfiguredMockClient();

      const { unmount } = renderHook(() => useRender(defaultOptions()));

      unmount();

      expect(client.terminate).toHaveBeenCalledOnce();
    });

    it('should not update state after unmount', async () => {
      const client = createMockRuntimeClient();

      let resolveRender: ((value: HashedGeometryResult) => void) | undefined;
      vi.mocked(client.render).mockReturnValue(
        new Promise<HashedGeometryResult>((resolve) => {
          resolveRender = resolve;
        }),
      );
      vi.mocked(createRuntimeClient).mockReturnValue(client);

      const { result, unmount } = renderHook(() => useRender(defaultOptions()));

      unmount();

      await act(async () => {
        resolveRender?.(successResult);
      });

      expect(result.current.geometries).toEqual([]);
      expect(result.current.status).not.toBe('success');
    });

    it('should unsubscribe from parametersResolved on unmount', () => {
      const unsubscribe = vi.fn();
      const client = createMockRuntimeClient();
      vi.mocked(client.on).mockReturnValue(unsubscribe);
      vi.mocked(client.render).mockResolvedValue(successResult);
      vi.mocked(createRuntimeClient).mockReturnValue(client);

      const { unmount } = renderHook(() => useRender(defaultOptions()));

      unmount();

      expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('should terminate the old client and create a new one when client options change', () => {
      const client1 = createMockRuntimeClient();
      const client2 = createMockRuntimeClient();
      vi.mocked(client1.render).mockResolvedValue(successResult);
      vi.mocked(client2.render).mockResolvedValue(successResult);

      vi.mocked(createRuntimeClient).mockReturnValueOnce(client1).mockReturnValueOnce(client2);

      const options1 = createRuntimeClientOptions({ kernels: [replicad()] });
      const options2 = createRuntimeClientOptions({ kernels: [replicad()] });

      const { rerender } = renderHook(({ clientOptions }) => useRender(defaultOptions({ clientOptions })), {
        initialProps: { clientOptions: options1 },
      });

      rerender({ clientOptions: options2 });

      expect(client1.terminate).toHaveBeenCalledOnce();
      expect(createRuntimeClient).toHaveBeenCalledTimes(2);
    });
  });

  // ── Return value stability ────────────────────────────────────────────────

  describe('return value stability', () => {
    it('should return a stable geometries reference when geometries have not changed', async () => {
      createConfiguredMockClient();

      const { result, rerender } = renderHook(() => useRender(defaultOptions()));

      await waitFor(() => {
        expect(result.current.status).toBe('success');
      });

      const firstRef = result.current.geometries;

      rerender();

      expect(result.current.geometries).toBe(firstRef);
    });
  });
});
