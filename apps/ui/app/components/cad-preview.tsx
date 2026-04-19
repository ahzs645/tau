import { memo } from 'react';
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
};

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
}: CadPreviewViewerProps): React.JSX.Element {
  const { geometries, graphicsRef, status, error } = useCadPreview();

  return (
    <ModelViewer
      geometries={geometries}
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
