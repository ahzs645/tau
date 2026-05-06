import { useMemo, useState } from 'react';
import type { Model } from '@taucad/chat';
import { Button } from '#components/ui/button.js';
import { Input } from '#components/ui/input.js';
import { Switch } from '#components/ui/switch.js';
import { SvgIcon } from '#components/icons/svg-icon.js';
import { useModels } from '#hooks/use-models.js';

export function ModelSettings(): React.JSX.Element {
  const { data = [], recommendedModels, isAvailable, setAvailable } = useModels();
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);

  const visibleModels = useMemo(() => {
    const base: Model[] = showAll ? data : recommendedModels;
    if (!search) {
      return base;
    }

    const query = search.toLowerCase();
    return base.filter(
      (model) => model.name.toLowerCase().includes(query) || model.provider.name.toLowerCase().includes(query),
    );
  }, [data, recommendedModels, search, showAll]);

  return (
    <div className='flex flex-col gap-4 pb-6'>
      <Input
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
        }}
        placeholder='Search models...'
      />

      <p className='text-sm text-muted-foreground'>
        Choose which models appear in the chat model picker. Disabled models stay configured and can be re-enabled
        anytime.
      </p>

      <div className='flex flex-col divide-y rounded-md border'>
        {visibleModels.map((model) => (
          <div key={model.id} className='flex items-center justify-between gap-3 px-3 py-2.5'>
            <div className='flex min-w-0 items-center gap-2'>
              <SvgIcon id={model.details.family} className='size-4 shrink-0' />
              <span className='truncate text-sm'>{model.name}</span>
            </div>
            <Switch
              checked={isAvailable(model)}
              onCheckedChange={(checked) => {
                setAvailable(model, checked);
              }}
            />
          </div>
        ))}
      </div>

      {visibleModels.length === 0 ? (
        <p className='text-sm text-muted-foreground'>No models match your search.</p>
      ) : null}

      <Button
        variant='link'
        className='self-start px-0'
        onClick={() => {
          setShowAll((previous) => !previous);
        }}
      >
        {showAll ? 'Show recommended only' : 'View All Models'}
      </Button>
    </div>
  );
}
