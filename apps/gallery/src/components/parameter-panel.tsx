import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { RotateCcw, Upload } from 'lucide-react';
import { Parameters } from '@taucad/viewer/parameters/parameters';
import { Button } from '@taucad/ui/components/button';
import { Heading } from '@taucad/ui/components/heading';
import { Skeleton } from '@taucad/ui/components/skeleton';
import type { GalleryComponents, GalleryFiles, GalleryProject, GalleryUpload, GalleryVariant } from '#catalog/types.js';
import type { GalleryRenderResult } from '#runtime.js';
import { resolveGalleryParameters } from '#runtime/parameters.js';
import type { UploadedAsset, UploadedAssets } from '#components/use-gallery-model.js';
import { errorMessage } from '#components/download.js';
import { projectGalleryParameters } from '#components/parameter-presentation.js';

const units: React.ComponentProps<typeof Parameters>['units'] = { length: { displaySymbol: 'mm' } };
const parameterEdit: React.ComponentProps<typeof Parameters>['parameterEdit'] = { kind: 'transient' };

const componentValue = (
  components: GalleryComponents,
  parameters: Record<string, unknown>,
  projected: unknown,
): string => {
  const value = projected ?? parameters[components.parameter];
  return typeof value === 'string' ? value : (components.options[0]?.value ?? '');
};

const imageMimeTypes: Readonly<Record<string, string>> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

const UploadField = memo(
  ({
    slot,
    asset,
    original,
    onUpload,
    onReset,
  }: {
    readonly slot: GalleryUpload;
    readonly asset?: UploadedAsset;
    readonly original?: Uint8Array<ArrayBuffer>;
    readonly onUpload: (slot: GalleryUpload, asset: UploadedAsset) => void;
    readonly onReset: (slot: GalleryUpload) => void;
  }): React.JSX.Element => {
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [previewUrl, setPreviewUrl] = useState<string>();
    const bytes = asset?.bytes ?? original;
    const mimeType = asset?.mimeType.startsWith('image/')
      ? asset.mimeType
      : imageMimeTypes[(asset?.name ?? slot.filePath).split('.').at(-1)?.toLowerCase() ?? ''];
    useEffect(() => {
      if (!bytes || !mimeType) {
        setPreviewUrl(undefined);
        return;
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
      setPreviewUrl(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    }, [bytes, mimeType]);
    const choose = useCallback(
      async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (!file) {
          return;
        }
        setError(undefined);
        const accepted = slot.accept
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean);
        if (
          accepted.length > 0 &&
          !accepted.some((entry) =>
            entry.startsWith('.')
              ? file.name.toLowerCase().endsWith(entry)
              : entry.endsWith('/*')
                ? file.type.startsWith(entry.slice(0, -1))
                : file.type === entry,
          )
        ) {
          setError(`Choose a file matching ${slot.accept}.`);
          return;
        }
        if (file.size > (slot.maxBytes ?? 64 * 1024 * 1024)) {
          setError(`Choose a file smaller than ${Math.round((slot.maxBytes ?? 64 * 1024 * 1024) / 1024 / 1024)} MB.`);
          return;
        }
        setBusy(true);
        try {
          onUpload(slot, {
            name: file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
            mimeType: file.type || 'application/octet-stream',
          });
        } catch (error) {
          setError(errorMessage(error));
        } finally {
          setBusy(false);
        }
      },
      [onUpload, slot],
    );
    const reset = useCallback(() => {
      onReset(slot);
    }, [onReset, slot]);
    return (
      <div className='flex flex-col gap-2 border-t py-3'>
        <span className='text-sm font-medium'>{slot.label}</span>
        {slot.description ? <p className='text-xs text-muted-foreground'>{slot.description}</p> : null}
        <div className='flex flex-wrap items-center gap-2'>
          <label className='relative inline-flex min-h-11 cursor-action items-center gap-2 rounded-md border bg-background px-3 text-sm hover:bg-accent has-[:focus-visible]:focus-outline'>
            <Upload aria-hidden className='size-4' />
            <span>{busy ? 'Reading file…' : asset ? 'Replace file' : 'Choose file'}</span>
            <input
              type='file'
              accept={slot.accept}
              aria-label={slot.label}
              disabled={busy}
              onChange={choose}
              className='absolute inset-0 w-full cursor-action opacity-0'
            />
          </label>
          {asset ? (
            <Button variant='ghost' size='touch' onClick={reset} aria-label={`Reset ${slot.label}`}>
              <RotateCcw aria-hidden />
              Reset
            </Button>
          ) : null}
        </div>
        <p className='text-xs break-all text-muted-foreground'>{asset ? asset.name : `Original: ${slot.filePath}`}</p>
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={`${slot.label} artwork preview`}
            className='h-28 w-full rounded-md border bg-muted/30 object-contain p-2'
          />
        ) : null}
        {error ? (
          <p role='alert' className='text-sm'>
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);

export const ParameterPanel = ({
  project,
  variant,
  parameters,
  result,
  files,
  uploads,
  onChange,
  onReplace,
  onUpload,
  onResetUpload,
}: {
  readonly project: GalleryProject;
  readonly variant?: GalleryVariant;
  readonly parameters: Record<string, unknown>;
  readonly result?: GalleryRenderResult;
  readonly files: GalleryFiles;
  readonly uploads: UploadedAssets;
  readonly onChange: (next: Record<string, unknown>, base: Record<string, unknown>) => void;
  readonly onReplace: (parameters: Record<string, unknown>) => void;
  readonly onUpload: (slot: GalleryUpload, asset: UploadedAsset) => void;
  readonly onResetUpload: (slot: GalleryUpload) => void;
}): React.JSX.Element => {
  const presets = useMemo(
    () => (variant ? project.presets.filter((preset) => preset.variantIds.includes(variant.id)) : []),
    [project.presets, variant],
  );
  const activePreset = useMemo(() => {
    const defaults = result?.defaultParameters ?? {};
    const current = JSON.stringify(resolveGalleryParameters(defaults, parameters));
    return (
      presets.find((preset) => JSON.stringify(resolveGalleryParameters(defaults, preset.parameters)) === current)?.id ??
      ''
    );
  }, [presets, parameters, result?.defaultParameters]);
  const applyPreset = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const preset = presets.find((item) => item.id === event.target.value);
      if (preset) {
        onReplace(preset.parameters);
      }
    },
    [presets, onReplace],
  );
  const reset = useCallback(() => {
    onReplace(variant?.id === project.defaultVariantId ? project.initialParameters : {});
  }, [project, variant, onReplace]);
  const components = variant && project.components?.variantIds.includes(variant.id) ? project.components : undefined;
  const presentation = useMemo(
    () => (result ? projectGalleryParameters(result, parameters, components?.parameter) : undefined),
    [result, parameters, components?.parameter],
  );
  return (
    <aside
      className='gallery-parameters flex min-h-0 min-w-0 flex-col overflow-y-auto border-l bg-background'
      aria-label='Model parameters'
    >
      <div className='flex flex-col gap-3 p-4'>
        <div className='flex items-center justify-between gap-3'>
          <Heading level={2} variant='label'>
            Parameters
          </Heading>
          <Button variant='ghost' size='touch' onClick={reset} aria-label='Reset parameters'>
            <RotateCcw aria-hidden />
            Reset
          </Button>
        </div>
        <p className='text-sm text-muted-foreground'>{project.description}</p>
        {variant?.notes ? <p className='text-xs text-muted-foreground'>{variant.notes}</p> : null}
        {presets.length > 0 ? (
          <label className='flex flex-col gap-1 text-sm'>
            <span>Preset</span>
            <select value={activePreset} onChange={applyPreset} className='gallery-select'>
              <option value='' disabled>
                Custom settings
              </option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {components ? (
          <label className='flex flex-col gap-1 text-sm'>
            <span>{components.label}</span>
            <select
              className='gallery-select'
              aria-label={components.label}
              value={componentValue(components, parameters, presentation?.componentValue)}
              onChange={(event) => {
                onReplace({ ...parameters, [components.parameter]: event.target.value });
              }}
            >
              {components.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {project.uploads.map((slot) => (
          <UploadField
            key={slot.id}
            slot={slot}
            asset={uploads[slot.filePath]}
            original={files[slot.filePath]}
            onUpload={onUpload}
            onReset={onResetUpload}
          />
        ))}
      </div>
      {presentation?.jsonSchema && result?.parameterManifest ? (
        <div className='shrink-0 px-2 pb-4'>
          <Parameters
            parameters={presentation.parameters}
            defaultParameters={presentation.defaultParameters}
            jsonSchema={presentation.jsonSchema}
            onParametersChange={onChange}
            parameterManifest={result.parameterManifest}
            parameterEdit={parameterEdit}
            units={units}
            enableSearch
            isInitialExpanded
            presentation='embedded'
          />
        </div>
      ) : result ? (
        <p className='px-4 pb-6 text-sm text-muted-foreground'>This model has no additional editable parameters.</p>
      ) : (
        <div role='status' aria-label='Loading model parameters' aria-busy='true' className='flex flex-col gap-4 p-4'>
          <Skeleton aria-hidden className='h-10 w-full' />
          <Skeleton aria-hidden className='h-10 w-full' />
          <Skeleton aria-hidden className='h-10 w-full' />
        </div>
      )}
      <div className='mt-auto flex flex-col gap-2 border-t p-4 text-xs text-muted-foreground'>
        {project.author ? <p>By {project.author}</p> : null}
        {project.license ? <p>{project.license}</p> : null}
        <a href={project.sourceUrl} target='_blank' rel='noreferrer' className='underline underline-offset-4'>
          Project source and attribution
        </a>
      </div>
    </aside>
  );
};
