import { useCallback } from 'react';
import type { FileExtension } from '@taucad/types';
import { Button } from '#components/ui/button.js';
import { FileExtensionIcon } from '#components/icons/file-extension-icon.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '#components/ui/tooltip.js';
import type { FormatEntry } from '#routes/projects_.$id/export-formats.utils.js';
import { getFormatInfo } from '#routes/projects_.$id/export-formats.utils.js';

const formatGridCols = 'grid grid-cols-1 gap-1.5 @[10rem]:grid-cols-2 @[16rem]:grid-cols-3';

function ExportFormatButton({
  format,
  isDirect,
  isExporting,
  onSelectFormat,
}: {
  readonly format: FileExtension;
  readonly isDirect: boolean;
  readonly isExporting: boolean;
  readonly onSelectFormat: (format: FileExtension) => void;
}) {
  const info = getFormatInfo(format);
  const handleClick = useCallback(() => {
    onSelectFormat(format);
  }, [format, onSelectFormat]);

  const button = (
    <Button
      variant='outline'
      size='xs'
      disabled={isExporting}
      className='justify-start uppercase hover:border-primary/50'
      onClick={handleClick}
    >
      <FileExtensionIcon filename={`file.${format}`} className='size-3.5 shrink-0' />
      <span className='flex-1 text-left'>{format}</span>
    </Button>
  );

  if (!info) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side='right' className='max-w-56'>
        <p className='font-semibold'>{info.name}</p>
        <p className='mt-0.5 text-[10px] leading-snug text-white/70'>{info.description}</p>
        {!isDirect && <p className='mt-1 text-[10px] text-white/50 italic'>Transcoded</p>}
      </TooltipContent>
    </Tooltip>
  );
}

export type ExportFormatGridProps = {
  readonly formats: FormatEntry[];
  readonly isExporting: boolean;
  readonly onSelectFormat: (format: FileExtension) => void;
};

/**
 * Pure presentational grid that groups available export formats into MESH and BREP
 * sections and renders each as a single-click pill. Click semantics are owned by the
 * caller via `onSelectFormat`; the grid disables every pill while `isExporting` is true.
 */
export function ExportFormatGrid({ formats, isExporting, onSelectFormat }: ExportFormatGridProps): React.JSX.Element {
  const meshFormats = formats.filter((f) => f.fidelity === 'mesh');
  const brepFormats = formats.filter((f) => f.fidelity === 'brep');

  return (
    <TooltipProvider>
      <div className='@container flex flex-col gap-3'>
        {meshFormats.length > 0 && (
          <div>
            <p className='mb-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase'>Mesh</p>
            <div className={formatGridCols}>
              {meshFormats.map(({ format, direct }) => (
                <ExportFormatButton
                  key={format}
                  format={format}
                  isDirect={direct}
                  isExporting={isExporting}
                  onSelectFormat={onSelectFormat}
                />
              ))}
            </div>
          </div>
        )}
        {brepFormats.length > 0 && (
          <div>
            <p className='mb-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase'>BREP</p>
            <div className={formatGridCols}>
              {brepFormats.map(({ format, direct }) => (
                <ExportFormatButton
                  key={format}
                  format={format}
                  isDirect={direct}
                  isExporting={isExporting}
                  onSelectFormat={onSelectFormat}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
