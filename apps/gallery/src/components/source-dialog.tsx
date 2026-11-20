import { useCallback, useEffect, useMemo, useState } from 'react';
import { Code, Download } from 'lucide-react';
import { Button } from '@taucad/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@taucad/ui/components/dialog';
import { Skeleton } from '@taucad/ui/components/skeleton';
import { createProjectSourceArchive, loadProjectFiles, sourceText } from '#catalog/catalog.js';
import type { GalleryFiles, GalleryProject } from '#catalog/types.js';
import { downloadBytes, errorMessage } from '#components/download.js';

export const SourceDialog = ({
  project,
  entry,
  currentFiles,
}: {
  readonly project: GalleryProject;
  readonly entry?: string;
  readonly currentFiles: GalleryFiles;
}): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<GalleryFiles>();
  const [selected, setSelected] = useState(entry ?? '');
  const [error, setError] = useState<string>();
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      setError(undefined);
      try {
        const next =
          Object.keys(currentFiles).length > 0
            ? currentFiles
            : await loadProjectFiles(project.id, undefined, controller.signal);
        if (!controller.signal.aborted) {
          setFiles(next);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(errorMessage(error));
        }
      }
    };
    void load();
    return () => {
      controller.abort();
    };
  }, [open, project.id, currentFiles]);
  const textFiles = useMemo(
    () => Object.keys(files ?? {}).filter((path) => /\.(?:[cm]?js|tsx?|scad|json|svg|dxf|txt|csv)$/iu.test(path)),
    [files],
  );
  const path = textFiles.includes(selected)
    ? selected
    : textFiles.includes(entry ?? '')
      ? (entry ?? '')
      : (textFiles[0] ?? '');
  const source = useMemo(() => {
    try {
      return { text: files && path ? sourceText(files, path) : undefined };
    } catch (error) {
      return { error: `This file could not be displayed as text. ${errorMessage(error)}` };
    }
  }, [files, path]);
  const download = useCallback(async () => {
    setDownloading(true);
    setError(undefined);
    try {
      const archive = await createProjectSourceArchive(project.id);
      downloadBytes({ ...archive, name: archive.filename });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setDownloading(false);
    }
  }, [project.id]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant='outline' size='touch'>
          <Code aria-hidden />
          <span className='max-sm:sr-only'>Source</span>
        </Button>
      </DialogTrigger>
      <DialogContent className='flex max-h-[90dvh] max-w-4xl flex-col'>
        <DialogTitle>{project.title} source</DialogTitle>
        <DialogDescription>
          Inspect the model code or download the complete original project with its assets and attribution.
        </DialogDescription>
        <div className='flex flex-wrap items-center gap-2'>
          {textFiles.length > 0 ? (
            <select
              className='gallery-select min-w-0 flex-1 font-mono'
              aria-label='Source file'
              value={path}
              onChange={(event) => {
                setSelected(event.target.value);
              }}
            >
              {textFiles.map((file) => (
                <option key={file} value={file}>
                  {file}
                </option>
              ))}
            </select>
          ) : null}
          <Button size='touch' disabled={downloading} onClick={download}>
            <Download aria-hidden />
            {downloading ? 'Preparing ZIP…' : 'Download project ZIP'}
          </Button>
        </div>
        {source.text === undefined ? (
          source.error ? (
            <p role='alert' className='text-sm'>
              {source.error}
            </p>
          ) : files ? (
            <p className='py-4 text-sm'>
              This project contains binary model assets. Download the project ZIP to inspect them.
            </p>
          ) : (
            <div role='status' aria-label='Loading model source' aria-busy='true'>
              <Skeleton aria-hidden className='h-64 w-full' />
            </div>
          )
        ) : (
          <pre
            className='min-h-0 overflow-auto rounded-md border bg-muted/30 p-4 font-mono text-xs'
            aria-label='Model source'
          >
            <code>{source.text}</code>
          </pre>
        )}
        {error ? (
          <p role='alert' className='text-sm'>
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
