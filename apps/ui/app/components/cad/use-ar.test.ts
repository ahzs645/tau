// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Geometry } from '@taucad/types';
import type { useAr as UseAr } from '#components/cad/use-ar.js';

const converterMocks = vi.hoisted(() => ({
  exportFromGlb: vi.fn(async () => [
    { name: 'model.usdz', bytes: new Uint8Array([80, 75, 3, 4]), mimeType: 'model/vnd.usdz+zip' },
  ]),
}));

vi.mock('@taucad/converter', () => ({
  exportFromGlb: converterMocks.exportFromGlb,
}));

const toastMocks = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('#components/ui/sonner.js', () => ({
  toast: toastMocks,
}));

const iosUserAgent =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1';

const originalUserAgent = navigator.userAgent;

/**
 * Quick Look support is detected at module scope, so the iOS environment must
 * be in place before the module loads. Returns a fresh instance of the hook.
 */
async function loadUseAr({ ios }: { readonly ios: boolean }): Promise<typeof UseAr> {
  vi.resetModules();

  if (ios) {
    Object.defineProperty(navigator, 'userAgent', { value: iosUserAgent, configurable: true });
    vi.stubGlobal('webkit', {});
  }

  const module = await import('#components/cad/use-ar.js');
  return module.useAr;
}

function gltfGeometry(bytes: Uint8Array<ArrayBuffer>): Geometry {
  return { format: 'gltf', content: bytes, hash: 'test-hash' } as unknown as Geometry;
}

beforeEach(() => {
  converterMocks.exportFromGlb.mockClear();
  toastMocks.error.mockClear();
  // Object-URL support is missing in jsdom; patch just the static methods.
  URL.createObjectURL = vi.fn(() => 'blob:mock-usdz');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'userAgent', { value: originalUserAgent, configurable: true });
});

describe('useAr', () => {
  it('cannot activate AR without Quick Look support', async () => {
    const useAr = await loadUseAr({ ios: false });
    const { result } = renderHook(() => useAr([], undefined, async () => new Uint8Array([1])));
    expect(result.current.canActivateAr).toBe(false);
  });

  it('can activate AR from a GLB source without a kernel client', async () => {
    const useAr = await loadUseAr({ ios: true });
    const { result } = renderHook(() => useAr([], undefined, async () => new Uint8Array([1, 2, 3])));
    expect(result.current.canActivateAr).toBe(true);
  });

  it('converts the GLB to USDZ in the browser and launches Quick Look', async () => {
    const useAr = await loadUseAr({ ios: true });
    const glb = new Uint8Array([1, 2, 3]);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const { result } = renderHook(() => useAr([], undefined, async () => glb));
    await act(async () => {
      await result.current.activateAr();
    });

    expect(converterMocks.exportFromGlb).toHaveBeenCalledWith(glb, 'usdz');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(toastMocks.error).not.toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('prefers the kernel client export when one is available', async () => {
    const useAr = await loadUseAr({ ios: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const kernelExport = vi.fn(async () => ({
      success: true,
      data: { name: 'model.usdz', bytes: new Uint8Array([9]), mimeType: 'model/vnd.usdz+zip' },
      issues: [],
    }));
    const kernelClient = { export: kernelExport } as unknown as Parameters<typeof useAr>[1];

    const { result } = renderHook(() =>
      useAr([gltfGeometry(new Uint8Array([1]))], kernelClient, async () => new Uint8Array([1])),
    );
    await act(async () => {
      await result.current.activateAr();
    });

    expect(kernelExport).toHaveBeenCalledWith('usdz');
    expect(converterMocks.exportFromGlb).not.toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
  });

  it('surfaces an error toast when no GLB is available', async () => {
    const useAr = await loadUseAr({ ios: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const { result } = renderHook(() => useAr([], undefined, async () => undefined));
    await act(async () => {
      await result.current.activateAr();
    });

    expect(toastMocks.error).toHaveBeenCalledWith('No model available for AR');
    expect(clickSpy).not.toHaveBeenCalled();
    clickSpy.mockRestore();
  });
});
