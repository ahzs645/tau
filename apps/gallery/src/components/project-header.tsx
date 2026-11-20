import { memo, useCallback } from 'react';
import { Download, LayoutGrid } from 'lucide-react';
import { Button } from '@taucad/ui/components/button';
import { Heading } from '@taucad/ui/components/heading';
import type {
  GalleryExportFormat,
  GalleryFiles,
  GalleryProject,
  GalleryVariant,
  GalleryVariantId,
} from '#catalog/types.js';
import { navigate } from '#sharing/location.js';
import { ShareDialog } from '#components/share-dialog.jsx';
import { SourceDialog } from '#components/source-dialog.jsx';
import { ThemeToggle } from '#components/theme.jsx';

export const ProjectHeader = memo(
  ({
    project,
    variant,
    variantId,
    files,
    shareUrl,
    hasUploads,
    formats,
    selectedFormat,
    isBusy,
    isExporting,
    isReady,
    onFormatChange,
    onExport,
    onSwitchVariant,
  }: {
    readonly project: GalleryProject;
    readonly variant?: GalleryVariant;
    readonly variantId: string;
    readonly files: GalleryFiles;
    readonly shareUrl: string;
    readonly hasUploads: boolean;
    readonly formats: readonly GalleryExportFormat[];
    readonly selectedFormat?: GalleryExportFormat;
    readonly isBusy: boolean;
    readonly isExporting: boolean;
    readonly isReady: boolean;
    readonly onFormatChange: (format: string) => void;
    readonly onExport: () => Promise<void>;
    readonly onSwitchVariant: (variant: GalleryVariantId) => void;
  }): React.JSX.Element => {
    const isScad = variant?.kernel === 'openscad' || variant?.kernel === 'openrscad';
    const backToGallery = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      navigate('/');
    }, []);
    const changeFormat = useCallback(
      (event: React.ChangeEvent<HTMLSelectElement>) => {
        onFormatChange(event.target.value);
      },
      [onFormatChange],
    );
    const switchVariant = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        const variant = project.variants.find((item) => item.id === event.currentTarget.dataset['variant']);
        if (variant) {
          onSwitchVariant(variant.id);
        }
      },
      [project.variants, onSwitchVariant],
    );
    return (
      <header className='flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3'>
        <div className='flex min-w-0 flex-1 items-center gap-3'>
          <Button asChild variant='outline' size='icon-touch'>
            <a href='/' onClick={backToGallery} aria-label='Back to gallery'>
              <LayoutGrid aria-hidden />
            </a>
          </Button>
          <Heading level={1} variant='item' className='min-w-0'>
            {project.title}
          </Heading>
        </div>
        <div className='flex max-w-full flex-wrap items-center gap-2'>
          <ThemeToggle />
          <SourceDialog project={project} entry={variant?.entry} currentFiles={files} />
          <ShareDialog title={project.title} url={shareUrl} hasUploads={hasUploads} />
        </div>
        <div className='flex w-full flex-wrap items-center justify-between gap-2'>
          {project.variants.length > 1 ? (
            <div role='group' aria-label='Kernel variant' className='flex max-w-full flex-wrap gap-1'>
              {project.variants.map((item) => (
                <Button
                  key={item.id}
                  data-variant={item.id}
                  variant={item.id === variantId ? 'secondary' : 'ghost'}
                  size='touch'
                  aria-pressed={item.id === variantId}
                  onClick={switchVariant}
                >
                  <span className='sm:hidden'>{item.shortLabel}</span>
                  <span className='max-sm:hidden'>{item.label}</span>
                </Button>
              ))}
            </div>
          ) : (
            <span className='text-xs text-muted-foreground'>{variant?.label ?? '3D model'}</span>
          )}
          <div className='flex items-center gap-2'>
            <label className='sr-only' htmlFor='gallery-export-format'>
              Export format
            </label>
            <select
              id='gallery-export-format'
              value={selectedFormat ?? ''}
              onChange={changeFormat}
              className='gallery-select font-mono'
              disabled={formats.length === 0 || isBusy || isExporting}
            >
              {formats.length > 0 ? (
                formats.map((format) => (
                  <option key={format} value={format}>
                    {format === 'step' && isScad ? 'STEP (faceted)' : format.toUpperCase()}
                  </option>
                ))
              ) : (
                <option value=''>Format</option>
              )}
            </select>
            <Button size='touch' onClick={onExport} disabled={!isReady || isExporting || !selectedFormat}>
              <Download aria-hidden />
              {isExporting ? 'Exporting…' : 'Export'}
            </Button>
          </div>
        </div>
      </header>
    );
  },
);
