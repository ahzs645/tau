import type { ActorRefFrom } from 'xstate';
import type { Project } from '@taucad/types';
import { Badge } from '#components/ui/badge.js';
import { Separator } from '#components/ui/separator.js';
import { ExportSelector } from '#components/files/export-selector.js';
import type { cadMachine } from '#machines/cad.machine.js';

type PreviewDetailsProps = {
  readonly project: Project;
  readonly geometriesCount: number;
  readonly cadRef: ActorRefFrom<typeof cadMachine>;
};

export function PreviewDetails({ project, geometriesCount, cadRef }: PreviewDetailsProps): React.JSX.Element {
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
        {geometriesCount === 0 ? (
          <p className='text-xs text-muted-foreground'>Render the geometry to enable export.</p>
        ) : (
          <ExportSelector cadActor={cadRef} filenameBase={project.name} variant='inline' />
        )}
      </div>
    </div>
  );
}
