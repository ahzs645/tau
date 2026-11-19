import { memo, useMemo } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { ModelViewer } from '@taucad/viewer/model-viewer';
import { ViewerControls } from '@taucad/viewer/cad/viewer-controls';
import { GraphicsProvider, useGraphicsSelector } from '@taucad/viewer/hooks/use-graphics';
import { graphicsMachine } from '@taucad/viewer/machines/graphics.machine';
import { defaultGraphicsSettings } from '@taucad/viewer/graphics/graphics-settings';
import { defaultViewerEnvironment, ViewerEnvironmentProvider } from '@taucad/viewer/environment/viewer-environment';
import { Skeleton } from '@taucad/ui/components/skeleton';
import { WaitIndicator } from '@taucad/ui/components/wait-indicator';
import type { GalleryRenderResult } from '#runtime.js';
import { useGalleryTheme } from '#components/theme.jsx';

type MeasuredBounds = { readonly min: readonly number[]; readonly max: readonly number[] };
const isVector = (value: unknown): value is readonly number[] =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((item: unknown) => typeof item === 'number' && Number.isFinite(item));
const isMeasuredBounds = (value: unknown): value is MeasuredBounds =>
  value !== null &&
  typeof value === 'object' &&
  'min' in value &&
  'max' in value &&
  isVector(value.min) &&
  isVector(value.max);

const ModelDimensions = (): React.JSX.Element | undefined => {
  const framing = useGraphicsSelector((snapshot) => snapshot.context.framingRef);
  const units = useGraphicsSelector((snapshot) => snapshot.context.displayUnits.length);
  const bounds = useSelector(framing, (snapshot) => {
    const measured: unknown = 'measuredBounds' in snapshot.context ? snapshot.context.measuredBounds : undefined;
    return isMeasuredBounds(measured) ? measured : undefined;
  });
  if (!bounds) {
    return undefined;
  }
  const format = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
  const dimensions = [0, 1, 2].map((axis) =>
    format.format(((bounds.max[axis] ?? 0) - (bounds.min[axis] ?? 0)) / units.metersPerUnit),
  );
  return (
    <output
      className='rounded-md border bg-background/90 px-2 py-1 font-mono text-xs tabular-nums'
      aria-label='Model dimensions'
    >
      X {dimensions[0]} · Y {dimensions[1]} · Z {dimensions[2]} {units.symbol}
    </output>
  );
};

export const ModelPreview = memo(
  ({
    result,
    sourceFile,
    showLines,
    mobileAction,
    status,
  }: {
    readonly result?: GalleryRenderResult;
    readonly sourceFile?: string;
    readonly showLines?: boolean;
    readonly mobileAction?: React.ReactNode;
    readonly status: string;
  }): React.JSX.Element => {
    const graphicsRef = useActorRef(graphicsMachine, {
      input: {
        enableSurfaces: defaultGraphicsSettings.enableSurfaces,
        enableLines: showLines ?? defaultGraphicsSettings.enableLines,
        enableGizmo: true,
        enableGrid: true,
        enableAxes: true,
        enableMatcap: defaultGraphicsSettings.enableMatcap,
        upDirection: defaultGraphicsSettings.upDirection,
        graphicsBackend: defaultGraphicsSettings.graphicsBackend,
        camera: { cameraFovAngle: defaultGraphicsSettings.cameraFovAngle },
      },
    });
    const { colorScheme } = useGalleryTheme();
    const environment = useMemo(
      () => ({ ...defaultViewerEnvironment, colorScheme, showRenderFps: false }),
      [colorScheme],
    );
    const graphicsOptions = useMemo(() => ({ enableLines: showLines, enableGizmo: true }), [showLines]);
    return (
      <ViewerEnvironmentProvider value={environment}>
        <GraphicsProvider graphicsRef={graphicsRef}>
          <div
            data-viewer-frame
            className='gallery-viewer-frame @container/viewer relative size-full min-h-0 overflow-hidden'
            role='region'
            tabIndex={0}
            aria-label='Interactive model viewer'
            aria-busy={status === 'loading' || status === 'rendering'}
          >
            {result ? (
              <ModelViewer
                artifact={result.artifact}
                artifactHash={result.artifactHash}
                viewerState='ready'
                graphicsRef={graphicsRef}
                sourceFile={sourceFile}
                enablePan
                enableZoom
                graphicsOptions={graphicsOptions}
                className='size-full'
              />
            ) : status === 'error' ? (
              <div
                role='status'
                className='flex size-full items-center justify-center p-8 text-sm text-muted-foreground'
              >
                Model preview unavailable
              </div>
            ) : (
              <div
                role='status'
                aria-label='Preparing model preview'
                aria-busy='true'
                className='flex size-full items-center justify-center p-8'
              >
                <Skeleton aria-hidden className='aspect-square h-1/2 max-w-full rounded-2xl' />
              </div>
            )}
            <div className='pointer-events-none absolute top-3 left-3 z-10 flex max-w-[calc(100%-6rem)] flex-wrap items-center gap-2'>
              <ModelDimensions />
              <WaitIndicator
                active={status === 'loading' || status === 'rendering'}
                label={result ? 'Updating model' : 'Preparing model'}
                slowLabel={result ? 'Still updating model' : 'Still preparing model'}
                variant='pill'
                live={Boolean(result)}
              />
            </div>
            {result ? (
              <div className='pointer-events-none absolute right-3 bottom-3 left-3 z-20 flex flex-col items-center'>
                <ViewerControls navigationKeys enableTouchTargets mobileAction={mobileAction} />
              </div>
            ) : null}
          </div>
        </GraphicsProvider>
      </ViewerEnvironmentProvider>
    );
  },
);
