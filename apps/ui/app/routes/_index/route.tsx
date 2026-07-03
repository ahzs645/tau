import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowUpRight, Box, Search } from 'lucide-react';
import { projectExamples } from '#routes/playground/projects.js';
import { cn } from '#utils/ui.utils.js';
import type { Handle } from '#types/matches.types.js';

const galleryExamples = projectExamples;
// Build the engine filter list from the kernels actually present in the gallery
// so OpenCascade / Replicad projects surface their own filter automatically.
const engineFilters: readonly string[] = ['All', ...new Set(galleryExamples.map((example) => example.kernel))];
// Categories come from each project's `project.json` metadata; projects without one
// stay reachable through the "All" option.
const categoryFilters: readonly string[] = [
  'All',
  ...[...new Set(galleryExamples.flatMap((example) => (example.category ? [example.category] : [])))].sort((a, b) =>
    a.localeCompare(b),
  ),
];

type EngineFilter = string;

export const handle: Handle = {
  enablePageWrapper: false,
};

export default function PlaygroundGallery(): React.JSX.Element {
  const [searchTerm, setSearchTerm] = useState('');
  const [engineFilter, setEngineFilter] = useState<EngineFilter>('All');
  const [categoryFilter, setCategoryFilter] = useState('All');

  const filteredExamples = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return galleryExamples.filter((example) => {
      if (engineFilter !== 'All' && example.kernel !== engineFilter) {
        return false;
      }

      if (categoryFilter !== 'All' && example.category !== categoryFilter) {
        return false;
      }

      if (!term) {
        return true;
      }

      return [
        example.name,
        example.description,
        example.kernel,
        example.mainFile,
        example.category ?? '',
        ...(example.tags ?? []),
      ]
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
  }, [categoryFilter, engineFilter, searchTerm]);

  return (
    <main className='h-dvh overflow-x-hidden overflow-y-auto bg-background text-foreground'>
      <section className='mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-5 md:px-6'>
        <div className='flex flex-col gap-3 border-b pb-4 max-md:sticky max-md:top-0 max-md:z-20 max-md:-mx-4 max-md:bg-background/95 max-md:px-4 max-md:py-4 max-md:backdrop-blur md:flex-row md:items-center md:justify-between'>
          <label className='flex min-h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-sm md:max-w-md'>
            <Search className='size-3.5 text-muted-foreground' />
            <input
              className='min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground'
              type='search'
              aria-label='Search gallery'
              placeholder='Search gallery'
              value={searchTerm}
              onChange={(event) => {
                setSearchTerm(event.target.value);
              }}
            />
          </label>

          <div className='flex flex-wrap items-center gap-1.5'>
            {categoryFilters.length > 1 ? (
              <select
                aria-label='Filter by category'
                className='min-h-11 rounded-sm border bg-background px-2.5 py-2 text-xs md:min-h-0 md:py-1.5'
                value={categoryFilter}
                onChange={(event) => {
                  setCategoryFilter(event.target.value);
                }}
              >
                {categoryFilters.map((category) => (
                  <option key={category} value={category}>
                    {category === 'All' ? 'All categories' : category}
                  </option>
                ))}
              </select>
            ) : null}
            {engineFilters.map((filter) => (
              <button
                key={filter}
                type='button'
                className={cn(
                  'min-h-11 rounded-sm border px-3 py-2 text-xs transition-colors hover:border-primary/50 md:min-h-0 md:px-2.5 md:py-1.5',
                  filter === engineFilter ? 'border-primary bg-primary text-primary-foreground' : 'bg-background',
                )}
                onClick={() => {
                  setEngineFilter(filter);
                }}
              >
                {filter}
              </button>
            ))}
          </div>
        </div>

        <div className='grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3'>
          {filteredExamples.map((example) => {
            const presetCount = example.presets?.length ?? 0;

            return (
              <Link
                key={example.id}
                to={`/playground?model=${example.id}`}
                aria-label={`Open ${example.name}`}
                className='group flex min-w-0 flex-col overflow-hidden rounded-md border bg-background transition-colors hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
              >
                {/* Every card gets the same media slot so rows stay aligned; models
                    without a poster render a placeholder instead of collapsing. */}
                <div className='relative aspect-video w-full shrink-0 border-b bg-muted/30'>
                  {example.image ? (
                    <img
                      src={example.image}
                      alt=''
                      loading='lazy'
                      decoding='async'
                      className='size-full object-cover'
                    />
                  ) : (
                    <div className='flex size-full items-center justify-center'>
                      <Box className='size-8 text-muted-foreground/40' strokeWidth={1.25} aria-hidden />
                    </div>
                  )}
                  <span className='absolute top-2 right-2 rounded-sm border bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground backdrop-blur-sm'>
                    {example.kernel}
                  </span>
                </div>

                <div className='flex flex-1 flex-col p-4'>
                  <h2 className='truncate text-sm font-semibold group-hover:text-primary'>{example.name}</h2>
                  <p className='mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground'>{example.description}</p>

                  <div className='mt-auto flex items-center justify-between gap-2 pt-4'>
                    <span className='truncate text-xs text-muted-foreground'>
                      {[example.category, presetCount > 0 ? `${presetCount} presets` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <span className='flex shrink-0 items-center gap-1 text-xs font-medium text-primary'>
                      Open
                      <ArrowUpRight className='size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5' />
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>

        {filteredExamples.length === 0 ? (
          <div className='rounded-md border border-dashed p-6 text-sm text-muted-foreground'>
            No gallery models match the current filters.
          </div>
        ) : null}
      </section>
    </main>
  );
}
