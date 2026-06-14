import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  Box,
  Braces,
  Download,
  FileCode2,
  LayoutGrid,
  Play,
  RotateCcw,
  Search,
  Share2,
  SlidersHorizontal,
} from 'lucide-react';
import type { FileExtension } from '@taucad/types';
import { downloadBlob } from '@taucad/utils/file';
import { toast } from '#components/ui/sonner.js';
import { CadPreviewStatus, CadPreviewViewer } from '#components/cad-preview.js';
import { Button, buttonVariants } from '#components/ui/button.js';
import { ClientOnly } from '#components/ui/utils/client-only.js';
import { FileManagerProvider, SharedWorkerGate } from '#hooks/use-file-manager.js';
import { CadPreviewProvider, useCadPreview } from '#hooks/use-cad-preview.js';
import { playgroundExamples } from '#routes/_index/playground-examples.js';
import type { PlaygroundExample, PlaygroundPreset } from '#routes/_index/playground-examples.js';
import { PreviewParameters } from '#routes/projects_.$id_.preview/preview-parameters.js';
import { encodeTextFile } from '#utils/filesystem.utils.js';
import { cn } from '#utils/ui.utils.js';
import type { Handle } from '#types/matches.types.js';

const CodeEditorLazy = lazy(async () => {
  const module = await import('#components/code/code-editor.client.js');
  return { default: module.CodeEditor };
});

type EditorFallbackProps = {
  readonly value: string;
  readonly onChange: (value: string) => void;
};

const defaultExample: PlaygroundExample = playgroundExamples[0]!;
const engineFilters = ['All', 'OpenSCAD', 'Replicad', 'OpenCascade'] as const;

type EngineFilter = (typeof engineFilters)[number];

export const handle: Handle = {
  enablePageWrapper: false,
};

export default function PlaygroundRoot(): React.JSX.Element {
  const [activeExampleId, setActiveExampleId] = useState(readInitialExampleId);
  const initialExample = playgroundExamples.find((example) => example.id === activeExampleId) ?? defaultExample;
  const [editorValue, setEditorValue] = useState(initialExample.code);
  const [previewValue, setPreviewValue] = useState(initialExample.code);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [engineFilter, setEngineFilter] = useState<EngineFilter>('All');

  const activeExample = playgroundExamples.find((example) => example.id === activeExampleId) ?? defaultExample;
  const previewProjectId = `root-playground-${activeExample.id}-${previewVersion}`;
  const isDirty = editorValue !== activeExample.code;
  const hasUnrunChanges = editorValue !== previewValue;

  const filteredExamples = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return playgroundExamples.filter((example) => {
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

  const files = useMemo(
    () => ({
      [activeExample.mainFile]: {
        content: encodeTextFile(previewValue),
      },
    }),
    [activeExample.mainFile, previewValue],
  );

  const selectExample = useCallback((example: PlaygroundExample, options: { readonly updateUrl?: boolean } = {}) => {
    setActiveExampleId(example.id);
    setEditorValue(example.code);
    setPreviewValue(example.code);
    setPreviewVersion((version) => version + 1);
    if (options.updateUrl ?? true) {
      writeExampleToUrl(example.id);
    }
  }, []);

  const runPreview = useCallback(() => {
    setPreviewValue(editorValue);
    setPreviewVersion((version) => version + 1);
  }, [editorValue]);

  const resetExample = useCallback(() => {
    setEditorValue(activeExample.code);
    setPreviewValue(activeExample.code);
    setPreviewVersion((version) => version + 1);
  }, [activeExample]);

  const copyShareLink = useCallback(() => {
    const url = buildExampleUrl(activeExample.id);
    if (!url) {
      return;
    }

    // oxlint-disable-next-line tau-lint/no-async-iife -- clipboard writes are event-driven and report via toast.
    void (async () => {
      try {
        await globalThis.navigator.clipboard.writeText(url);
        toast.success('Playground link copied');
      } catch {
        toast.error('Unable to copy playground link');
      }
    })();
  }, [activeExample.id]);

  useEffect(() => {
    writeExampleToUrl(activeExample.id, { replace: true });
  }, [activeExample.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F5' || ((event.metaKey || event.ctrlKey) && event.key === 'Enter')) {
        event.preventDefault();
        runPreview();
      }
    };

    globalThis.addEventListener('keydown', handleKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', handleKeyDown);
    };
  }, [runPreview]);

  return (
    <main className='flex min-h-dvh flex-col bg-background text-foreground'>
      <header className='flex min-h-14 flex-wrap items-center justify-between gap-3 border-b px-4 py-3 md:px-5'>
        <div className='flex min-w-0 items-center gap-3'>
          <div className='flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted'>
            <Box className='size-4' />
          </div>
          <div className='min-w-0'>
            <h1 className='truncate text-base font-semibold'>Tau CAD Playground</h1>
            <p className='truncate text-xs text-muted-foreground'>
              OpenSCAD, Replicad, and OpenCascade in one workspace
            </p>
          </div>
        </div>
        <div className='flex items-center gap-2'>
          <Link to='/gallery' className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <LayoutGrid className='size-3.5' />
            Gallery
          </Link>
          <Button variant='outline' size='sm' onClick={copyShareLink}>
            <Share2 className='size-3.5' />
            Share
          </Button>
          <Button variant='outline' size='sm' onClick={resetExample}>
            <RotateCcw className='size-3.5' />
            Reset
          </Button>
          <Button size='sm' onClick={runPreview}>
            <Play className='size-3.5' />
            Run
          </Button>
        </div>
      </header>

      <div className='grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(360px,0.9fr)_minmax(420px,1.1fr)]'>
        <aside className='border-b bg-muted/35 lg:border-r lg:border-b-0'>
          <div className='flex h-full flex-col'>
            <div className='border-b p-4'>
              <div className='flex items-center gap-2 text-sm font-medium'>
                <FileCode2 className='size-4' />
                Examples
              </div>
              <label className='mt-3 flex items-center gap-2 rounded-md border bg-background px-2.5 py-2 text-sm'>
                <Search className='size-3.5 text-muted-foreground' />
                <input
                  className='min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground'
                  type='search'
                  aria-label='Search examples'
                  placeholder='Search examples'
                  value={searchTerm}
                  onChange={(event) => {
                    setSearchTerm(event.target.value);
                  }}
                />
              </label>
              <div className='mt-3 flex flex-wrap gap-1.5'>
                {engineFilters.map((filter) => (
                  <button
                    key={filter}
                    type='button'
                    className={cn(
                      'rounded-sm border px-2 py-1 text-xs transition-colors hover:border-primary/50',
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
            <div className='grid gap-2 p-3 sm:grid-cols-3 lg:grid-cols-1'>
              {filteredExamples.map((example) => (
                <button
                  key={example.id}
                  type='button'
                  className={cn(
                    'rounded-md border bg-background p-3 text-left transition-colors hover:border-primary/50 hover:bg-accent',
                    example.id === activeExample.id && 'border-primary bg-accent',
                  )}
                  aria-pressed={example.id === activeExample.id}
                  onClick={() => {
                    selectExample(example);
                  }}
                >
                  <div className='mb-2 flex items-center justify-between gap-2'>
                    <span className='truncate text-sm font-medium'>{example.name}</span>
                    <span className='shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground'>
                      {example.kernel}
                    </span>
                  </div>
                  <p className='line-clamp-2 text-xs text-muted-foreground'>{example.description}</p>
                </button>
              ))}
              {filteredExamples.length === 0 ? (
                <div className='rounded-md border border-dashed bg-background p-3 text-xs text-muted-foreground'>
                  No examples match the current filters.
                </div>
              ) : null}
            </div>
          </div>
        </aside>

        <section className='flex min-h-[48dvh] min-w-0 flex-col border-b lg:min-h-0 lg:border-r lg:border-b-0'>
          <div className='flex h-11 items-center justify-between border-b px-3'>
            <div className='flex min-w-0 items-center gap-2'>
              <Braces className='size-4 text-muted-foreground' />
              <span className='truncate font-mono text-xs'>{activeExample.mainFile}</span>
            </div>
            <div className='flex items-center gap-1.5'>
              {isDirty ? (
                <span className='bg-amber-500/15 text-amber-700 rounded-sm px-2 py-1 text-xs'>edited</span>
              ) : null}
              {hasUnrunChanges ? (
                <span className='rounded-sm bg-muted px-2 py-1 text-xs text-muted-foreground'>unrun</span>
              ) : null}
              <span className='rounded-sm bg-muted px-2 py-1 text-xs text-muted-foreground'>
                {activeExample.kernel}
              </span>
            </div>
          </div>
          <div className='min-h-0 flex-1'>
            <ClientOnly fallback={<EditorFallback value={editorValue} onChange={setEditorValue} />}>
              <Suspense fallback={<EditorFallback value={editorValue} onChange={setEditorValue} />}>
                <CodeEditorLazy
                  className='h-full'
                  height='100%'
                  path={activeExample.mainFile}
                  language={activeExample.language}
                  value={editorValue}
                  onChange={(value) => {
                    setEditorValue(value ?? '');
                  }}
                />
              </Suspense>
            </ClientOnly>
          </div>
        </section>

        <section className='flex min-h-[48dvh] min-w-0 flex-col lg:min-h-0'>
          <SharedWorkerGate>
            <FileManagerProvider
              key={previewProjectId}
              projectId={previewProjectId}
              rootDirectory={`/projects/${previewProjectId}`}
              initialBackend='indexeddb'
            >
              <CadPreviewProvider projectId={previewProjectId} mainFile={activeExample.mainFile} files={files}>
                <div className='flex h-11 items-center justify-between border-b px-3'>
                  <div className='flex items-center gap-2'>
                    <SlidersHorizontal className='size-4 text-muted-foreground' />
                    <PreviewSummary />
                  </div>
                  <div className='flex items-center gap-1.5'>
                    <PlaygroundExportControls exampleId={activeExample.id} formats={activeExample.exportFormats} />
                  </div>
                </div>
                <div className='grid min-h-0 flex-1 grid-rows-[minmax(260px,1fr)_minmax(190px,0.42fr)]'>
                  <div className='relative min-h-0 bg-muted/30'>
                    <CadPreviewViewer
                      className='size-full'
                      enablePan
                      enableZoom
                      stageOptions={{ zoomLevel: 1.25 }}
                      graphicsOptions={{
                        enableLines: true,
                        viewerClassName: 'bg-muted/30',
                      }}
                    />
                    <CadPreviewStatus className='absolute top-3 left-3' />
                  </div>
                  <div className='min-h-0 border-t bg-background'>
                    <PlaygroundParameters presets={activeExample.presets ?? []} />
                  </div>
                </div>
              </CadPreviewProvider>
            </FileManagerProvider>
          </SharedWorkerGate>
        </section>
      </div>
    </main>
  );
}

function PlaygroundParameters({ presets }: { readonly presets: readonly PlaygroundPreset[] }): React.JSX.Element {
  return (
    <div className='flex h-full min-h-0 flex-col'>
      {presets.length > 0 ? <PlaygroundPresetControls presets={presets} /> : null}
      <div className='min-h-0 flex-1'>
        <PreviewParameters />
      </div>
    </div>
  );
}

function PlaygroundPresetControls({ presets }: { readonly presets: readonly PlaygroundPreset[] }): React.JSX.Element {
  const { setParameters } = useCadPreview();

  const applyPreset = useCallback(
    (preset: PlaygroundPreset) => {
      setParameters(preset.parameters);
      toast.success(`Applied ${preset.name}`);
    },
    [setParameters],
  );

  return (
    <div className='flex flex-wrap items-center gap-1.5 border-b bg-muted/30 px-2 py-1.5'>
      <span className='mr-1 text-xs text-muted-foreground'>Presets</span>
      {presets.map((preset) => (
        <Button
          key={preset.name}
          variant='outline'
          size='xs'
          onClick={() => {
            applyPreset(preset);
          }}
        >
          {preset.name}
        </Button>
      ))}
    </div>
  );
}

type PlaygroundExportButtonProps = {
  readonly format: FileExtension;
  readonly exampleId: string;
  readonly exportGeometry: (format: FileExtension) => void;
  readonly isExportEnabled: boolean;
  readonly isExporting: boolean;
  readonly isPrimary: boolean;
};

type ActorSubscription = {
  readonly unsubscribe: () => void;
};

function issueMessage(errors: ReadonlyArray<{ readonly message?: unknown }>): string {
  const message = errors[0]?.message;
  return typeof message === 'string' ? message : 'Export failed';
}

function PlaygroundExportControls({
  exampleId,
  formats,
}: {
  readonly exampleId: string;
  readonly formats: readonly FileExtension[];
}): React.JSX.Element {
  const { cadRef, status, geometries } = useCadPreview();
  const [isExporting, setIsExporting] = useState(false);
  const isExportEnabled = status === 'ready' && geometries.length > 0 && !isExporting;
  const primaryFormat = formats[0];

  const exportGeometry = useCallback(
    (format: FileExtension) => {
      if (!isExportEnabled) {
        return;
      }

      setIsExporting(true);

      // oxlint-disable-next-line tau-lint/no-async-iife -- export completion is delivered through actor events.
      void (async () => {
        try {
          const blob = await new Promise<Blob>((resolve, reject) => {
            const subscriptions: ActorSubscription[] = [];

            const cleanup = () => {
              for (const subscription of subscriptions) {
                subscription.unsubscribe();
              }
            };

            subscriptions.push(
              cadRef.on('geometryExported', (event) => {
                cleanup();
                resolve(event.blob);
              }),
              cadRef.on('exportFailed', (event) => {
                cleanup();
                reject(new Error(issueMessage(event.errors)));
              }),
            );

            cadRef.send({ type: 'exportGeometry', format });
          });

          const filename = `${exampleId}.${format}`;
          downloadBlob(blob, filename);
          toast.success(`Downloaded ${filename}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Export failed';
          toast.error(`Failed to export: ${message}`);
        } finally {
          setIsExporting(false);
        }
      })();
    },
    [cadRef, isExportEnabled, exampleId],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F7' && primaryFormat) {
        event.preventDefault();
        exportGeometry(primaryFormat);
      }
    };

    globalThis.addEventListener('keydown', handleKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', handleKeyDown);
    };
  }, [exportGeometry, primaryFormat]);

  return (
    <>
      {formats.map((format, index) => (
        <PlaygroundExportButton
          key={format}
          format={format}
          exampleId={exampleId}
          exportGeometry={exportGeometry}
          isExportEnabled={isExportEnabled}
          isExporting={isExporting}
          isPrimary={index === 0}
        />
      ))}
    </>
  );
}

function PlaygroundExportButton({
  format,
  exportGeometry,
  isExportEnabled,
  isExporting,
  isPrimary,
}: PlaygroundExportButtonProps): React.JSX.Element {
  const label = format.toUpperCase();

  const handleExport = useCallback(() => {
    exportGeometry(format);
  }, [exportGeometry, format]);

  return (
    <Button
      variant='outline'
      size='xs'
      disabled={!isExportEnabled}
      onClick={handleExport}
      title={isPrimary ? 'Export. Shortcut: F7' : undefined}
    >
      <Download className='size-3' />
      {isExporting ? '...' : label}
    </Button>
  );
}

function readInitialExampleId(): string {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return defaultExample.id;
  }

  const params = new URLSearchParams(browserWindow.location.search);
  const candidate = params.get('model') ?? params.get('example');
  if (candidate && playgroundExamples.some((example) => example.id === candidate)) {
    return candidate;
  }

  return defaultExample.id;
}

function buildExampleUrl(exampleId: string): string | undefined {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return undefined;
  }

  const url = new URL(browserWindow.location.href);
  url.searchParams.set('model', exampleId);
  url.searchParams.delete('example');
  return url.toString();
}

function writeExampleToUrl(exampleId: string, options: { readonly replace?: boolean } = {}): void {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return;
  }

  const url = buildExampleUrl(exampleId);
  if (!url) {
    return;
  }

  const current = `${browserWindow.location.pathname}${browserWindow.location.search}${browserWindow.location.hash}`;
  const nextUrl = new URL(url);
  const next = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  if (current === next) {
    return;
  }

  if (options.replace) {
    browserWindow.history.replaceState({}, '', url);
    return;
  }

  browserWindow.history.pushState({}, '', url);
}

function getBrowserWindow(): Window | undefined {
  const maybeGlobal = globalThis as typeof globalThis & { readonly window?: Window };
  return maybeGlobal.window;
}

function PreviewSummary(): React.JSX.Element {
  const { status, geometries, error, defaultParameters } = useCadPreview();
  const parameterCount = Object.keys(defaultParameters).length;

  if (error) {
    return <span className='truncate text-xs text-destructive'>{error.message}</span>;
  }

  return (
    <span className='truncate text-xs text-muted-foreground'>
      {status} · {geometries.length} geometries · {parameterCount} parameters
    </span>
  );
}

function EditorFallback({ value, onChange }: EditorFallbackProps): React.JSX.Element {
  return (
    <textarea
      className='size-full resize-none bg-background p-4 font-mono text-sm leading-6 outline-none'
      spellCheck={false}
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}
