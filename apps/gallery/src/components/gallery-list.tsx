import { memo, useCallback, useMemo, useState } from 'react';
import { ArrowUpRight, Box, Search, X } from 'lucide-react';
import { Button } from '@taucad/ui/components/button';
import { Heading } from '@taucad/ui/components/heading';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@taucad/ui/components/dialog';
import { Input } from '@taucad/ui/components/input';
import { listPublicProjects } from '#catalog/catalog.js';
import type { GalleryProject } from '#catalog/types.js';
import { navigate } from '#sharing/location.js';
import { ThemeToggle } from '#components/theme.jsx';

const kernelLabel = (kernel: string): string =>
  kernel === 'openrscad'
    ? 'OpenSCAD'
    : kernel === 'opencascade'
      ? 'OpenCASCADE'
      : kernel === 'replicad'
        ? 'Replicad'
        : kernel;
const projectKernels = (project: GalleryProject): string[] => [
  ...new Set(project.variants.map((variant) => variant.kernel)),
];

const GalleryCard = memo(
  ({
    project,
    onPreview,
  }: {
    readonly project: GalleryProject;
    readonly onPreview: (project: GalleryProject) => void;
  }): React.JSX.Element => {
    const open = useCallback(
      (event: React.MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        navigate(`/${encodeURIComponent(project.id)}`);
      },
      [project.id],
    );
    const preview = useCallback(() => {
      onPreview(project);
    }, [onPreview, project]);
    return (
      <article className='gallery-card group relative flex min-w-0 overflow-hidden rounded-lg border bg-background focus-within:border-foreground/30 hover:border-foreground/30'>
        <a
          href={`/${encodeURIComponent(project.id)}`}
          onClick={open}
          aria-label={`Open ${project.title}`}
          className='absolute inset-0 rounded-lg focus-visible:focus-outline'
        />
        <div className='gallery-card-media relative shrink-0 bg-muted/30'>
          {project.imageUrl ? (
            <button
              type='button'
              onClick={preview}
              className='relative z-10 size-full focus-visible:focus-outline'
              aria-label={`Preview ${project.title}`}
            >
              <img src={project.imageUrl} alt={project.title} loading='lazy' className='size-full object-contain' />
            </button>
          ) : (
            <div className='flex size-full items-center justify-center text-muted-foreground'>
              <Box aria-hidden className='size-10' />
            </div>
          )}
        </div>
        <div className='pointer-events-none flex min-w-0 flex-1 flex-col gap-2 p-4'>
          <div className='flex items-start justify-between gap-2'>
            <Heading level={2} variant='item'>
              {project.title}
            </Heading>
            <span className='flex h-lh shrink-0 items-center'>
              <ArrowUpRight aria-hidden className='size-4 text-muted-foreground' />
            </span>
          </div>
          <p className='line-clamp-3 text-sm text-muted-foreground'>{project.description}</p>
          <div className='mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-xs text-muted-foreground'>
            {project.category ? <span>{project.category}</span> : null}
            <span>
              {project.mode === 'static'
                ? '3D model'
                : projectKernels(project)
                    .map((kernel) => kernelLabel(kernel))
                    .join(' · ')}
            </span>
            {project.presets.length > 0 ? <span>{project.presets.length} presets</span> : null}
          </div>
        </div>
      </article>
    );
  },
);

export const GalleryList = (): React.JSX.Element => {
  const projects = useMemo(() => listPublicProjects(), []);
  const categories = useMemo(
    () => [...new Set(projects.flatMap((project) => (project.category ? [project.category] : [])))].sort(),
    [projects],
  );
  const kernels = useMemo(() => [...new Set(projects.flatMap((project) => projectKernels(project)))], [projects]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [kernel, setKernel] = useState('all');
  const [preview, setPreview] = useState<GalleryProject>();
  const filtered = useMemo(
    () =>
      projects.filter((project) => {
        if (category !== 'all' && project.category !== category) {
          return false;
        }
        if (kernel !== 'all' && !projectKernels(project).includes(kernel)) {
          return false;
        }
        const searchText = [
          project.title,
          project.description,
          project.category,
          ...project.tags,
          ...projectKernels(project).map((kernel) => kernelLabel(kernel)),
          ...project.variants.map((variant) => variant.entry),
        ]
          .join(' ')
          .toLowerCase();
        return searchText.includes(query.trim().toLowerCase());
      }),
    [projects, query, category, kernel],
  );
  const reset = useCallback(() => {
    setQuery('');
    setCategory('all');
    setKernel('all');
  }, []);
  const closePreview = useCallback((open: boolean) => {
    if (!open) {
      setPreview(undefined);
    }
  }, []);
  return (
    <main className='gallery-home min-h-dvh bg-background text-foreground'>
      <section className='mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-5 md:px-6'>
        <header className='flex items-center justify-between gap-3'>
          <Heading level={1} variant='title'>
            3D gallery
          </Heading>
          <ThemeToggle />
        </header>
        <div className='gallery-filters sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b bg-background py-3'>
          <div className='relative min-w-0 flex-1'>
            <Search aria-hidden className='pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground' />
            <Input
              type='search'
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              className='h-11 pl-9 text-base'
              aria-label='Search gallery'
              placeholder='Search gallery'
            />
          </div>
          <div className='flex min-w-0 flex-1 gap-2 md:flex-none'>
            <select
              aria-label='Filter by category'
              className='gallery-select flex-1'
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
              }}
            >
              <option value='all'>All categories</option>
              {categories.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <select
              aria-label='Filter by engine'
              className='gallery-select flex-1'
              value={kernel}
              onChange={(event) => {
                setKernel(event.target.value);
              }}
            >
              <option value='all'>All engines</option>
              {kernels.map((item) => (
                <option key={item} value={item}>
                  {kernelLabel(item)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p role='status' className='text-xs text-muted-foreground'>
          {filtered.length} of {projects.length} projects
        </p>
        <div className='grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3'>
          {filtered.map((project) => (
            <GalleryCard key={project.id} project={project} onPreview={setPreview} />
          ))}
        </div>
        {filtered.length === 0 ? (
          <div className='flex flex-col items-center gap-3 py-12'>
            <Heading level={2} variant='item'>
              No matching projects
            </Heading>
            <p className='text-sm text-muted-foreground'>Try another search or clear the filters.</p>
            <Button variant='outline' onClick={reset}>
              <X aria-hidden />
              Clear filters
            </Button>
          </div>
        ) : null}
        <footer className='flex flex-wrap justify-between gap-3 border-t py-4 text-xs text-muted-foreground'>
          <span>Models run in your browser. Download the result or the project source.</span>
          <a href='https://github.com/ahzs645/tau' className='underline underline-offset-4'>
            Source on GitHub
          </a>
        </footer>
      </section>
      <Dialog open={Boolean(preview)} onOpenChange={closePreview}>
        <DialogContent className='max-w-4xl'>
          <DialogTitle>{preview?.title}</DialogTitle>
          <DialogDescription>{preview?.description}</DialogDescription>
          {preview?.imageUrl ? (
            <img src={preview.imageUrl} alt={preview.title} className='max-h-[70dvh] w-full object-contain' />
          ) : null}
          <Button asChild>
            <a href={preview ? `/${encodeURIComponent(preview.id)}` : '/'}>Open model</a>
          </Button>
        </DialogContent>
      </Dialog>
    </main>
  );
};
