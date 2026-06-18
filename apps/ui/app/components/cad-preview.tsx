import { memo, useEffect, useMemo, useState } from 'react';
import type { Geometry } from '@taucad/types';
import { ModelViewer, RenderStatusOverlay } from '#components/model-viewer.js';
import type { ModelViewerGraphicsOptions } from '#components/model-viewer.js';
import { useCadPreview } from '#hooks/use-cad-preview.js';
import type { StageOptions } from '#components/geometry/graphics/three/stage.js';

/**
 * Visual rendering settings for the CAD preview viewer.
 * Alias for `ModelViewerGraphicsOptions` for backward compatibility.
 */
export type CadPreviewGraphicsOptions = ModelViewerGraphicsOptions;

type CadPreviewViewerProps = {
  readonly className?: string;
  readonly enablePan?: boolean;
  readonly enableZoom?: boolean;
  readonly stageOptions?: StageOptions;
  readonly graphicsOptions?: CadPreviewGraphicsOptions;
  readonly staticPreviewUrl?: string;
};

export async function loadStaticPreviewGeometry(url: string, signal?: AbortSignal): Promise<Geometry> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load static preview GLB: ${response.status}`);
  }

  const content = new Uint8Array(await response.arrayBuffer());
  return {
    format: 'gltf',
    content,
    hash: `static-preview:${url}`,
  };
}

/**
 * Thin adapter over `ModelViewer` that reads from `CadPreviewProvider` context.
 *
 * Must be rendered inside a `CadPreviewProvider`.
 *
 * @example
 * ```tsx
 * <CadPreviewProvider projectId="my-build" mainFile="main.ts" files={files}>
 *   <CadPreviewViewer
 *     className="size-full"
 *     enablePan
 *     enableZoom
 *     graphicsOptions={{ enableLines: false, viewerClassName: 'bg-muted' }}
 *   />
 * </CadPreviewProvider>
 * ```
 */
export const CadPreviewViewer = memo(function CadPreviewViewer({
  className,
  enablePan,
  enableZoom,
  stageOptions,
  graphicsOptions,
  staticPreviewUrl,
}: CadPreviewViewerProps): React.JSX.Element {
  const { geometries, graphicsRef, status, error } = useCadPreview();
  const [staticPreviewGeometry, setStaticPreviewGeometry] = useState<Geometry | undefined>(undefined);

  useEffect(() => {
    if (!staticPreviewUrl) {
      setStaticPreviewGeometry(undefined);
      return;
    }

    const controller = new AbortController();

    // oxlint-disable-next-line tau-lint/no-async-iife -- static preview fetch is a best-effort first paint.
    void (async () => {
      try {
        setStaticPreviewGeometry(await loadStaticPreviewGeometry(staticPreviewUrl, controller.signal));
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        setStaticPreviewGeometry(undefined);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [staticPreviewUrl]);

  const displayGeometries = useMemo(() => {
    if (geometries.length > 0) {
      return geometries;
    }

    if (status === 'error' || !staticPreviewGeometry) {
      return [];
    }

    return [staticPreviewGeometry];
  }, [geometries, status, staticPreviewGeometry]);

  return (
    <ModelViewer
      geometries={displayGeometries}
      graphicsRef={graphicsRef}
      className={className}
      enablePan={enablePan}
      enableZoom={enableZoom}
      stageOptions={stageOptions}
      graphicsOptions={graphicsOptions}
      error={status === 'error' ? (error ?? new Error('Failed to render preview')) : error}
    />
  );
});

type CadPreviewStatusProps = {
  readonly className?: string;
};

/**
 * Rendering status overlay that shows the current CAD machine phase.
 * Reads from `CadPreviewProvider` context.
 *
 * Renders nothing when not in a loading/rendering state.
 */
export function CadPreviewStatus({ className }: CadPreviewStatusProps): React.ReactNode {
  const { status } = useCadPreview();

  return <RenderStatusOverlay status={status === 'loading' ? 'loading' : 'idle'} className={className} />;
}
