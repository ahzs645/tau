import type { RefCallback } from 'react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Braces, Eye, Laptop, LayoutGrid, Moon, Play, RotateCcw, Share2, Sun } from 'lucide-react';
import { toast } from '#components/ui/sonner.js';
import type { Geometry } from '@taucad/types';
import { Button, buttonVariants } from '#components/ui/button.js';
import { ClientOnly } from '#components/ui/utils/client-only.js';
import { useFeature } from '#flags/use-feature.js';
import { useTheme } from '#hooks/use-theme.js';
import { FileManagerProvider } from '#hooks/use-file-manager.js';
import { loadPlaygroundExample, playgroundExamples } from '#routes/playground/playground-examples.js';
import type { PlaygroundExample, PlaygroundVariant } from '#routes/playground/playground-examples.js';
import { isProjectExampleId } from '#routes/playground/projects.js';
import { PlaygroundPreviewPane, playgroundPreviewCapabilities } from '#routes/playground/playground-preview.js';
import type { PlaygroundMobilePane } from '#routes/playground/playground-preview.js';
import { playgroundShareCodec } from '#routes/playground/share-codec.js';
import { encodeTextFile } from '#utils/filesystem.utils.js';
import { cn } from '#utils/ui.utils.js';
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

/** Query parameter that carries the encoded parameter overrides on a shared link. */
const shareParametersKey = 'p';

/** Query parameter that selects a non-default kernel variant of a project. */
const variantKey = 'variant';

/** Stable empty record so consumers can rely on referential equality when there are no overrides. */
const emptyParameters: Record<string, unknown> = Object.freeze({});

/** Bound the in-memory preview cache to a few recent model/variant/code/parameter combinations. */
const maxPreviewGeometryCacheEntries = 8;

/**
 * Web-share codec: stores the parameter delta in a compact, URL-safe token
 * (`1.raw.<base64url>`). Kept local so the static Pages build does not pull the
 * full json-url codec graph, whose optional Node compression branches have
 * triggered intermittent Rolldown transform stalls in CI.
 */
const shareCodec = playgroundShareCodec;

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

function cloneGltfContent(content: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(content.byteLength);
  copy.set(content);
  return copy;
}

function cloneCacheableGeometry(geometry: Geometry): Geometry | undefined {
  switch (geometry.format) {
    case 'gltf': {
      return { ...geometry, content: cloneGltfContent(geometry.content) };
    }

    case 'svg': {
      return { ...geometry, paths: [...geometry.paths] };
    }

    case 'webrtc': {
      return undefined;
    }
  }
}

function cloneCacheableGeometries(geometries: readonly Geometry[]): Geometry[] | undefined {
  const cloned: Geometry[] = [];
  for (const geometry of geometries) {
    const copy = cloneCacheableGeometry(geometry);
    if (!copy) {
      return undefined;
    }
    cloned.push(copy);
  }

  return cloned.length > 0 ? cloned : undefined;
}

function buildPreviewGeometryCacheKey({
  activeRenderIdentity,
  mainFile,
  parameters,
  previewValue,
}: {
  readonly activeRenderIdentity: string;
  readonly mainFile: string;
  readonly parameters: Record<string, unknown>;
  readonly previewValue: string;
}): string {
  return canonicalize({
    activeRenderIdentity,
    mainFile,
    parameters,
    previewValue,
  });
}

function cachePreviewGeometries(
  cache: Map<string, Geometry[]>,
  cacheKey: string,
  geometries: readonly Geometry[],
): void {
  const cloned = cloneCacheableGeometries(geometries);
  if (!cloned) {
    return;
  }

  cache.delete(cacheKey);
  cache.set(cacheKey, cloned);

  while (cache.size > maxPreviewGeometryCacheEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    cache.delete(oldestKey);
  }
}

function readCachedPreviewGeometries(cache: Map<string, Geometry[]>, cacheKey: string): Geometry[] | undefined {
  const cached = cache.get(cacheKey);
  return cached ? cloneCacheableGeometries(cached) : undefined;
}

/** The parameter pane emits override deltas; an empty record means "use defaults." */
function hasParameterOverrides(parameters: Record<string, unknown>, baseline: Record<string, unknown>): boolean {
  return Object.keys(parameters).length > 0 && !sameParameters(parameters, baseline);
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
  const activeExampleId = readInitialExampleIdFromSearch(new URLSearchParams(location.search), loaderExampleId);
  const catalogExample = playgroundExamples.find((example) => example.id === activeExampleId) ?? defaultExample;
  const [loadedExample, setLoadedExample] = useState<PlaygroundExample | undefined>(() =>
    isProjectExampleId(activeExampleId) && catalogExample.mode !== 'static' ? undefined : catalogExample,
  );
  const [loadError, setLoadError] = useState<Error | undefined>();

  useEffect(() => {
    if (!isProjectExampleId(activeExampleId) || catalogExample.mode === 'static') {
      setLoadedExample(catalogExample);
      setLoadError(undefined);
      return;
    }

    let cancelled = false;
    setLoadedExample(undefined);
    setLoadError(undefined);
    const loadSelectedExample = async (): Promise<void> => {
      try {
        const example = await loadPlaygroundExample(activeExampleId);
        if (!cancelled) {
          setLoadedExample(example);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };
    void loadSelectedExample();

    return () => {
      cancelled = true;
    };
  }, [activeExampleId, catalogExample]);

  if (loadError) {
    return (
      <main className='flex h-dvh items-center justify-center bg-background p-6 text-foreground'>
        <p className='max-w-lg text-sm text-destructive'>{loadError.message}</p>
      </main>
    );
  }

  if (!loadedExample || loadedExample.id !== activeExampleId) {
    return (
      <main className='flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground'>
        Loading model…
      </main>
    );
  }

  const playground = <PlaygroundLoaded key={loadedExample.id} baseExample={loadedExample} />;
  if (loadedExample.mode === 'static') {
    return playground;
  }

  return (
    <FileManagerProvider rootDirectory='/' initialBackend='indexeddb'>
      {playground}
    </FileManagerProvider>
  );
}

function PlaygroundLoaded({ baseExample }: { readonly baseExample: PlaygroundExample }): React.JSX.Element {
  const location = useLocation();
  // Non-default kernel variant of the active project (e.g. the OpenCASCADE port of an
  // OpenSCAD original). Seeded undefined for hydration parity with the static prerender;
  // the `location.search` effect below applies any `?variant=` from the URL after mount.
  const [activeVariantId, setActiveVariantId] = useState<PlaygroundVariant['id'] | undefined>(undefined);
  const [editorValue, setEditorValue] = useState(baseExample.code);
  const [previewValue, setPreviewValue] = useState(baseExample.code);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [isCodeVisible, setIsCodeVisible] = useState(false);
  // Mobile only: which pane the segmented tabs show (the 3D viewer or the parameters).
  // On xl+ both render side by side and this is ignored.
  const [mobilePane, setMobilePane] = useState<PlaygroundMobilePane>('3d');
  const [exportControlsElement, setExportControlsElement] = useState<HTMLDivElement | undefined>(undefined);

  // Live parameter overrides reported up from inside the preview provider (the Share button lives in
  // the header, outside the provider). Empty until something is changed away from the example baseline.
  const [liveParameters, setLiveParameters] = useState<Record<string, unknown>>(emptyParameters);
  // Overrides decoded from a shared `?p=` token, applied to the preview once the kernel is ready.
  const [pendingParameters, setPendingParameters] = useState<Record<string, unknown> | undefined>(undefined);

  // Kiosk / viewer-only mode: hide the editor and its toggle entirely.
  const isCodeEditorDisabled = useIsCodeEditorDisabled(location.search);

  const { activeVariant, activeRenderIdentity, projectIdSuffix } = resolveActiveVariant(baseExample, activeVariantId);
  const activeExample = useMemo(() => applyVariant(baseExample, activeVariant), [baseExample, activeVariant]);
  const isEditableExample = activeExample.mode !== 'static';
  const showCodeControls = isEditableExample && !isCodeEditorDisabled;
  const showCodeSection = isCodeVisible && showCodeControls;
  const staticPreviewUrl = activeExample.staticPreview?.glb;
  const activePreviewParameters = useMemo(() => {
    if (Object.keys(liveParameters).length > 0) {
      return liveParameters;
    }

    return activeExample.initialParameters ?? emptyParameters;
  }, [activeExample.initialParameters, liveParameters]);
  const previewGeometryCacheRef = useRef(new Map<string, Geometry[]>());
  const previewGeometryCacheKey = useMemo(
    () =>
      buildPreviewGeometryCacheKey({
        activeRenderIdentity,
        mainFile: activeExample.mainFile,
        parameters: activePreviewParameters,
        previewValue,
      }),
    [activeExample.mainFile, activePreviewParameters, activeRenderIdentity, previewValue],
  );
  const cachedPreviewGeometries = readCachedPreviewGeometries(previewGeometryCacheRef.current, previewGeometryCacheKey);
  const handlePreviewGeometriesReady = useCallback(
    (geometries: readonly Geometry[]) => {
      cachePreviewGeometries(previewGeometryCacheRef.current, previewGeometryCacheKey, geometries);
    },
    [previewGeometryCacheKey],
  );
  // The variant is part of the project id so each variant gets its own IndexedDB
  // filesystem namespace and the preview provider remounts into a clean kernel.
  const previewProjectId = `root-playground-${activeExample.id}${projectIdSuffix}`;
  const previewRenderKey = `${previewProjectId}-${previewVersion}`;
  const showParameterPane = isEditableExample && playgroundPreviewCapabilities.parameters;
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
    if (!isEditableExample) {
      return;
    }

    setPreviewValue(editorValue);
    setPreviewVersion((version) => version + 1);
  }, [editorValue, isEditableExample]);

  const resetExample = useCallback(() => {
    if (!isEditableExample) {
      return;
    }

    setEditorValue(activeExample.code);
    setPreviewValue(activeExample.code);
    setPreviewVersion((version) => version + 1);
  }, [activeExample, isEditableExample]);

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
    const hasParameterChanges = hasParameterOverrides(liveParameters, baseline);

    // oxlint-disable-next-line tau-lint/no-async-iife -- clipboard writes are event-driven and report via toast.
    void (async () => {
      try {
        const url = new URL(browserWindow.location.href);
        url.searchParams.set('model', activeExample.id);
        url.searchParams.delete('example');
        if (activeVariant) {
          url.searchParams.set(variantKey, activeVariant.id);
        } else {
          url.searchParams.delete(variantKey);
        }

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
  }, [activeExample.id, activeExample.initialParameters, activeVariant, liveParameters]);

  const switchVariant = useCallback(
    (variantId: PlaygroundVariant['id']) => {
      const target = baseExample.variants?.find((variant) => variant.id === variantId);
      if (!target || variantId === (activeVariant?.id ?? defaultVariantIdFor(baseExample))) {
        return;
      }

      setActiveVariantId(target.isDefault ? undefined : target.id);
      // Both the live overrides and any shared token belong to the previous variant's
      // parameter schema, so a switch starts from the new variant's defaults.
      setLiveParameters(emptyParameters);
      setPendingParameters(undefined);
      writeVariantSwitchToUrl(baseExample.id, target);
    },
    [activeVariant, baseExample],
  );

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    setActiveVariantId(readVariantIdFromSearch(params, baseExample));
  }, [baseExample, location.search]);

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
  const loadedExampleIdRef = useRef(activeRenderIdentity);
  useEffect(() => {
    if (loadedExampleIdRef.current === activeRenderIdentity) {
      return;
    }

    loadedExampleIdRef.current = activeRenderIdentity;
    setEditorValue(activeExample.code);
    setPreviewValue(activeExample.code);
    setPreviewVersion((version) => version + 1);
  }, [activeExample, activeRenderIdentity]);

  useEffect(() => {
    const currentExampleId = readInitialExampleIdFromSearch(new URLSearchParams(location.search));
    if (currentExampleId !== activeExample.id) {
      return;
    }

    writeExampleToUrl(activeExample.id, { replace: true, variantId: activeVariant?.id });
  }, [activeExample.id, activeVariant, location.search]);

  // Keep the address bar's `?p=` token in sync with live parameter edits: add/update it when the
  // overrides differ from the example baseline, remove it when they match. Written via raw
  // history.replaceState so it does not re-trigger the loader or the decode effect above.
  const urlSyncHydratedRef = useRef(false);
  const urlSyncModelRef = useRef(activeRenderIdentity);
  const urlSyncInitialTokenRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const browserWindow = getBrowserWindow();
    if (!browserWindow) {
      return;
    }

    // Restart hydration gating whenever the active model or variant changes — a `?p=`
    // token captured against one variant's parameter schema is meaningless in the other.
    if (urlSyncModelRef.current !== activeRenderIdentity) {
      urlSyncModelRef.current = activeRenderIdentity;
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
    const hasParameterChanges = hasParameterOverrides(liveParameters, baseline);

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
  }, [liveParameters, activeExample.id, activeExample.initialParameters, activeRenderIdentity]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!showCodeControls) {
        return;
      }

      if (event.key === 'F5' || ((event.metaKey || event.ctrlKey) && event.key === 'Enter')) {
        event.preventDefault();
        runPreview();
      }
    };

    globalThis.addEventListener('keydown', handleKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', handleKeyDown);
    };
  }, [showCodeControls, runPreview]);

  // Primary actions (Share, plus Code/Reset/Run in code mode) live in the header at every
  // breakpoint, next to the model name. The mobile bottom bar keeps only the pane switcher.
  const actionButtons = (
    <>
      <VariantToggle example={baseExample} activeVariant={activeVariant} onSwitch={switchVariant} />
      {showCodeControls ? (
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
      ) : null}
      <Button variant='outline' size='sm' onClick={copyShareLink}>
        <Share2 className='size-3.5' />
        Share
      </Button>
      {/* Run/Reset only matter in code mode — parameter changes apply live without them. */}
      {showCodeControls ? (
        <>
          <Button variant='outline' size='sm' onClick={resetExample}>
            <RotateCcw className='size-3.5' />
            Reset
          </Button>
          <Button size='sm' onClick={runPreview}>
            <Play className='size-3.5' />
            Run
          </Button>
        </>
      ) : null}
    </>
  );

  return (
    <main className='flex h-dvh flex-col overflow-hidden bg-background text-foreground'>
      <header className='flex min-h-14 flex-wrap items-center justify-between gap-3 border-b px-4 py-3 md:px-5'>
        <div className='flex min-w-0 items-center gap-3'>
          <div className='min-w-0'>
            <h1 className='truncate text-base font-semibold'>{activeExample.name}</h1>
          </div>
        </div>
        <div className='flex items-center gap-2'>
          <PlaygroundThemeButton />
          <Link to='/' aria-label='Gallery' className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <LayoutGrid className='size-3.5' />
            {/* Icon-only on phones so the header stays within a thumb-width; labelled on md+. */}
            <span className='max-md:hidden'>Gallery</span>
          </Link>
          {/* Desktop export lives in the header; on mobile it moves onto the 3D viewer (below). */}
          <div ref={setExportControlsRef} className='flex items-center gap-1.5 max-xl:hidden' />
          {actionButtons}
        </div>
      </header>

      <div
        className={cn(
          // Mobile: stack as a flex column so the active pane fills the screen.
          // xl+: restore the original side-by-side grid (viewer + parameters).
          'flex min-h-0 flex-1 flex-col xl:grid',
          showParameterPane ? 'xl:grid-cols-[minmax(520px,1fr)_360px]' : 'xl:grid-cols-1',
        )}
      >
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

        <PlaygroundPreviewPane
          activeExample={activeExample}
          cachedGeometries={cachedPreviewGeometries}
          files={files}
          pendingParameters={pendingParameters}
          previewGeometryCacheKey={previewGeometryCacheKey}
          previewProjectId={previewProjectId}
          previewRenderKey={previewRenderKey}
          staticPreviewUrl={staticPreviewUrl}
          mobilePane={mobilePane}
          exportControlsElement={exportControlsElement}
          onGeometriesReady={handlePreviewGeometriesReady}
          onParametersChange={setLiveParameters}
        />
      </div>

      {/* Mobile bottom chrome: the pane switcher (below xl) anchors to the bottom of the screen,
          within thumb reach. Static examples have no panes, so the bar is editable-only. */}
      {showParameterPane ? (
        <nav className='shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)] xl:hidden'>
          <div className='flex'>
            <button
              type='button'
              aria-pressed={mobilePane === '3d'}
              className={cn(
                'flex-1 border-t-2 py-2.5 text-sm font-medium transition-colors',
                mobilePane === '3d' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground',
              )}
              onClick={() => {
                setMobilePane('3d');
              }}
            >
              3D View
            </button>
            <button
              type='button'
              aria-pressed={mobilePane === 'params'}
              className={cn(
                'flex-1 border-t-2 py-2.5 text-sm font-medium transition-colors',
                mobilePane === 'params' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground',
              )}
              onClick={() => {
                setMobilePane('params');
              }}
            >
              Parameters
            </button>
          </div>
        </nav>
      ) : null}
    </main>
  );
}

function PlaygroundThemeButton(): React.JSX.Element {
  const { themeWithSystem, currentOption, cycleTheme } = useTheme();

  return (
    <Button
      variant='outline'
      size='sm'
      className='group relative size-8 overflow-hidden p-0'
      data-theme={themeWithSystem ?? 'system'}
      aria-label={`Switch theme, currently ${currentOption.name}`}
      title={`Theme: ${currentOption.name}`}
      onClick={cycleTheme}
    >
      <Sun className='size-3.5 origin-right -translate-x-[400%] rotate-[-180deg] transition-transform duration-500 group-data-[theme=light]:translate-x-0 group-data-[theme=light]:rotate-0' />
      <Moon className='absolute size-3.5 origin-left translate-x-[400%] rotate-[180deg] transition-transform duration-500 group-data-[theme=dark]:translate-x-0 group-data-[theme=dark]:rotate-0' />
      <Laptop className='absolute size-3.5 origin-top translate-y-[400%] transition-transform duration-500 group-data-[theme=system]:translate-y-0' />
    </Button>
  );
}

/**
 * True when the code editor should be hidden. The playground is parameter-first, so
 * the editor is hidden by default; `?editor=on|1|true` opts a single visit into code
 * mode (embeds and shared links included). The `disableCodeEditor` flag force-hides
 * it for whole deployments regardless of the URL.
 */
function useIsCodeEditorDisabled(search: string): boolean {
  const isDisabledByFlag = useFeature('disableCodeEditor');
  const editorParameter = new URLSearchParams(search).get('editor')?.toLowerCase();
  const isEnabledByParameter = editorParameter === 'on' || editorParameter === '1' || editorParameter === 'true';
  return isDisabledByFlag || !isEnabledByParameter;
}

function readInitialExampleIdFromSearch(params: URLSearchParams, fallbackId = defaultExample.id): string {
  const candidate = params.get('model') ?? params.get('example');
  if (candidate && playgroundExamples.some((example) => example.id === candidate)) {
    return candidate;
  }

  return playgroundExamples.some((example) => example.id === fallbackId) ? fallbackId : defaultExample.id;
}

/** Resolve `?variant=` to a non-default variant of the example, or undefined for the default. */
function readVariantIdFromSearch(
  params: URLSearchParams,
  example: PlaygroundExample,
): PlaygroundVariant['id'] | undefined {
  const candidate = params.get(variantKey);
  if (!candidate) {
    return undefined;
  }

  const match = example.variants?.find((variant) => variant.id === candidate);
  return match && !match.isDefault ? match.id : undefined;
}

function defaultVariantIdFor(example: PlaygroundExample): PlaygroundVariant['id'] | undefined {
  return example.variants?.find((variant) => variant.isDefault)?.id;
}

type ResolvedVariant = {
  readonly activeVariant: PlaygroundVariant | undefined;
  /** Distinguishes reloads across both project and variant switches (editor code + URL sync gating). */
  readonly activeRenderIdentity: string;
  readonly projectIdSuffix: string;
};

function resolveActiveVariant(
  example: PlaygroundExample,
  activeVariantId: PlaygroundVariant['id'] | undefined,
): ResolvedVariant {
  const activeVariant = example.variants?.find((variant) => variant.id === activeVariantId && !variant.isDefault);
  return {
    activeVariant,
    activeRenderIdentity: `${example.id}::${activeVariant?.id ?? 'default'}`,
    projectIdSuffix: activeVariant ? `-${activeVariant.id}` : '',
  };
}

/**
 * Push the post-switch URL: the variant param reflects the new selection and
 * any `?p=` token is dropped — it encoded the previous variant's parameters.
 */
function writeVariantSwitchToUrl(exampleId: string, target: PlaygroundVariant): void {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return;
  }

  const url = new URL(browserWindow.location.href);
  url.searchParams.set('model', exampleId);
  url.searchParams.delete('example');
  url.searchParams.delete(shareParametersKey);
  if (target.isDefault) {
    url.searchParams.delete(variantKey);
  } else {
    url.searchParams.set(variantKey, target.id);
  }

  browserWindow.history.pushState({}, '', url.toString());
}

/**
 * Materialize a non-default variant as the effective example: the variant's entry
 * file drives the editor, kernel selection, and export formats. Presets and initial
 * parameters are dropped — they are authored against the default variant's schema.
 */
function applyVariant(example: PlaygroundExample, variant: PlaygroundVariant | undefined): PlaygroundExample {
  if (!variant) {
    return example;
  }

  const { initialParameters: _initialParameters, presets: _presets, ...rest } = example;
  return {
    ...rest,
    kernel: variant.kernel,
    mainFile: variant.mainFile,
    language: variant.language,
    exportFormats: variant.exportFormats,
    ...(variant.renderTimeout ? { renderTimeout: variant.renderTimeout } : {}),
    ...(typeof variant.showPreviewLines === 'boolean' ? { showPreviewLines: variant.showPreviewLines } : {}),
    ...(variant.renderOptions ? { renderOptions: variant.renderOptions } : {}),
    code: example.sourceFiles?.[variant.mainFile] ?? example.code,
  };
}

function buildExampleUrl(exampleId: string, variantId?: PlaygroundVariant['id']): string | undefined {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return undefined;
  }

  const url = new URL(browserWindow.location.href);
  url.searchParams.set('model', exampleId);
  url.searchParams.delete('example');
  if (variantId) {
    url.searchParams.set(variantKey, variantId);
  } else {
    url.searchParams.delete(variantKey);
  }

  return url.toString();
}

function writeExampleToUrl(
  exampleId: string,
  options: { readonly replace?: boolean; readonly variantId?: PlaygroundVariant['id'] } = {},
): void {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return;
  }

  const url = buildExampleUrl(exampleId, options.variantId);
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

type VariantToggleProps = {
  readonly example: PlaygroundExample;
  readonly activeVariant: PlaygroundVariant | undefined;
  readonly onSwitch: (variantId: PlaygroundVariant['id']) => void;
};

/**
 * Kernel variant switcher — only projects that ship more than one
 * implementation (e.g. an OpenSCAD original plus an OpenCASCADE port)
 * render the segmented control.
 */
function VariantToggle({ example, activeVariant, onSwitch }: VariantToggleProps): React.JSX.Element | undefined {
  if (!example.variants || example.variants.length < 2) {
    return undefined;
  }

  const selectedVariantId = activeVariant?.id ?? defaultVariantIdFor(example);
  return (
    <div role='group' aria-label='Kernel variant' className='flex items-center overflow-hidden rounded-md border'>
      {example.variants.map((variant) => (
        <button
          key={variant.id}
          type='button'
          aria-pressed={variant.id === selectedVariantId}
          className={cn(
            'px-2.5 py-1.5 text-xs font-medium transition-colors',
            variant.id === selectedVariantId
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => {
            onSwitch(variant.id);
          }}
        >
          {variant.label}
        </button>
      ))}
    </div>
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
