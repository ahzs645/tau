import { useCallback, useMemo, useRef, useState } from 'react';
import { Button } from '@taucad/ui/components/button';
import { cn } from '@taucad/ui/utils/cn';
import type { GalleryProject, GalleryUpload, GalleryVariantId } from '#catalog/types.js';
import type { GalleryLocation } from '#sharing/location.js';
import { modelUrl, navigate, readGalleryLocation } from '#sharing/location.js';
import { resolveGalleryParameters } from '#runtime/parameters.js';
import { ParameterPanel } from '#components/parameter-panel.jsx';
import { mergeGalleryParameterChanges } from '#components/parameter-conditions.js';
import { ModelPreview } from '#components/model-preview.jsx';
import { ProjectHeader } from '#components/project-header.jsx';
import { ProjectAlerts } from '#components/project-alerts.jsx';
import { ArButton } from '#components/ar-button.jsx';
import { useGalleryModel } from '#components/use-gallery-model.js';
import type { UploadedAsset, UploadedAssets } from '#components/use-gallery-model.js';
import { downloadBytes, errorMessage } from '#components/download.js';

const noUploads: UploadedAssets = {};
const emptyParameters: Record<string, unknown> = {};

export const ProjectPage = ({
  project,
  route,
  href,
}: {
  readonly project: GalleryProject;
  readonly route: GalleryLocation;
  readonly href: string;
}): React.JSX.Element => {
  const variant =
    project.variants.find((item) => item.id === route.variantId) ??
    project.variants.find((item) => item.id === project.defaultVariantId) ??
    project.variants[0];
  const variantId = variant?.id ?? 'static';
  const identity = `${project.id}:${variantId}`;
  const parameters = useMemo(
    () =>
      route.hasParameters && !route.parameterError
        ? route.parameters
        : variantId === project.defaultVariantId
          ? project.initialParameters
          : emptyParameters,
    [variantId, project, route.parameters, route.hasParameters, route.parameterError],
  );
  const rememberedParameters = useRef(new Map<string, Record<string, unknown>>());
  const [uploadsByVariant, setUploadsByVariant] = useState<Readonly<Record<string, UploadedAssets>>>({});
  const uploads = uploadsByVariant[variantId] ?? noUploads;
  const [mobilePane, setMobilePane] = useState<'3d' | 'parameters'>('3d');
  const [retry, setRetry] = useState(0);
  const [operationError, setOperationError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [format, setFormat] = useState('stl');
  const model = useGalleryModel({
    project,
    variant,
    parameters,
    uploads,
    operationTimeout: variant?.renderTimeout ?? 120_000,
    retry,
  });
  const formats = useMemo(() => {
    const advertised = model.result?.formats ?? [];
    return advertised.filter((item) => !variant || variant.exportFormats.includes(item));
  }, [model.result?.formats, variant]);
  const selectedFormat = formats.find((item) => item === format) ?? formats[0];

  const replaceParameters = useCallback(
    (next: Record<string, unknown>) => {
      rememberedParameters.current.set(variantId, next);
      const url = modelUrl(project.id, {
        base: new URL(globalThis.location.href),
        variantId: variantId !== project.defaultVariantId && variantId !== 'static' ? variantId : undefined,
        parameters: next,
      });
      navigate(url, true);
    },
    [project, variantId],
  );

  const changeParameters = useCallback(
    (next: Record<string, unknown>, base: Record<string, unknown>) => {
      const latest = readGalleryLocation(new URL(globalThis.location.href));
      const current =
        latest.hasParameters && !latest.parameterError
          ? latest.parameters
          : variantId === project.defaultVariantId
            ? project.initialParameters
            : emptyParameters;
      const canonical = model.result ? resolveGalleryParameters(model.result.defaultParameters, current) : current;
      replaceParameters(
        mergeGalleryParameterChanges(
          { defaultParameters: model.result?.defaultParameters ?? {}, jsonSchema: model.result?.jsonSchema },
          canonical,
          { next, base },
        ),
      );
    },
    [project, variantId, replaceParameters, model.result],
  );

  const switchVariant = useCallback(
    (nextVariant: GalleryVariantId) => {
      rememberedParameters.current.set(variantId, parameters);
      const next =
        rememberedParameters.current.get(nextVariant) ??
        (nextVariant === project.defaultVariantId ? project.initialParameters : emptyParameters);
      navigate(
        modelUrl(project.id, {
          base: new URL(globalThis.location.href),
          variantId: nextVariant === project.defaultVariantId ? undefined : nextVariant,
          parameters: next,
        }),
      );
      setOperationError(undefined);
    },
    [project, variantId, parameters],
  );

  const upload = useCallback(
    (slot: GalleryUpload, asset: UploadedAsset) => {
      setUploadsByVariant((previous) => ({
        ...previous,
        [variantId]: { ...previous[variantId], [slot.filePath]: asset },
      }));
      if (slot.parameter) {
        replaceParameters({ ...parameters, [slot.parameter]: slot.filePath });
      }
    },
    [variantId, parameters, replaceParameters],
  );
  const resetUpload = useCallback(
    (slot: GalleryUpload) => {
      setUploadsByVariant((previous) => {
        const next = Object.fromEntries(
          Object.entries(previous[variantId] ?? noUploads).filter(([path]) => path !== slot.filePath),
        );
        return { ...previous, [variantId]: next };
      });
      if (slot.parameter) {
        const next = new Map(Object.entries(parameters));
        const original = project.initialParameters[slot.parameter] ?? model.result?.defaultParameters[slot.parameter];
        if (original === undefined) {
          next.delete(slot.parameter);
        } else {
          next.set(slot.parameter, original);
        }
        replaceParameters(Object.fromEntries(next));
      }
    },
    [variantId, parameters, project, model.result?.defaultParameters, replaceParameters],
  );

  const exportModel = useCallback(async () => {
    if (!selectedFormat || model.status !== 'ready' || !model.result) {
      return;
    }
    setExporting(true);
    setOperationError(undefined);
    try {
      if (model.session) {
        const files = await model.session.export(selectedFormat);
        for (const file of files) {
          downloadBytes(file);
        }
      } else {
        if (
          model.result.artifact.mimeType !== 'model/gltf-binary' ||
          typeof model.result.artifact.content === 'string'
        ) {
          throw new Error('This preview does not contain a downloadable GLB.');
        }
        downloadBytes({
          name: `${project.id}.glb`,
          bytes: new Uint8Array(model.result.artifact.content),
          mimeType: 'model/gltf-binary',
        });
      }
    } catch (error) {
      setOperationError(`The model could not be exported. ${errorMessage(error)}`);
    } finally {
      setExporting(false);
    }
  }, [model, selectedFormat, project.id]);
  const retryRender = useCallback(() => {
    setRetry((value) => value + 1);
    setOperationError(undefined);
  }, []);
  const shareUrl = useMemo(
    () =>
      modelUrl(project.id, {
        base: new URL(href),
        variantId: variantId !== project.defaultVariantId && variantId !== 'static' ? variantId : undefined,
        parameters,
      }).href,
    [project, variantId, parameters, href],
  );
  const arAction = useMemo(
    () =>
      model.result ? (
        <ArButton
          key={model.result.artifactHash}
          artifact={model.result.artifact}
          hash={model.result.artifactHash}
          isDisabled={model.status !== 'ready'}
          onError={setOperationError}
        />
      ) : undefined,
    [model.result, model.status],
  );
  const hasParameterPane = project.mode === 'parametric';
  const hasUnknownVariant = Boolean(route.variantId && !project.variants.some((item) => item.id === route.variantId));
  const resetParameters = useCallback(() => {
    replaceParameters(variantId === project.defaultVariantId ? project.initialParameters : {});
  }, [project, variantId, replaceParameters]);
  return (
    <main className='gallery-project flex h-dvh flex-col overflow-hidden bg-background text-foreground'>
      <ProjectHeader
        project={project}
        variant={variant}
        variantId={variantId}
        files={model.files}
        shareUrl={shareUrl}
        hasUploads={Object.keys(uploads).length > 0}
        formats={formats}
        selectedFormat={selectedFormat}
        isBusy={model.busy}
        isExporting={exporting}
        isReady={model.status === 'ready'}
        onFormatChange={setFormat}
        onExport={exportModel}
        onSwitchVariant={switchVariant}
      />
      <ProjectAlerts
        parameterError={route.parameterError}
        hasUnknownVariant={hasUnknownVariant}
        modelError={model.error}
        operationError={operationError}
        hasPreview={Boolean(model.result)}
        onReset={resetParameters}
        onRetry={retryRender}
      />
      <div className={cn('gallery-workspace min-h-0 flex-1', hasParameterPane && 'gallery-workspace-with-parameters')}>
        <section
          aria-label='3D view'
          className={cn(
            'gallery-preview relative min-h-0 min-w-0',
            hasParameterPane && mobilePane === 'parameters' && 'gallery-mobile-hidden',
          )}
        >
          <ModelPreview
            key={identity}
            result={model.result}
            sourceFile={variant?.entry}
            showLines={variant?.showPreviewLines}
            status={model.status}
            mobileAction={arAction}
          />
        </section>
        {hasParameterPane ? (
          <div className={cn('gallery-parameter-host min-h-0 min-w-0', mobilePane === '3d' && 'gallery-mobile-hidden')}>
            <ParameterPanel
              project={project}
              variant={variant}
              parameters={parameters}
              result={model.result}
              files={model.files}
              uploads={uploads}
              onChange={changeParameters}
              onReplace={replaceParameters}
              onUpload={upload}
              onResetUpload={resetUpload}
            />
          </div>
        ) : null}
      </div>
      {hasParameterPane ? (
        <nav
          aria-label='Model panels'
          className='gallery-mobile-panels shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)]'
        >
          <Button
            variant='ghost'
            size='touch'
            className='flex-1 rounded-none'
            aria-pressed={mobilePane === '3d'}
            onClick={() => {
              setMobilePane('3d');
            }}
          >
            3D view
          </Button>
          <Button
            variant='ghost'
            size='touch'
            className='flex-1 rounded-none'
            aria-pressed={mobilePane === 'parameters'}
            onClick={() => {
              setMobilePane('parameters');
            }}
          >
            Parameters
          </Button>
        </nav>
      ) : null}
    </main>
  );
};
