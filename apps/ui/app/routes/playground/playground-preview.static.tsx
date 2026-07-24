import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, ChevronDown } from 'lucide-react';
import { Parameters } from '@taucad/react/parameters';
import type { Geometry } from '@taucad/types';
import { ModelViewer } from '#components/model-viewer.js';
import type { PlaygroundExample, PlaygroundPreset } from '#routes/playground/playground-examples.js';
import type { PlaygroundMobilePane } from '#routes/playground/playground-preview.js';
import { deriveStaticParameterView, parameterUnits } from '#routes/playground/static-parameters.js';
import { Button } from '#components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.js';
import { ClientOnly } from '#components/ui/utils/client-only.js';
import { cn } from '#utils/ui.utils.js';

export const playgroundPreviewCapabilities = {
  parameters: true,
} as const;

type PlaygroundPreviewPaneProps = {
  readonly activeExample: PlaygroundExample;
  readonly files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
  readonly pendingParameters: Record<string, unknown> | undefined;
  readonly previewProjectId: string;
  readonly previewRenderKey: string;
  readonly staticPreviewUrl: string | undefined;
  readonly mobilePane: PlaygroundMobilePane;
  readonly exportControlsElement: HTMLDivElement | undefined;
  readonly onParametersChange: (parameters: Record<string, unknown>) => void;
};

async function loadStaticPreviewGeometry(url: string, signal?: AbortSignal): Promise<Geometry> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load static preview GLB: ${response.status}`);
  }

  return {
    format: 'gltf',
    content: new Uint8Array(await response.arrayBuffer()),
    hash: `static-playground:${url}`,
  };
}

function StaticPlaygroundViewer({
  image,
  staticPreviewUrl,
}: {
  readonly image: string | undefined;
  readonly staticPreviewUrl: string | undefined;
}): React.JSX.Element {
  const [geometry, setGeometry] = useState<Geometry | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    if (!staticPreviewUrl) {
      setGeometry(undefined);
      setError(undefined);
      return;
    }

    const controller = new AbortController();
    setGeometry(undefined);
    setError(undefined);

    // oxlint-disable-next-line tau-lint/no-async-iife -- static preview fetch is the render source.
    void (async () => {
      try {
        setGeometry(await loadStaticPreviewGeometry(staticPreviewUrl, controller.signal));
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        setError(error instanceof Error ? error : new Error('Failed to load static preview'));
      }
    })();

    return () => {
      controller.abort();
    };
  }, [staticPreviewUrl]);

  if (staticPreviewUrl) {
    return (
      <ModelViewer
        className='size-full'
        enablePan
        enableZoom
        geometries={geometry ? [geometry] : []}
        error={error}
        stageOptions={{ zoomLevel: 1.25 }}
        graphicsOptions={{
          enableLines: true,
          viewerClassName: 'bg-muted/30',
        }}
      />
    );
  }

  if (image) {
    return <img src={image} alt='' loading='eager' decoding='async' className='size-full object-contain' />;
  }

  return (
    <div className='flex size-full items-center justify-center'>
      <Box className='size-12 text-muted-foreground/40' strokeWidth={1.25} aria-hidden />
    </div>
  );
}

export function PlaygroundPreviewPane({
  activeExample,
  staticPreviewUrl,
  pendingParameters,
  mobilePane,
  onParametersChange,
}: PlaygroundPreviewPaneProps): React.JSX.Element {
  return (
    <>
      <section
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col',
          activeExample.mode !== 'static' && mobilePane !== '3d' ? 'max-xl:hidden' : undefined,
        )}
      >
        <div className='relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/30'>
          <ClientOnly fallback={<StaticPlaygroundViewer image={activeExample.image} staticPreviewUrl={undefined} />}>
            <StaticPlaygroundViewer image={activeExample.image} staticPreviewUrl={staticPreviewUrl} />
          </ClientOnly>
        </div>
      </section>

      {activeExample.mode === 'static' ? null : (
        <section
          className={cn(
            'flex min-w-0 flex-col bg-background xl:min-h-0',
            mobilePane === 'params' ? 'max-xl:min-h-0 max-xl:flex-1 max-xl:overflow-y-auto' : 'max-xl:hidden',
          )}
        >
          <StaticPlaygroundParameters
            activeExample={activeExample}
            pendingParameters={pendingParameters}
            onParametersChange={onParametersChange}
          />
        </section>
      )}
    </>
  );
}

function StaticPlaygroundParameters({
  activeExample,
  pendingParameters,
  onParametersChange,
}: {
  readonly activeExample: PlaygroundExample;
  readonly pendingParameters: Record<string, unknown> | undefined;
  readonly onParametersChange: (parameters: Record<string, unknown>) => void;
}): React.JSX.Element {
  const parameterView = useMemo(() => deriveStaticParameterView(activeExample), [activeExample]);
  const [parameters, setParameters] = useState<Record<string, unknown>>({});

  useEffect(() => {
    const nextModelParameters = parameterView.toModelParameters(pendingParameters ?? {});
    setParameters(parameterView.toUiParameters(nextModelParameters));
    onParametersChange(nextModelParameters);
  }, [activeExample.id, onParametersChange, parameterView, pendingParameters]);

  const handleParametersChange = useCallback(
    (nextParameters: Record<string, unknown>) => {
      setParameters(nextParameters);
      onParametersChange(parameterView.toModelParameters(nextParameters));
    },
    [onParametersChange, parameterView],
  );

  const applyPreset = useCallback(
    (preset: PlaygroundPreset) => {
      handleParametersChange(preset.parameters);
    },
    [handleParametersChange],
  );

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='flex items-center justify-between border-b p-2'>
        <h3 className='text-sm font-semibold'>Parameters</h3>
        {parameterView.presets.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant='ghost' size='xs' className='gap-1'>
                Presets
                <ChevronDown className='size-3.5' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end'>
              {parameterView.presets.map((preset) => (
                <DropdownMenuItem
                  key={preset.name}
                  onSelect={() => {
                    applyPreset(preset);
                  }}
                >
                  {preset.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div className='flex-1 overflow-hidden'>
        <ClientOnly fallback={<div data-slot='parameters' className='h-full w-full' />}>
          <Parameters
            parameters={parameters}
            defaultParameters={parameterView.defaultParameters}
            jsonSchema={parameterView.jsonSchema}
            units={parameterUnits}
            emptyDescription='This model has no parameters'
            onParametersChange={handleParametersChange}
          />
        </ClientOnly>
      </div>
    </div>
  );
}
