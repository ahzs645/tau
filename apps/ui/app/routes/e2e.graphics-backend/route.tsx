import type { Route } from './+types/route.js';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useActorRef } from '@xstate/react';
import type { Geometry } from '@taucad/types';
import type { Handle } from '#types/matches.types.js';
import { CadViewer } from '#components/geometry/cad/cad-viewer.js';
import { GraphicsProvider } from '#hooks/use-graphics.js';
import { ClientOnly } from '#components/ui/utils/client-only.js';
import { Loader } from '#components/ui/loader.js';
import { defaultGraphicsSettings } from '#constants/editor.constants.js';
import { graphicsMachine } from '#machines/graphics.machine.js';

export const handle: Handle = {
  enablePageWrapper: false,
};

/** Playwright parity harness: `/e2e/graphics-backend?scene=&graphicsBackend=` */
export default function GraphicsBackendEndToEndRoute(_route: Route.ComponentProps): React.JSX.Element {
  const [geometry, setGeometry] = useState<Geometry[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function loadHarnessFixture(): Promise<void> {
      try {
        const response = await fetch('/e2e-graphics/box.glb');
        if (!response.ok) {
          return;
        }

        const buffer = await response.arrayBuffer();
        if (cancelled) {
          return;
        }

        setGeometry([
          {
            format: 'gltf',
            hash: 'e2e-box',
            content: new Uint8Array(buffer),
          },
        ]);
      } catch {
        // Fixture load is optional in unsupported environments.
      }
    }

    void loadHarnessFixture();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className='flex min-h-dvh items-center justify-center bg-background p-4'>
      <ClientOnly
        fallback={
          <div
            aria-busy='true'
            aria-label='E2e graphics harness loading'
            className='flex size-128 items-center justify-center border border-border'
          >
            <Loader className='size-10' />
          </div>
        }
      >
        {geometry === undefined ? (
          <div
            aria-busy='true'
            aria-label='E2e graphics harness fetching fixture'
            className='flex size-128 items-center justify-center border border-border'
          >
            <Loader className='size-10' />
          </div>
        ) : (
          <GraphicsHarnessWithParams geometries={geometry} />
        )}
      </ClientOnly>
    </div>
  );
}

/**
 * Exported for exhaustive-deps stability in the route module only.
 *
 * @internal
 */
const GraphicsHarnessWithParams = ({ geometries }: { readonly geometries: Geometry[] }): React.JSX.Element => {
  const [searchParams] = useSearchParams();

  const scene = searchParams.get('scene') ?? 'default';

  const enableAo = scene === 'ao';
  const enableSurfaces = scene !== 'edges-only';
  const enableLines = scene !== 'surface-only';

  const graphicsRef = useActorRef(graphicsMachine, {
    input: {
      defaultCameraFovAngle: defaultGraphicsSettings.cameraFovAngle,
      measureSnapDistance: 40,
      enableSurfaces,
      enableLines,
      enableGizmo: true,
      enableGrid: defaultGraphicsSettings.enableGrid,
      enableAxes: defaultGraphicsSettings.enableAxes,
      enableMatcap: defaultGraphicsSettings.enableMatcap,
      enablePostProcessing: enableAo,
      upDirection: defaultGraphicsSettings.upDirection,
      environmentPreset: defaultGraphicsSettings.environmentPreset,
      graphicsBackendPreference: defaultGraphicsSettings.graphicsBackend ?? 'auto',
    },
  });

  const gridZoom = searchParams.get('gridZoom') ?? '';

  useEffect(() => {
    graphicsRef.send({ type: 'updateGeometries', geometries, units: { length: 'mm' } });
  }, [geometries, graphicsRef]);

  useEffect(() => {
    graphicsRef.send({ type: 'setPostProcessingVisibility', payload: enableAo });
  }, [enableAo, graphicsRef]);

  useEffect(() => {
    let fovDegrees = defaultGraphicsSettings.cameraFovAngle;
    switch (gridZoom) {
      case '1': {
        fovDegrees = 75;
        break;
      }

      case '2': {
        fovDegrees = 50;
        break;
      }

      case '3': {
        fovDegrees = 25;
        break;
      }

      default: {
        break;
      }
    }

    if (scene === 'grid' || gridZoom !== '') {
      graphicsRef.send({ type: 'setFovAngle', payload: fovDegrees });
      graphicsRef.send({ type: 'resetCamera', options: { enableConfiguredAngles: false } });
    }
  }, [gridZoom, graphicsRef, scene]);

  useEffect(() => {
    if (scene !== 'section') {
      return;
    }

    graphicsRef.send({ type: 'selectSectionView', payload: 'xz' });
    graphicsRef.send({ type: 'setSectionViewTranslation', payload: -0.25 });
    graphicsRef.send({ type: 'setSectionViewActive', payload: true });
  }, [graphicsRef, scene]);

  useEffect(() => {
    return () => {
      graphicsRef.send({ type: 'setSectionViewActive', payload: false });
    };
  }, [graphicsRef]);

  return (
    <div
      className='size-128 border border-border bg-background'
      data-e2e-graphics-route={scene === 'grid' ? `grid-zoom-${gridZoom || 'unset'}` : scene}
      data-e2e-graphics-ready={geometries.length === 1 ? 'true' : 'false'}
      data-testid='e2e-graphics-host'
    >
      <GraphicsProvider graphicsRef={graphicsRef}>
        <CadViewer
          className='size-full'
          geometries={geometries}
          enableGizmo
          enableGrid
          enableAxes
          enablePan
          enableZoom
          enableSurfaces={enableSurfaces}
          enableLines={enableLines}
        />
      </GraphicsProvider>
    </div>
  );
};
