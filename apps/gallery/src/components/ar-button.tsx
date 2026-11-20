import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, LoaderCircle } from 'lucide-react';
import { Button } from '@taucad/ui/components/button';
import type { Artifact } from '@taucad/runtime';
import { errorMessage } from '#components/download.js';

/** Apple Quick Look is offered only when the browser reports support for its AR link contract. */
export const ArButton = ({
  artifact,
  hash,
  isDisabled,
  onError,
}: {
  readonly artifact: Artifact;
  readonly hash: string;
  readonly isDisabled: boolean;
  readonly onError: (message: string) => void;
}): React.JSX.Element | undefined => {
  const [supported] = useState(() => {
    const anchor = document.createElement('a');
    if (anchor.relList.supports('ar')) {
      return true;
    }
    // IOS browser shells use Quick Look even where WKWebView does not expose relList.supports.
    const iosBrowser = /CriOS\/|EdgiOS\/|FxiOS\/|GSA\/|DuckDuckGo\//u.test(navigator.userAgent);
    return (
      'webkit' in globalThis &&
      iosBrowser &&
      (/iPad|iPhone|iPod/u.test(navigator.userAgent) || navigator.maxTouchPoints > 1)
    );
  });
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const canLaunch = useRef(!isDisabled);
  const prepared = useRef<{ readonly hash: string; readonly url: string } | undefined>(undefined);
  useEffect(() => {
    canLaunch.current = !isDisabled;
  }, [isDisabled]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (prepared.current) {
        URL.revokeObjectURL(prepared.current.url);
      }
      prepared.current = undefined;
    };
  }, []);
  const activate = useCallback(async () => {
    setBusy(true);
    try {
      if (artifact.mimeType !== 'model/gltf-binary' || typeof artifact.content === 'string') {
        throw new Error('AR requires a binary 3D model.');
      }
      if (prepared.current?.hash !== hash) {
        const [gltfLoaderModule, usdzExporterModule] = await Promise.all([
          import('three/addons/loaders/GLTFLoader.js'),
          import('three/addons/exporters/USDZExporter.js'),
        ]);
        const gltf = await new gltfLoaderModule.GLTFLoader().parseAsync(new Uint8Array(artifact.content).buffer, '');
        const bytes = await new usdzExporterModule.USDZExporter().parseAsync(gltf.scene);
        if (!mounted.current || !canLaunch.current) {
          return;
        }
        if (prepared.current) {
          URL.revokeObjectURL(prepared.current.url);
        }
        prepared.current = {
          hash,
          url: URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'model/vnd.usdz+zip' })),
        };
      }
      const anchor = document.createElement('a');
      anchor.rel = 'ar';
      anchor.download = 'model.usdz';
      anchor.href = `${prepared.current.url}#allowsContentScaling=0`;
      // Quick Look requires the AR anchor's first child to be an image element.
      anchor.append(document.createElement('img'));
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      if (mounted.current) {
        onError(`AR preview could not open. ${errorMessage(error)}`);
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
      }
    }
  }, [artifact, hash, onError]);
  if (!supported || artifact.mimeType !== 'model/gltf-binary' || typeof artifact.content === 'string') {
    return undefined;
  }
  return (
    <Button
      variant='ghost'
      size='icon-touch'
      disabled={busy || isDisabled}
      onClick={activate}
      aria-label='View model in AR'
      title='View in AR'
    >
      {busy ? <LoaderCircle aria-hidden className='animate-spin' /> : <Box aria-hidden />}
    </Button>
  );
};
