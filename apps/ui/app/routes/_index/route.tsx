import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink, FileCode2, Search } from 'lucide-react';
import { buttonVariants } from '#components/ui/button.js';
import { toast } from '#components/ui/sonner.js';
import { projectExamples } from '#routes/playground/projects.js';
import type { AppVersion } from '#routes/version[.]json.js';
import { cn } from '#utils/ui.utils.js';
import type { Handle } from '#types/matches.types.js';

const galleryExamples = projectExamples;
// Build the engine filter list from the kernels actually present in the gallery
// so OpenCascade / Replicad projects surface their own filter automatically.
const engineFilters: readonly string[] = ['All', ...new Set(galleryExamples.map((example) => example.kernel))];
const updateCheckIntervalMs = 60_000;
const updateToastId = 'app-version-update-available';

type EngineFilter = string;

export const handle: Handle = {
  enablePageWrapper: false,
};

export default function PlaygroundGallery(): React.JSX.Element {
  const [searchTerm, setSearchTerm] = useState('');
  const [engineFilter, setEngineFilter] = useState<EngineFilter>('All');
  useGalleryVersionCheck();

  const filteredExamples = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return galleryExamples.filter((example) => {
      if (engineFilter !== 'All' && example.kernel !== engineFilter) {
        return false;
      }

      if (!term) {
        return true;
      }

      return [example.name, example.description, example.kernel, example.mainFile]
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
  }, [engineFilter, searchTerm]);

  return (
    <main className='h-dvh overflow-y-auto bg-background text-foreground'>
      <section className='mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-5 md:px-6'>
        <div className='flex flex-col gap-3 border-b pb-4 md:flex-row md:items-center md:justify-between'>
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

          <div className='flex flex-wrap gap-1.5'>
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

        <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'>
          {filteredExamples.map((example) => (
            <article key={example.id} className='rounded-md border bg-background p-4'>
              <div className='mb-3 flex items-start justify-between gap-3'>
                <div className='min-w-0'>
                  <h2 className='truncate text-sm font-semibold'>{example.name}</h2>
                  <p className='mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground'>{example.description}</p>
                </div>
                <span className='shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground'>
                  {example.kernel}
                </span>
              </div>

              <dl className='grid grid-cols-2 gap-2 text-xs'>
                <div className='rounded-sm bg-muted/50 px-2 py-1.5'>
                  <dt className='text-muted-foreground'>File</dt>
                  <dd className='truncate font-mono'>{example.mainFile}</dd>
                </div>
                <div className='rounded-sm bg-muted/50 px-2 py-1.5'>
                  <dt className='text-muted-foreground'>Exports</dt>
                  <dd className='truncate uppercase'>{example.exportFormats.join(', ')}</dd>
                </div>
              </dl>

              <div className='mt-3 flex items-center justify-between gap-2'>
                <div className='flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground'>
                  <FileCode2 className='size-3.5 shrink-0' />
                  <span className='truncate'>{example.presets?.length ?? 0} presets</span>
                </div>
                <Link
                  to={`/playground?model=${example.id}`}
                  className={buttonVariants({ variant: 'default', size: 'sm' })}
                >
                  <ExternalLink className='size-3.5' />
                  Open
                </Link>
              </div>
            </article>
          ))}
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

function useGalleryVersionCheck(): void {
  useEffect(() => {
    const currentCommit = import.meta.env['VITE_COMMIT_SHA'];

    if (!currentCommit) {
      return;
    }

    let cancelled = false;

    const checkForUpdate = async (): Promise<void> => {
      try {
        const response = await fetch(`${getVersionJsonHref()}?ts=${Date.now()}`, { cache: 'no-store' });

        if (!response.ok) {
          return;
        }

        const latest = (await response.json()) as AppVersion;

        if (!cancelled && latest.commit && latest.commit !== currentCommit) {
          toast.info('New version available', {
            id: updateToastId,
            description: 'Refresh to use the latest gallery and project files.',
            action: {
              label: 'Refresh',
              onClick: () => {
                globalThis.location.reload();
              },
            },
            duration: Number.POSITIVE_INFINITY,
          });
        }
      } catch {
        // Version checks are best-effort; cached app shells should still remain usable offline.
      }
    };

    void checkForUpdate();
    const interval = globalThis.setInterval(() => {
      void checkForUpdate();
    }, updateCheckIntervalMs);

    return () => {
      cancelled = true;
      globalThis.clearInterval(interval);
    };
  }, []);
}

function getVersionJsonHref(): string {
  const frontendUrl = globalThis.window.ENV.TAU_FRONTEND_URL;

  try {
    const { pathname } = new URL(frontendUrl);
    const publicBasePath = pathname === '/' ? '' : pathname.replace(/\/$/, '');
    return `${publicBasePath}/version.json`;
  } catch {
    return '/version.json';
  }
}
