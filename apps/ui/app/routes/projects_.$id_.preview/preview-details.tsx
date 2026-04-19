import { Download } from 'lucide-react';
import type { Project, FileExtension } from '@taucad/types';
import { Button } from '#components/ui/button.js';
import { Badge } from '#components/ui/badge.js';
import { Separator } from '#components/ui/separator.js';

type PreviewDetailsProps = {
  readonly project: Project;
  readonly geometriesCount: number;
  readonly onExport: (format: FileExtension) => void;
};

export function PreviewDetails({ project, geometriesCount, onExport }: PreviewDetailsProps): React.JSX.Element {
  return (
    <div className='space-y-6 p-6'>
      {/* About */}
      <div>
        <h3 className='mb-3 text-sm font-semibold'>About</h3>
        <p className='text-sm text-muted-foreground'>{project.description || 'No description provided'}</p>
      </div>

      <Separator />

      {/* Tags */}
      {project.tags.length > 0 ? (
        <>
          <div>
            <h3 className='mb-3 text-sm font-semibold'>Tags</h3>
            <div className='flex flex-wrap gap-2'>
              {project.tags.map((tag) => (
                <Badge key={tag} variant='secondary'>
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
          <Separator />
        </>
      ) : null}

      {/* License */}
      <div>
        <h3 className='mb-3 text-sm font-semibold'>License</h3>
        <p className='text-sm text-muted-foreground'>MIT</p>
      </div>

      <Separator />

      {/* Downloads */}
      <div>
        <h3 className='mb-3 text-sm font-semibold'>Downloads</h3>
        <div className='space-y-2'>
          <Button
            variant='outline'
            size='sm'
            className='w-full justify-start'
            disabled={geometriesCount === 0}
            onClick={() => {
              onExport('stl');
            }}
          >
            <Download className='mr-2 size-4' />
            Download STL
          </Button>
          <Button
            variant='outline'
            size='sm'
            className='w-full justify-start'
            disabled={geometriesCount === 0}
            onClick={() => {
              onExport('step');
            }}
          >
            <Download className='mr-2 size-4' />
            Download STEP
          </Button>
          <Button
            variant='outline'
            size='sm'
            className='w-full justify-start'
            disabled={geometriesCount === 0}
            onClick={() => {
              onExport('gltf');
            }}
          >
            <Download className='mr-2 size-4' />
            Download GLTF
          </Button>
        </div>
      </div>
    </div>
  );
}
