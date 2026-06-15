import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Box, Braces, Download, Eye, LayoutGrid, Play, RotateCcw, Share2, SlidersHorizontal } from 'lucide-react';
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
import type { Handle } from '#types/matches.types.js';
import type { Route } from './+types/route.js';

const CodeEditorLazy = lazy(async () => {
  const module = await import('#components/code/code-editor.client.js');
  return { default: module.CodeEditor };
});

type EditorFallbackProps = {
  readonly value: string;
  readonly onChange: (value: string) => void;
};

const defaultExample: PlaygroundExample = playgroundExamples[0]!;

export const handle: Handle = {
  enablePageWrapper: false,
};

export function loader({ request }: Route.LoaderArgs): { activeExampleId: string } {
  return {
    activeExampleId: readInitialExampleIdFromSearch(new URL(request.url).searchParams),
  };
}

export default function PlaygroundRoot(props: Partial<Route.ComponentProps> = {}): React.JSX.Element {
  const location = useLocation();
  const loaderExampleId = props.loaderData?.activeExampleId ?? defaultExample.id;
  const [activeExampleId, setActiveExampleId] = useState(loaderExampleId);
  const initialExample = playgroundExamples.find((example) => example.id === activeExampleId) ?? defaultExample;
  const [editorValue, setEditorValue] = useState(initialExample.code);
  const [previewValue, setPreviewValue] = useState(initialExample.code);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [isCodeVisible, setIsCodeVisible] = useState(false);

  const activeExample = playgroundExamples.find((example) => example.id === activeExampleId) ?? defaultExample;
  const previewProjectId = `root-playground-${activeExample.id}-${previewVersion}`;
  const isDirty = editorValue !== activeExample.code;
  const hasUnrunChanges = editorValue !== previewValue;

  const files = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(activeExample.sourceFiles ?? { [activeExample.mainFile]: previewValue }).map(
          ([path, content]) => [
            path,
            {
              content: encodeTextFile(path === activeExample.mainFile ? previewValue : content),
            },
          ],
        ),
      ),
    [activeExample.mainFile, activeExample.sourceFiles, previewValue],
  );

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
    const searchExampleId = readInitialExampleIdFromSearch(new URLSearchParams(location.search));
    setActiveExampleId(searchExampleId);
  }, [loaderExampleId, location.search]);

  useEffect(() => {
    const currentExampleId = readInitialExampleIdFromSearch(new URLSearchParams(location.search));
    if (currentExampleId !== activeExample.id) {
      return;
    }

    writeExampleToUrl(activeExample.id, { replace: true });
  }, [activeExample.id, location.search]);

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
    <main className='flex h-dvh flex-col overflow-hidden bg-background text-foreground'>
      <header className='flex min-h-14 flex-wrap items-center justify-between gap-3 border-b px-4 py-3 md:px-5'>
        <div className='flex min-w-0 items-center gap-3'>
          <div className='flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted'>
            <Box className='size-4' />
          </div>
          <div className='min-w-0'>
            <h1 className='truncate text-base font-semibold'>Tau CAD Playground</h1>
            <p className='truncate text-xs text-muted-foreground'>
              {activeExample.name} · {activeExample.kernel}
            </p>
          </div>
        </div>
        <div className='flex items-center gap-2'>
          <Link to='/gallery' className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <LayoutGrid className='size-3.5' />
            Gallery
          </Link>
          <Button
            variant={isCodeVisible ? 'default' : 'outline'}
            size='sm'
            aria-pressed={isCodeVisible}
            onClick={() => {
              setIsCodeVisible((visible) => !visible);
            }}
          >
            <Eye className='size-3.5' />
            Code
          </Button>
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

      <div className='grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(520px,1fr)_360px]'>
        {isCodeVisible ? (
          <section className='flex min-h-[42dvh] min-w-0 flex-col border-b xl:col-span-2 xl:min-h-[34dvh]'>
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
        ) : null}

        <SharedWorkerGate>
          <FileManagerProvider
            key={previewProjectId}
            projectId={previewProjectId}
            rootDirectory={`/projects/${previewProjectId}`}
            initialBackend='indexeddb'
          >
            <CadPreviewProvider
              projectId={previewProjectId}
              mainFile={activeExample.mainFile}
              files={files}
              parameters={activeExample.initialParameters}
            >
              <section className='flex min-h-[56dvh] min-w-0 flex-col xl:min-h-0 xl:border-r'>
                <div className='flex h-11 items-center justify-between border-b px-3'>
                  <div className='flex items-center gap-2'>
                    <SlidersHorizontal className='size-4 text-muted-foreground' />
                    <PreviewSummary />
                  </div>
                  <div className='flex items-center gap-1.5'>
                    <PlaygroundExportControls exampleId={activeExample.id} formats={activeExample.exportFormats} />
                  </div>
                </div>
                <div className='relative min-h-0 flex-1 bg-muted/30'>
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
              </section>

              <section className='flex min-h-[260px] min-w-0 flex-col border-t bg-background xl:min-h-0 xl:border-t-0'>
                <PlaygroundParameters presets={activeExample.presets ?? []} />
              </section>
            </CadPreviewProvider>
          </FileManagerProvider>
        </SharedWorkerGate>
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

function readInitialExampleIdFromSearch(params: URLSearchParams): string {
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
  const maybeGlobal = globalThis as typeof globalThis & {
    readonly window?: Window;
  };
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
