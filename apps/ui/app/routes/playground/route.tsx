import type { ReactNode, RefCallback } from 'react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router';
import {
  Braces,
  ChevronDown,
  Download,
  Eye,
  LayoutGrid,
  Play,
  RotateCcw,
  Share2,
  SlidersHorizontal,
} from 'lucide-react';
import jsonUrl from '@firstform/json-url';
import type { FileExtension } from '@taucad/types';
import { downloadBlob } from '@taucad/utils/file';
import { toast } from '#components/ui/sonner.js';
import { CadPreviewStatus, CadPreviewViewer } from '#components/cad-preview.js';
import { Button, buttonVariants } from '#components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.js';
import { ClientOnly } from '#components/ui/utils/client-only.js';
import { FileManagerProvider, SharedWorkerGate } from '#hooks/use-file-manager.js';
import { CadPreviewProvider, useCadPreview } from '#hooks/use-cad-preview.js';
import { playgroundPreviewKernelOptions } from '#constants/kernel-options.presets.js';
import { useFeature } from '#flags/use-feature.js';
import { playgroundExamples } from '#routes/playground/playground-examples.js';
import type { PlaygroundExample, PlaygroundPreset } from '#routes/playground/playground-examples.js';
import { PreviewParameters } from '#routes/projects_.$id_.preview/preview-parameters.js';
import { encodeTextFile } from '#utils/filesystem.utils.js';
import type { Handle } from '#types/matches.types.js';
// oxlint-disable-next-line import/extensions -- React Router typegen resolves this virtual route module.
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

/** Query parameter that carries the json-url-encoded parameter overrides on a shared link. */
const shareParametersKey = 'p';

/** Stable empty record so consumers can rely on referential equality when there are no overrides. */
const emptyParameters: Record<string, unknown> = Object.freeze({});

/**
 * Web-share codec (json-url): compresses the parameter delta into a compact, URL-safe token
 * (e.g. `1.raw.<base64>`), auto-upgrading to gzip/brotli/lz-string for larger payloads. The token
 * is self-describing, so decoding auto-detects the codec.
 */
const shareCodec = jsonUrl.createWebShareEngine<Record<string, unknown>>();

/** Canonical, key-order-independent serialization used to compare parameter sets. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
  }

  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return 'null';
  }

  return JSON.stringify(value);
}

/** True when two parameter records are deeply equal regardless of key order. */
function sameParameters(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return canonicalize(a) === canonicalize(b);
}

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
  const [exportControlsElement, setExportControlsElement] = useState<HTMLDivElement | undefined>(undefined);

  // Live parameter overrides reported up from inside the preview provider (the Share button lives in
  // the header, outside the provider). Empty until something is changed away from the example baseline.
  const [liveParameters, setLiveParameters] = useState<Record<string, unknown>>(emptyParameters);
  // Overrides decoded from a shared `?p=` token, applied to the preview once the kernel is ready.
  const [pendingParameters, setPendingParameters] = useState<Record<string, unknown> | undefined>(undefined);

  // Kiosk / viewer-only mode: hide the editor and its toggle entirely.
  const isCodeEditorDisabled = useFeature('disableCodeEditor');
  const showCodeSection = isCodeVisible && !isCodeEditorDisabled;

  const activeExample = playgroundExamples.find((example) => example.id === activeExampleId) ?? defaultExample;
  const previewProjectId = `root-playground-${activeExample.id}`;
  const previewRenderKey = `${previewProjectId}-${previewVersion}`;
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

  const setExportControlsRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setExportControlsElement(node ?? undefined);
  }, []);

  const copyShareLink = useCallback(() => {
    const browserWindow = getBrowserWindow();
    if (!browserWindow) {
      return;
    }

    // "Changes" means the live overrides differ from the example's own baseline parameters — so loading
    // an example and sharing it without touching anything yields the same plain link as before.
    const baseline = activeExample.initialParameters ?? emptyParameters;
    const hasParameterChanges = !sameParameters(liveParameters, baseline);

    // oxlint-disable-next-line tau-lint/no-async-iife -- clipboard writes are event-driven and report via toast.
    void (async () => {
      try {
        const url = new URL(browserWindow.location.href);
        url.searchParams.set('model', activeExample.id);
        url.searchParams.delete('example');

        if (hasParameterChanges) {
          // Encode only the changed parameters (the delta) into a compact, URL-safe token.
          url.searchParams.set(shareParametersKey, await shareCodec.compress(liveParameters));
        } else {
          url.searchParams.delete(shareParametersKey);
        }

        await browserWindow.navigator.clipboard.writeText(url.toString());
        toast.success(hasParameterChanges ? 'Playground link copied with your changes' : 'Playground link copied');
      } catch {
        toast.error('Unable to copy playground link');
      }
    })();
  }, [activeExample.id, activeExample.initialParameters, liveParameters]);

  useEffect(() => {
    const searchExampleId = readInitialExampleIdFromSearch(new URLSearchParams(location.search));
    setActiveExampleId(searchExampleId);
  }, [loaderExampleId, location.search]);

  // Decode any `?p=` token from the URL into the overrides that should be applied to the preview.
  useEffect(() => {
    const token = new URLSearchParams(location.search).get(shareParametersKey);
    if (!token) {
      setPendingParameters(undefined);
      return;
    }

    let cancelled = false;
    // oxlint-disable-next-line tau-lint/no-async-iife -- token decoding is async; a stale result is ignored on cleanup.
    void (async () => {
      const decoded = await shareCodec.tryDecompress(token, emptyParameters);
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- React effect cleanup can flip this while awaiting.
      if (cancelled) {
        return;
      }

      setPendingParameters(decoded);
    })();

    return () => {
      cancelled = true;
    };
  }, [location.search]);

  // The static prerender bakes the default example into the loader data, so the editor and
  // preview start on the default code regardless of the `?model=` param. When the active
  // example changes (e.g. opening a project from the gallery), load its code into the editor
  // and preview so the rendered model matches the selected example.
  const loadedExampleIdRef = useRef(activeExample.id);
  useEffect(() => {
    if (loadedExampleIdRef.current === activeExample.id) {
      return;
    }

    loadedExampleIdRef.current = activeExample.id;
    setEditorValue(activeExample.code);
    setPreviewValue(activeExample.code);
    setPreviewVersion((version) => version + 1);
  }, [activeExample]);

  useEffect(() => {
    const currentExampleId = readInitialExampleIdFromSearch(new URLSearchParams(location.search));
    if (currentExampleId !== activeExample.id) {
      return;
    }

    writeExampleToUrl(activeExample.id, { replace: true });
  }, [activeExample.id, location.search]);

  // Keep the address bar's `?p=` token in sync with live parameter edits: add/update it when the
  // overrides differ from the example baseline, remove it when they match. Written via raw
  // history.replaceState so it does not re-trigger the loader or the decode effect above.
  const urlSyncHydratedRef = useRef(false);
  const urlSyncModelRef = useRef(activeExample.id);
  const urlSyncInitialTokenRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const browserWindow = getBrowserWindow();
    if (!browserWindow) {
      return;
    }

    // Restart hydration gating whenever the active model changes.
    if (urlSyncModelRef.current !== activeExample.id) {
      urlSyncModelRef.current = activeExample.id;
      urlSyncHydratedRef.current = false;
      urlSyncInitialTokenRef.current = undefined;
    }

    const params = new URLSearchParams(browserWindow.location.search);
    urlSyncInitialTokenRef.current ??= params.get(shareParametersKey) ?? undefined;

    // Only manage the token while this example is the one reflected in the URL.
    if (readInitialExampleIdFromSearch(params) !== activeExample.id) {
      return;
    }

    const baseline = activeExample.initialParameters ?? emptyParameters;
    const hasParameterChanges = !sameParameters(liveParameters, baseline);

    // On initial load from a shared link, wait until the decoded params are applied before touching
    // the URL — otherwise we would wipe the token before hydration completes.
    if (!urlSyncHydratedRef.current) {
      if (urlSyncInitialTokenRef.current && !hasParameterChanges) {
        return;
      }

      urlSyncHydratedRef.current = true;
    }

    let cancelled = false;
    // oxlint-disable-next-line tau-lint/no-async-iife -- compression is async; stale writes are dropped on cleanup.
    void (async () => {
      const token = hasParameterChanges ? await shareCodec.compress(liveParameters) : undefined;
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- React effect cleanup can flip this while awaiting.
      if (cancelled) {
        return;
      }

      const url = new URL(browserWindow.location.href);
      const existing = url.searchParams.get(shareParametersKey);
      if (token === undefined) {
        if (existing === null) {
          return;
        }

        url.searchParams.delete(shareParametersKey);
      } else {
        if (existing === token) {
          return;
        }

        url.searchParams.set(shareParametersKey, token);
      }

      browserWindow.history.replaceState({}, '', url.toString());
    })();

    return () => {
      cancelled = true;
    };
  }, [liveParameters, activeExample.id, activeExample.initialParameters]);

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
          <div className='min-w-0'>
            <h1 className='truncate text-base font-semibold'>Tau CAD Playground</h1>
            <p className='truncate text-xs text-muted-foreground'>
              {activeExample.name} · {activeExample.kernel}
            </p>
          </div>
        </div>
        <div className='flex items-center gap-2'>
          <Link to='/' className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <LayoutGrid className='size-3.5' />
            Gallery
          </Link>
          <div ref={setExportControlsRef} className='flex items-center gap-1.5' />
          {isCodeEditorDisabled ? null : (
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
          )}
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
        {showCodeSection ? (
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
              key={previewRenderKey}
              projectId={previewProjectId}
              mainFile={activeExample.mainFile}
              files={files}
              parameters={activeExample.initialParameters}
              kernelOptionsFactory={playgroundPreviewKernelOptions}
            >
              {exportControlsElement
                ? createPortal(
                    <PlaygroundExportControls
                      exampleId={activeExample.id}
                      formats={activeExample.exportFormats}
                      buttonSize='sm'
                    />,
                    exportControlsElement,
                  )
                : undefined}
              <PlaygroundParameterBridge pendingParameters={pendingParameters} onParametersChange={setLiveParameters} />
              <section className='flex min-h-[56dvh] min-w-0 flex-col xl:min-h-0 xl:border-r'>
                <div className='flex h-11 items-center justify-between border-b px-3'>
                  <div className='flex items-center gap-2'>
                    <SlidersHorizontal className='size-4 text-muted-foreground' />
                    <PreviewSummary />
                  </div>
                </div>
                <div className='relative min-h-0 flex-1 bg-muted/30'>
                  <CadPreviewViewer
                    className='size-full'
                    enablePan
                    enableZoom
                    staticPreviewUrl={activeExample.staticPreview?.glb}
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

/**
 * Bridges the preview's live parameter overrides out to the header (where the Share button lives,
 * outside the provider) and applies any overrides decoded from a shared `?p=` token once the kernel
 * is ready. Renders nothing.
 */
function PlaygroundParameterBridge({
  pendingParameters,
  onParametersChange,
}: {
  readonly pendingParameters: Record<string, unknown> | undefined;
  readonly onParametersChange: (parameters: Record<string, unknown>) => void;
}): ReactNode {
  const { parameters, setParameters, status } = useCadPreview();
  const liveParameters = parameters;

  // Surface the live overrides to the header so Share can encode them.
  useEffect(() => {
    onParametersChange(liveParameters);
  }, [liveParameters, onParametersChange]);

  // Apply decoded shared parameters exactly once per distinct token, after the kernel is ready.
  const appliedRef = useRef<Record<string, unknown> | undefined>(undefined);
  useEffect(() => {
    if (status !== 'ready' || !pendingParameters || appliedRef.current === pendingParameters) {
      return;
    }

    if (Object.keys(pendingParameters).length === 0) {
      return;
    }

    appliedRef.current = pendingParameters;
    setParameters(pendingParameters);
  }, [pendingParameters, status, setParameters]);

  return undefined;
}

function PlaygroundParameters({ presets }: { readonly presets: readonly PlaygroundPreset[] }): React.JSX.Element {
  return (
    <div className='flex h-full min-h-0 flex-col'>
      <PreviewParameters headerActions={presets.length > 0 ? <PlaygroundPresetMenu presets={presets} /> : undefined} />
    </div>
  );
}

function PlaygroundPresetMenu({ presets }: { readonly presets: readonly PlaygroundPreset[] }): React.JSX.Element {
  const { setParameters } = useCadPreview();

  const applyPreset = useCallback(
    (preset: PlaygroundPreset) => {
      setParameters(preset.parameters);
      toast.success(`Applied ${preset.name}`);
    },
    [setParameters],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant='ghost' size='xs' className='gap-1'>
          Presets
          <ChevronDown className='size-3.5' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        {presets.map((preset) => (
          <DropdownMenuItem
            key={preset.name}
            onSelect={() => {
              applyPreset(preset);
            }}
          >
            {preset.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  buttonSize = 'xs',
}: {
  readonly exampleId: string;
  readonly formats: readonly FileExtension[];
  readonly buttonSize?: 'xs' | 'sm';
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant='outline' size={buttonSize} disabled={!isExportEnabled} title='Export. Shortcut: F7'>
          <Download className='size-3' />
          {isExporting ? 'Exporting…' : 'Export'}
          <ChevronDown className='size-3 opacity-60' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        {formats.map((format) => (
          <DropdownMenuItem
            key={format}
            onSelect={() => {
              exportGeometry(format);
            }}
          >
            <Download className='size-3.5' />
            {format.toUpperCase()}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
