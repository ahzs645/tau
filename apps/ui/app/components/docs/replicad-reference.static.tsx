import { useMemo } from 'react';
import { mockProjects } from '@taucad/tau-examples';
import { CodeViewer } from '#components/code/code-viewer.js';

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
      <div className='max-h-[500px] overflow-auto'>
        <div className='p-3'>
          <CodeViewer text={code} language='typescript' />
        </div>
      </div>
    </div>
  );
}

export function ReplicadReference(): React.JSX.Element {
  const examples = useMemo(
    () =>
      selectedExampleIds
        .map((id) => mockProjects.find((project) => project.id === id))
        .filter((project): project is (typeof mockProjects)[number] => project !== undefined),
    [],
  );

  return (
    <div className='flex flex-col gap-6'>
      {examples.map((example) => (
        <ExampleCard key={example.id} name={example.name} description={example.description} code={example.code} />
      ))}
    </div>
  );
}
