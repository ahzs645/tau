import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowUpRight, Box, Search, X } from 'lucide-react';
import { projectExamples } from '#routes/playground/projects.js';
import { cn } from '#utils/ui.utils.js';
import type { Handle } from '#types/matches.types.js';

const galleryExamples = projectExamples;

type GalleryExample = (typeof galleryExamples)[number];

function kernelsForExample(example: GalleryExample): readonly string[] {
  return [...new Set([example.kernel, ...(example.variants?.map((variant) => variant.kernel) ?? [])])];
}

// Build the engine filter list from the kernels actually present in the gallery
// so OpenCascade / Replicad projects surface their own filter automatically.
const engineFilters: readonly string[] = [
  'All',
  ...new Set(galleryExamples.flatMap((example) => kernelsForExample(example))),
];
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
  // Card image tapped on mobile: shown enlarged in a dismissable lightbox.
  const [zoomedExample, setZoomedExample] = useState<GalleryExample | undefined>(undefined);

  useEffect(() => {
    if (!zoomedExample) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setZoomedExample(undefined);
      }
    };

    globalThis.addEventListener('keydown', handleKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', handleKeyDown);
    };
  }, [zoomedExample]);

  const filteredExamples = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return galleryExamples.filter((example) => {
      const kernels = kernelsForExample(example);
      if (engineFilter !== 'All' && !kernels.includes(engineFilter)) {
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
        ...kernels,
        example.mainFile,
        ...(example.variants?.flatMap((variant) => [variant.label, variant.mainFile]) ?? []),
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
        <div className='flex flex-col gap-2.5 border-b pb-4 max-md:sticky max-md:top-0 max-md:z-20 max-md:-mx-4 max-md:bg-background/95 max-md:px-4 max-md:py-3 max-md:backdrop-blur md:flex-row md:items-center md:justify-between md:gap-3'>
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

          <div className='flex items-center gap-1.5 max-md:w-full'>
            {categoryFilters.length > 1 ? (
              <select
                aria-label='Filter by category'
                className='min-h-9 flex-1 rounded-sm border bg-background px-2.5 text-xs md:min-h-0 md:flex-none md:py-1.5'
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

            {/* Below md the engine chips would wrap onto several rows, so they collapse into a
                compact dropdown that sits beside the category filter on a single line. */}
            <select
              aria-label='Filter by engine'
              className='min-h-9 flex-1 rounded-sm border bg-background px-2.5 text-xs md:hidden'
              value={engineFilter}
              onChange={(event) => {
                setEngineFilter(event.target.value);
              }}
            >
              {engineFilters.map((filter) => (
                <option key={filter} value={filter}>
                  {filter === 'All' ? 'All engines' : filter}
                </option>
              ))}
            </select>

            {/* md+ has room for the full chip row. */}
            <div className='hidden items-center gap-1.5 md:flex'>
              {engineFilters.map((filter) => (
                <button
                  key={filter}
                  type='button'
                  className={cn(
                    'rounded-sm border px-2.5 py-1.5 text-xs transition-colors hover:border-primary/50',
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
        </div>

        <div className='grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3'>
          {filteredExamples.map((example) => {
            const presetCount = example.presets?.length ?? 0;

            // The media slot keeps every card the same shape (placeholder when there is no
            // poster). Below sm the card flips to a compact row with the media on the left.
            const mediaClasses =
              'relative shrink-0 bg-muted/30 max-sm:w-28 max-sm:self-stretch max-sm:border-r sm:aspect-video sm:w-full sm:border-b';

            return (
              <article
                key={example.id}
                className='group relative flex min-w-0 overflow-hidden rounded-md border bg-background transition-colors focus-within:border-primary/60 hover:border-primary/60 max-sm:flex-row sm:flex-col'
              >
                {/* Stretched link: covers the whole card, so everything that isn't its own
                    control (the mobile zoom button) opens the model. */}
                <Link
                  to={`/playground?model=${example.id}`}
                  aria-label={`Open ${example.name}`}
                  className='absolute inset-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                />

                {example.image ? (
                  <button
                    type='button'
                    aria-label={`Preview ${example.name}`}
                    // Zoom is a mobile affordance for the small thumbnail; on sm+ clicks fall
                    // through to the stretched link and open the model as before.
                    className={cn(mediaClasses, 'z-10 max-sm:cursor-zoom-in sm:pointer-events-none')}
                    onClick={() => {
                      setZoomedExample(example);
                    }}
                  >
                    <img
                      src={example.image}
                      alt=''
                      loading='lazy'
                      decoding='async'
                      className='size-full object-cover'
                    />
                    <GalleryKernelBadges example={example} />
                  </button>
                ) : (
                  <div className={cn(mediaClasses, 'flex items-center justify-center')}>
                    <Box className='size-6 text-muted-foreground/40 sm:size-8' strokeWidth={1.25} aria-hidden />
                    <GalleryKernelBadges example={example} />
                  </div>
                )}

                <div className='pointer-events-none flex min-w-0 flex-1 flex-col p-3 sm:p-4'>
                  <h2 className='truncate text-sm font-semibold group-hover:text-primary'>{example.name}</h2>
                  <p className='mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground'>{example.description}</p>

                  <div className='mt-auto flex items-center justify-between gap-2 pt-3 sm:pt-4'>
                    <span className='truncate text-xs text-muted-foreground'>
                      {[example.category, presetCount > 0 ? `${presetCount} presets` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <span className='flex shrink-0 items-center gap-1 text-xs font-medium text-primary'>
                      <span className='max-sm:hidden'>Open</span>
                      <ArrowUpRight className='size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5' />
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        {filteredExamples.length === 0 ? (
          <div className='rounded-md border border-dashed p-6 text-sm text-muted-foreground'>
            No gallery models match the current filters.
          </div>
        ) : null}
      </section>

      {zoomedExample?.image ? (
        <div
          role='dialog'
          aria-modal='true'
          aria-label={`${zoomedExample.name} preview`}
          className='fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm'
          onClick={() => {
            setZoomedExample(undefined);
          }}
        >
          <img
            src={zoomedExample.image}
            alt={zoomedExample.name}
            className='max-h-full max-w-full rounded-md border object-contain'
          />
          <button
            type='button'
            aria-label='Close preview'
            className='absolute top-4 right-4 rounded-md border bg-background/80 p-2 backdrop-blur-sm'
            onClick={() => {
              setZoomedExample(undefined);
            }}
          >
            <X className='size-4' />
          </button>
        </div>
      ) : null}
    </main>
  );
}

function GalleryKernelBadges({ example }: { readonly example: GalleryExample }): React.JSX.Element {
  const kernels = kernelsForExample(example);
  return (
    <span aria-label={`Engines: ${kernels.join(', ')}`} className='absolute top-2 right-2 flex gap-1 max-sm:hidden'>
      {kernels.map((kernel) => (
        <span
          key={kernel}
          className='rounded-sm border bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground backdrop-blur-sm'
        >
          {kernel}
        </span>
      ))}
    </span>
  );
}
