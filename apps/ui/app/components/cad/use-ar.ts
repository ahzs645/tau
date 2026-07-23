import { useCallback, useState } from 'react';
import type { Geometry } from '@taucad/types';
import { toast } from '#components/ui/sonner.js';
import type { AppRuntimeClient } from '#types/runtime-client.alias.js';

type ArCapability = {
  readonly isQuickLookSupported: boolean;
  readonly canActivateAr: boolean;
  readonly isConverting: boolean;
  readonly activateAr: () => Promise<void>;
};

/**
 * Fallback GLB source for viewers without a runtime kernel client (e.g. the
 * playground). Resolves the current model's GLB bytes, or `undefined` when no
 * model is available yet.
 */
export type GetGlbData = () => Promise<Uint8Array<ArrayBuffer> | undefined>;

/**
 * Detect iOS via user agent (iPhone/iPad/iPod) and iPad masquerading as Mac.
 * Mirrors model-viewer's detection logic from constants.ts.
 */
const isIos =
  (/iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in globalThis)) ||
  // oxlint-disable-next-line @typescript-eslint/no-deprecated -- Required for iPad detection; no standard replacement exists
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isWkWebView = 'webkit' in globalThis;

/**
 * Detect Quick Look support:
 * - Safari: check relList.supports('ar')
 * - WKWebView (Chrome/Edge/Firefox/Google/DuckDuckGo on iOS): check user agent
 */
const isQuickLookSupported: boolean = (() => {
  if (typeof document === 'undefined' || !isIos) {
    return false;
  }

  if (!isWkWebView) {
    const anchor = document.createElement('a');
    return anchor.relList.supports('ar');
  }

  return /CriOS\/|EdgiOS\/|FxiOS\/|GSA\/|DuckDuckGo\//.test(navigator.userAgent);
})();

function launchQuickLook(usdzBlobUrl: string): void {
  const anchor = document.createElement('a');
  anchor.setAttribute('rel', 'ar');
  anchor.setAttribute('href', usdzBlobUrl);
  anchor.setAttribute('download', 'model.usdz');

  // Required by iOS for Quick Look detection
  const img = document.createElement('img');
  anchor.append(img);

  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();

  img.remove();
  anchor.remove();
}

/**
 * Hook providing iOS Quick Look AR capability detection and launch.
 *
 * Returns `canActivateAr: true` only when the device supports Quick Look and a
 * USDZ source is available. Call `activateAr()` from a user click handler to
 * export the model to USDZ and open AR Quick Look.
 *
 * Two export paths, matching whichever the surrounding view provides:
 * - `kernelClient`: the runtime client's worker-side `export('usdz')`
 *   (project views with a live kernel).
 * - `getGlbData`: browser-side GLB → USDZ conversion via `@taucad/converter`
 *   — the same `exportFromGlb` the runtime path wraps — for viewers without a
 *   kernel (playground examples, pre-rendered static models).
 */
export function useAr(
  geometries: readonly Geometry[],
  kernelClient?: AppRuntimeClient,
  getGlbData?: GetGlbData,
): ArCapability {
  const [isConverting, setIsConverting] = useState(false);

  const hasGltfGeometry = geometries.some((g) => g.format === 'gltf');
  const canActivateAr =
    isQuickLookSupported && ((hasGltfGeometry && Boolean(kernelClient)) || getGlbData !== undefined);

  const activateAr = useCallback(async () => {
    if (!canActivateAr) {
      return;
    }

    setIsConverting(true);
    let blobUrl: string | undefined;

    try {
      let usdz: { bytes: Uint8Array<ArrayBuffer>; mimeType: string };

      if (kernelClient) {
        const result = await kernelClient.export('usdz');
        if (!result.success) {
          throw new Error(result.issues[0]?.message ?? 'USDZ export failed');
        }

        usdz = result.data;
      } else {
        const glbData = await getGlbData?.();
        if (!glbData) {
          throw new Error('No model available for AR');
        }

        // Deferred so the Assimp-backed converter only loads on first AR use.
        const { exportFromGlb } = await import('@taucad/converter');
        const files = await exportFromGlb(glbData, 'usdz');
        const file = files[0];
        if (!file) {
          throw new Error('USDZ export produced no output');
        }

        usdz = { bytes: file.bytes, mimeType: file.mimeType };
      }

      blobUrl = URL.createObjectURL(new Blob([usdz.bytes], { type: usdz.mimeType }));

      launchQuickLook(blobUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to launch AR viewer';
      toast.error(message);
    } finally {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }

      setIsConverting(false);
    }
  }, [canActivateAr, kernelClient, getGlbData]);

  return {
    isQuickLookSupported,
    canActivateAr,
    isConverting,
    activateAr,
  };
}
