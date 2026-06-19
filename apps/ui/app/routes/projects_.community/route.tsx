import { useState } from 'react';
import { Link, NavLink } from 'react-router';
import { Code2, SlidersHorizontal } from 'lucide-react';
import type { KernelProvider } from '@taucad/runtime';
import { kernelProviders } from '@taucad/types/constants';
import { Button } from '#components/ui/button.js';
import { SearchInput } from '#components/search-input.js';
import { getFileExtension } from '#utils/filesystem.utils.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.js';
import { sampleProjects } from '#constants/project-examples.js';
import { CommunityProjectGrid } from '#components/project-grid.js';
import { cn } from '#utils/ui.utils.js';
import type { Handle } from '#types/matches.types.js';
import { Loader } from '#components/ui/loader.js';
import { useFeature } from '#flags/use-feature.js';

export const handle: Handle = {
  breadcrumb() {
    return (
      <Button asChild variant='ghost'>
        <Link to='/projects/community'>Community</Link>
      </Button>
    );
  },
  enableOverflowY: true,
};

const itemsPerPage = 9;
type SortOption = 'newest' | 'oldest';

export default function CadCommunity(): React.JSX.Element {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedKernel, setSelectedKernel] = useState<KernelProvider | 'all'>('all');
  const [sortOption, setSortOption] = useState<SortOption>('newest');
  const [visibleProjects, setVisibleProjects] = useState(itemsPerPage);
  const isProjectCreationEnabled = useFeature('enableProjectCreation');

  // Filter projects based on search term and selected language
  const filteredProjects = sampleProjects.filter((project) => {
    const matchesSearch =
      searchTerm === '' ||
      project.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      project.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
      project.tags.some((tag) => tag.toLowerCase().includes(searchTerm.toLowerCase()));

    const matchesKernel =
      selectedKernel === 'all' ||
      Object.values(project.assets).some((asset) => {
        const kernel = getFileExtension(asset.main);
        return kernel === selectedKernel;
      });

    return matchesSearch && matchesKernel;
  });

  // Sort projects based on selected option
  const sortedProjects = [...filteredProjects].sort((a, b) => {
    switch (sortOption) {
      case 'newest': {
        return b.createdAt - a.createdAt;
      }

      case 'oldest': {
        return a.createdAt - b.createdAt;
      }

      default: {
        const exhaustiveCheck: never = sortOption;
        throw new Error(`Invalid sort option: ${String(exhaustiveCheck)}`);
      }
    }
  });

  const handleLoadMore = () => {
    setVisibleProjects((previous) => Math.min(previous + itemsPerPage, sortedProjects.length));
  };

  const handleSearchClear = () => {
    setSearchTerm('');
  };

  return (
    <div className='container mx-auto space-y-8 px-4 py-8'>
      <div className='flex flex-col gap-4 md:flex-row md:items-center md:justify-between'>
        <div className='flex items-center gap-2'>
          <h1 className='text-3xl font-bold'>Community</h1>
          <span className='text-muted-foreground'>({sortedProjects.length})</span>
        </div>
        {isProjectCreationEnabled ? (
          <Button asChild>
            <NavLink to='/'>{({ isPending }) => (isPending ? <Loader /> : 'New Project')}</NavLink>
          </Button>
        ) : null}
      </div>

      <div
        className={cn(
          'flex flex-col gap-4',
          // Mobile only: keep search + filters pinned to the top while the gallery scrolls.
          // Desktop is unchanged (md:static restores normal flow).
          'max-md:sticky max-md:top-0 max-md:z-20 max-md:-mx-4 max-md:border-b max-md:bg-background/90 max-md:px-4 max-md:py-3 max-md:backdrop-blur',
        )}
      >
        <div className='flex flex-col gap-4 lg:flex-row lg:items-center'>
          <SearchInput
            placeholder='Search projects...'
            value={searchTerm}
            containerClassName='grow'
            onChange={(event) => {
              setSearchTerm(event.target.value);
            }}
            onClear={handleSearchClear}
          />
          <div className='flex min-w-0 flex-wrap items-center gap-2'>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant='outline'
                  className='min-h-11 min-w-0 flex-1 justify-start sm:w-[180px] sm:flex-none md:min-h-0'
                >
                  <Code2 className='mr-2 size-4' />
                  <span className='truncate'>{selectedKernel === 'all' ? 'All Kernels' : selectedKernel}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end' className='w-[180px]'>
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    onClick={() => {
                      setSelectedKernel('all');
                    }}
                  >
                    All Kernels
                  </DropdownMenuItem>
                  {kernelProviders.map((key) => (
                    <DropdownMenuItem
                      key={key}
                      onClick={() => {
                        setSelectedKernel(key);
                      }}
                    >
                      {key}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant='outline'
                  className='min-h-11 min-w-0 flex-1 justify-start sm:w-[180px] sm:flex-none md:min-h-0'
                >
                  <SlidersHorizontal className='mr-2 size-4' />
                  <span className='truncate'>Sort by: {sortOption}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end' className='w-[180px]'>
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    onClick={() => {
                      setSortOption('newest');
                    }}
                  >
                    Newest
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setSortOption('oldest');
                    }}
                  >
                    Oldest
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <CommunityProjectGrid projects={sortedProjects} />

      {visibleProjects < sortedProjects.length && (
        <div className='flex justify-center'>
          <Button onClick={handleLoadMore}>Load More Projects</Button>
        </div>
      )}
    </div>
  );
}
