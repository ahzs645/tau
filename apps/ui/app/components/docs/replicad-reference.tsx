'use client';

import { useMemo } from 'react';
import { mockProjects } from '@taucad/tau-examples';
import { SharedRendererProvider } from '#components/docs/shared-renderer.js';
import { KernelModelView } from '#components/docs/kernel-model-view.js';
import { CodeViewer } from '#components/code/code-viewer.js';
import { ClientOnly } from '#components/ui/utils/client-only.js';

const selectedExampleIds = ['proj_hollow_box', 'proj_vase', 'proj_birdhouse', 'proj_cylindrical_gear', 'proj_ibeam'];

type ExampleCardProps = {
  readonly name: string;
  readonly description: string;
  readonly code: string;
};

function ExampleCard({ name, description, code }: ExampleCardProps): React.JSX.Element {
  return (
    <div className='not-prose overflow-hidden rounded-lg border'>
      <div className='border-b px-4 py-3'>
        <h3 className='text-base font-semibold'>{name}</h3>
        <p className='mt-1 text-sm text-muted-foreground'>{description}</p>
      </div>
      <div className='grid grid-cols-1 md:grid-cols-2'>
        <div className='max-h-[500px] overflow-auto border-r border-b-0 md:border-b-0'>
          <div className='p-3'>
            <CodeViewer text={code} language='typescript' />
          </div>
        </div>
        <div className='h-[400px] md:h-auto md:min-h-[400px]'>
          <KernelModelView code={code} />
        </div>
      </div>
    </div>
  );
}

/**
 * Interactive reference page showing Replicad examples with code and live 3D views.
 * Each example gets its own runtime client, and all views share a single WebGL context
 * via SharedRendererProvider.
 */
export function ReplicadReference(): React.JSX.Element {
  const examples = useMemo(
    () =>
      selectedExampleIds
        .map((id) => mockProjects.find((project) => project.id === id))
        .filter((project): project is (typeof mockProjects)[number] => project !== undefined),
    [],
  );

  return (
    <ClientOnly>
      <SharedRendererProvider>
        <div className='flex flex-col gap-6'>
          {examples.map((example) => (
            <ExampleCard key={example.id} name={example.name} description={example.description} code={example.code} />
          ))}
        </div>
      </SharedRendererProvider>
    </ClientOnly>
  );
}
