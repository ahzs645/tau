import type { RefCallback } from 'react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Braces, Eye, Laptop, LayoutGrid, Moon, Play, RotateCcw, Share2, Sun } from 'lucide-react';
import { toast } from '#components/ui/sonner.js';
import type { Geometry } from '@taucad/types';
import { Button, buttonVariants } from '#components/ui/button.js';
import { ClientOnly } from '#components/ui/utils/client-only.js';
import { useFeature } from '#flags/use-feature.js';
import { useTheme } from '#hooks/use-theme.js';
import { isGithubPagesBuild } from '#lib/deploy-target.js';
import { FileManagerProvider } from '#hooks/use-file-manager.js';
import { loadPlaygroundExample, playgroundExamples } from '#routes/playground/playground-examples.js';
import type {
  PlaygroundExample,
  PlaygroundVariant,
  PlaygroundUpload,
  PlaygroundUploadedFile,
} from '#routes/playground/playground-examples.js';
import { isProjectExampleId } from '#routes/playground/projects.js';
import { PlaygroundPreviewPane, playgroundPreviewCapabilities } from '#routes/playground/playground-preview.js';
import type { PlaygroundMobilePane } from '#routes/playground/playground-preview.js';
import {
  buildPlaygroundPreviewCacheKey,
  cachePlaygroundPreviewGeometries,
  createPlaygroundPreviewCache,
  haveSamePlaygroundParameters,
} from '#routes/playground/playground-preview-cache.js';
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

/**
 * Web-share codec: stores the parameter delta in a compact, URL-safe token
 * (`1.raw.<base64url>`). Kept local so the static Pages build does not pull the
 * full json-url codec graph, whose optional Node compression branches have
 * triggered intermittent Rolldown transform stalls in CI.
 */
const shareCodec = playgroundShareCodec;

/** The parameter pane emits override deltas; an empty record means "use defaults." */
function hasParameterOverrides(parameters: Record<string, unknown>, baseline: Record<string, unknown>): boolean {
  return Object.keys(parameters).length > 0 && !haveSamePlaygroundParameters(parameters, baseline);
}

type PlaygroundVariantSession = {
  readonly editorValue: string;
  readonly parameters: Record<string, unknown>;
  /** Files the viewer supplied, by the name they are written under in the preview filesystem. */
  readonly uploadedFiles: Record<string, PlaygroundUploadedFile>;
  readonly previewValue: string;
  readonly previewVersion: number;
};

function createVariantSession(example: PlaygroundExample): PlaygroundVariantSession {
  return {
    editorValue: example.code,
    parameters: { ...(example.initialParameters ?? emptyParameters) },
    uploadedFiles: {},
    previewValue: example.code,
    previewVersion: 0,
  };
}

type PlaygroundLoaderData = {
  readonly activeExampleId: string;
  readonly activeVariantId?: PlaygroundVariant['id'];
};

export const handle: Handle = {
  enablePageWrapper: false,
};

export function loader({ request, params }: Route.LoaderArgs): PlaygroundLoaderData {
  const { searchParams } = new URL(request.url);
  const activeExampleId = readPathModelId(params) ?? readInitialExampleIdFromSearch(searchParams);
  const activeExample = playgroundExamples.find((example) => example.id === activeExampleId) ?? defaultExample;
  const activeVariantId = readVariantIdFromSearch(searchParams, activeExample);
  return {
    activeExampleId,
    ...(activeVariantId ? { activeVariantId } : {}),
  };
}

export default function PlaygroundRoot(props: Partial<Route.ComponentProps> = {}): React.JSX.Element {
  const location = useLocation();
  const loaderExampleId = props.loaderData?.activeExampleId ?? defaultExample.id;
  const activeExampleId =
    readPathModelId(props.params) ??
    readInitialExampleIdFromSearch(new URLSearchParams(location.search), loaderExampleId);
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

  const initialVariantId =
    props.loaderData?.activeExampleId === loadedExample.id ? props.loaderData.activeVariantId : undefined;
  const playground = (
    <PlaygroundLoaded key={loadedExample.id} baseExample={loadedExample} initialVariantId={initialVariantId} />
  );
  if (loadedExample.mode === 'static') {
    return playground;
  }

  return (
    <FileManagerProvider rootDirectory='/' initialBackend='indexeddb'>
      {playground}
    </FileManagerProvider>
  );
}

function PlaygroundLoaded({
  baseExample,
  initialVariantId,
}: {
  readonly baseExample: PlaygroundExample;
  readonly initialVariantId: PlaygroundVariant['id'] | undefined;
}): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const [isLocationHydrated, setIsLocationHydrated] = useState(false);
  const [isCodeVisible, setIsCodeVisible] = useState(false);
  const [mobilePane, setMobilePane] = useState<PlaygroundMobilePane>('3d');
  const [exportControlsElement, setExportControlsElement] = useState<HTMLDivElement | undefined>(undefined);
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const locationVariantId = readVariantIdFromSearch(searchParams, baseExample);
  const activeVariantId = isLocationHydrated ? locationVariantId : initialVariantId;
  const { activeVariant, activeRenderIdentity, projectIdSuffix } = resolveActiveVariant(baseExample, activeVariantId);
  const activeExample = useMemo(() => applyVariant(baseExample, activeVariant), [baseExample, activeVariant]);
  const [variantSessions, setVariantSessions] = useState<Readonly<Record<string, PlaygroundVariantSession>>>(() => ({
    [activeRenderIdentity]: createVariantSession(activeExample),
  }));
  const activeSession = useMemo(
    () => variantSessions[activeRenderIdentity] ?? createVariantSession(activeExample),
    [activeExample, activeRenderIdentity, variantSessions],
  );
  const updateActiveSession = useCallback(
    (update: (session: PlaygroundVariantSession) => PlaygroundVariantSession): void => {
      setVariantSessions((sessions) => {
        const current = sessions[activeRenderIdentity] ?? createVariantSession(activeExample);
        const next = update(current);
        return next === current ? sessions : { ...sessions, [activeRenderIdentity]: next };
      });
    },
    [activeExample, activeRenderIdentity],
  );
  const locationShareToken = isLocationHydrated ? (searchParams.get(shareParametersKey) ?? undefined) : undefined;
  const [parameterResolution, setParameterResolution] = useState<{
    readonly activeRenderIdentity: string;
    readonly token: string | undefined;
  }>();
  const variantNavigationRequestRef = useRef(0);

  useEffect(() => {
    setIsLocationHydrated(true);
  }, []);

  useEffect(() => {
    if (!isLocationHydrated) {
      return;
    }

    let cancelled = false;
    // URL parameter decoding is an external asynchronous input. Resolve it before mounting the kernel provider.
    // oxlint-disable-next-line tau-lint/no-async-iife -- stale decodes are ignored by the cleanup guard.
    void (async () => {
      const parameters = await (locationShareToken
        ? shareCodec.tryDecompress(locationShareToken, emptyParameters)
        : Promise.resolve({ ...(activeExample.initialParameters ?? emptyParameters) }));
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Effect cleanup can flip this while awaiting.
      if (cancelled) {
        return;
      }

      updateActiveSession((session) =>
        haveSamePlaygroundParameters(session.parameters, parameters) ? session : { ...session, parameters },
      );
      setParameterResolution({ activeRenderIdentity, token: locationShareToken });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeExample.initialParameters,
    activeRenderIdentity,
    isLocationHydrated,
    locationShareToken,
    updateActiveSession,
  ]);

  const isLocationParametersResolved =
    parameterResolution?.activeRenderIdentity === activeRenderIdentity &&
    parameterResolution.token === locationShareToken;
  const isPreviewInteractive = isLocationHydrated && isLocationParametersResolved;

  const isCodeEditorDisabled = useIsCodeEditorDisabled(location.search);
  const isEditableExample = activeExample.mode !== 'static';
  const showCodeControls = isEditableExample && !isCodeEditorDisabled;
  const showCodeSection = isCodeVisible && showCodeControls;
  const staticPreviewUrl = activeExample.staticPreview?.glb;
  const [previewGeometryCache] = useState(createPlaygroundPreviewCache);
  const previewSourceFiles = useMemo(
    () => ({
      ...activeExample.sourceFiles,
      ...Object.fromEntries(
        Object.entries(activeSession.uploadedFiles).map(([fileName, file]) => [fileName, file.content]),
      ),
      [activeExample.mainFile]: activeSession.previewValue,
    }),
    [activeExample.mainFile, activeExample.sourceFiles, activeSession.previewValue, activeSession.uploadedFiles],
  );
  // What each upload slot is showing right now: the viewer's file once they
  // bring one, and until then the file the project ships — the stamp renders
  // `yaa.svg` from the moment it loads, so an empty drop zone would claim
  // there is no artwork.
  const uploadFiles = useMemo(() => {
    const files: Record<string, PlaygroundUploadedFile> = {};
    for (const upload of activeExample.uploads ?? []) {
      const shipped = activeExample.sourceFiles?.[upload.fileName];
      const current =
        activeSession.uploadedFiles[upload.fileName] ??
        (shipped === undefined ? undefined : { name: upload.fileName, content: shipped });
      if (current) {
        files[upload.fileName] = current;
      }
    }

    return files;
  }, [activeExample.uploads, activeExample.sourceFiles, activeSession.uploadedFiles]);
  const previewGeometryCacheKey = useMemo(
    () =>
      buildPlaygroundPreviewCacheKey({
        activeRenderIdentity,
        mainFile: activeExample.mainFile,
        parameters: activeSession.parameters,
        renderOptions: activeExample.renderOptions,
        sourceFiles: previewSourceFiles,
      }),
    [
      activeExample.mainFile,
      activeExample.renderOptions,
      activeRenderIdentity,
      activeSession.parameters,
      previewSourceFiles,
    ],
  );
  const cachedPreviewGeometries = previewGeometryCache.peek(previewGeometryCacheKey);
  useEffect(() => {
    if (cachedPreviewGeometries) {
      previewGeometryCache.get(previewGeometryCacheKey);
    }
  }, [cachedPreviewGeometries, previewGeometryCache, previewGeometryCacheKey]);
  const handlePreviewGeometriesReady = useCallback(
    (geometries: readonly Geometry[], parameters: Record<string, unknown>) => {
      const renderedCacheKey = buildPlaygroundPreviewCacheKey({
        activeRenderIdentity,
        mainFile: activeExample.mainFile,
        parameters,
        renderOptions: activeExample.renderOptions,
        sourceFiles: previewSourceFiles,
      });
      cachePlaygroundPreviewGeometries(previewGeometryCache, renderedCacheKey, geometries);
    },
    [
      activeExample.mainFile,
      activeExample.renderOptions,
      activeRenderIdentity,
      previewGeometryCache,
      previewSourceFiles,
    ],
  );
  const previewProjectId = `root-playground-${activeExample.id}${projectIdSuffix}`;
  const previewRenderKey = `${previewProjectId}-${activeSession.previewVersion}`;
  const showParameterPane = isEditableExample && playgroundPreviewCapabilities.parameters;
  const isDirty = activeSession.editorValue !== activeExample.code;
  const hasUnrunChanges = activeSession.editorValue !== activeSession.previewValue;

  const files = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(previewSourceFiles).map(([path, content]) => [path, { content: encodeTextFile(content) }]),
      ),
    [previewSourceFiles],
  );

  const runPreview = useCallback(() => {
    if (!isEditableExample) {
      return;
    }
    updateActiveSession((session) => ({
      ...session,
      previewValue: session.editorValue,
      previewVersion: session.previewVersion + 1,
    }));
  }, [isEditableExample, updateActiveSession]);

  const resetExample = useCallback(() => {
    if (!isEditableExample) {
      return;
    }
    updateActiveSession((session) => ({
      ...session,
      editorValue: activeExample.code,
      previewValue: activeExample.code,
      previewVersion: session.previewVersion + 1,
    }));
  }, [activeExample.code, isEditableExample, updateActiveSession]);

  const handleEditorChange = useCallback(
    (value: string): void => {
      updateActiveSession((session) => (session.editorValue === value ? session : { ...session, editorValue: value }));
    },
    [updateActiveSession],
  );

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>): void => {
      updateActiveSession((session) =>
        haveSamePlaygroundParameters(session.parameters, parameters) ? session : { ...session, parameters },
      );
    },
    [updateActiveSession],
  );

  const handleUpload = useCallback(
    (upload: PlaygroundUpload, file: PlaygroundUploadedFile): void => {
      updateActiveSession((session) => ({
        ...session,
        uploadedFiles: { ...session.uploadedFiles, [upload.fileName]: file },
        // Only a model that selects its asset by name needs pointing at it; one
        // that reads a fixed name is already reading the file just replaced.
        ...(upload.parameter === undefined
          ? {}
          : { parameters: { ...session.parameters, [upload.parameter]: upload.fileName } }),
        // No preview-version bump: the drop zone has already written the file
        // into the mounted preview filesystem, and the kernel re-renders off
        // that change. Remounting here would race it — see the drop zone.
      }));
    },
    [updateActiveSession],
  );

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
    const hasParameterChanges = hasParameterOverrides(activeSession.parameters, baseline);

    // oxlint-disable-next-line tau-lint/no-async-iife -- clipboard writes are event-driven and report via toast.
    void (async () => {
      try {
        const url = new URL(browserWindow.location.href);
        writeModelLocation(url, activeExample.id);
        if (activeVariant) {
          url.searchParams.set(variantKey, activeVariant.id);
        } else {
          url.searchParams.delete(variantKey);
        }

        if (hasParameterChanges) {
          // Encode only the changed parameters (the delta) into a compact, URL-safe token.
          url.searchParams.set(shareParametersKey, await shareCodec.compress(activeSession.parameters));
        } else {
          url.searchParams.delete(shareParametersKey);
        }

        await browserWindow.navigator.clipboard.writeText(url.toString());
        toast.success(hasParameterChanges ? 'Playground link copied with your changes' : 'Playground link copied');
      } catch {
        toast.error('Unable to copy playground link');
      }
    })();
  }, [activeExample.id, activeExample.initialParameters, activeSession.parameters, activeVariant]);

  const switchVariant = useCallback(
    (variantId: PlaygroundVariant['id']) => {
      const target = baseExample.variants?.find((variant) => variant.id === variantId);
      if (!target || variantId === (activeVariant?.id ?? defaultVariantIdFor(baseExample))) {
        return;
      }

      const targetVariant = target.isDefault ? undefined : target;
      const targetExample = applyVariant(baseExample, targetVariant);
      const targetIdentity = resolveActiveVariant(baseExample, targetVariant?.id).activeRenderIdentity;
      const targetSession = variantSessions[targetIdentity] ?? createVariantSession(targetExample);
      const navigationRequest = ++variantNavigationRequestRef.current;

      // oxlint-disable-next-line tau-lint/no-async-iife -- compression completes before the router transition.
      void (async () => {
        const baseline = targetExample.initialParameters ?? emptyParameters;
        const token = hasParameterOverrides(targetSession.parameters, baseline)
          ? await shareCodec.compress(targetSession.parameters)
          : undefined;
        if (variantNavigationRequestRef.current !== navigationRequest) {
          return;
        }

        const url = new URL(`${location.pathname}${location.search}${location.hash}`, 'https://playground.local');
        writeModelLocation(url, baseExample.id);
        if (target.isDefault) {
          url.searchParams.delete(variantKey);
        } else {
          url.searchParams.set(variantKey, target.id);
        }
        if (token) {
          url.searchParams.set(shareParametersKey, token);
        } else {
          url.searchParams.delete(shareParametersKey);
        }
        void navigate(`${url.pathname}${url.search}${url.hash}`, { preventScrollReset: true });
      })();
    },
    [activeVariant, baseExample, location.hash, location.pathname, location.search, navigate, variantSessions],
  );

  useEffect(() => {
    if (!isPreviewInteractive) {
      return;
    }

    let cancelled = false;
    // Keep the browser URL canonical without routing every live parameter edit through the loader.
    // oxlint-disable-next-line tau-lint/no-async-iife -- stale compression results are ignored on cleanup.
    void (async () => {
      const baseline = activeExample.initialParameters ?? emptyParameters;
      const token = await (hasParameterOverrides(activeSession.parameters, baseline)
        ? shareCodec.compress(activeSession.parameters)
        : Promise.resolve(undefined));
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Effect cleanup can flip this while awaiting.
      if (cancelled) {
        return;
      }

      const browserWindow = getBrowserWindow();
      if (!browserWindow) {
        return;
      }

      const url = new URL(browserWindow.location.href);
      writeModelLocation(url, activeExample.id);
      if (activeVariant) {
        url.searchParams.set(variantKey, activeVariant.id);
      } else {
        url.searchParams.delete(variantKey);
      }
      if (token) {
        url.searchParams.set(shareParametersKey, token);
      } else {
        url.searchParams.delete(shareParametersKey);
      }

      if (url.toString() !== browserWindow.location.href) {
        browserWindow.history.replaceState({}, '', url.toString());
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeExample.id,
    activeExample.initialParameters,
    activeSession.parameters,
    activeVariant,
    isPreviewInteractive,
  ]);

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
              <ClientOnly fallback={<EditorFallback value={activeSession.editorValue} onChange={handleEditorChange} />}>
                <Suspense fallback={<EditorFallback value={activeSession.editorValue} onChange={handleEditorChange} />}>
                  <CodeEditorLazy
                    className='h-full'
                    height='100%'
                    path={activeExample.mainFile}
                    language={activeExample.language}
                    value={activeSession.editorValue}
                    onChange={(value) => {
                      handleEditorChange(value ?? '');
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
          isInteractive={isPreviewInteractive}
          parameters={activeSession.parameters}
          previewGeometryCacheKey={previewGeometryCacheKey}
          previewProjectId={previewProjectId}
          previewRenderKey={previewRenderKey}
          staticPreviewUrl={staticPreviewUrl}
          mobilePane={mobilePane}
          exportControlsElement={exportControlsElement}
          onGeometriesReady={handlePreviewGeometriesReady}
          uploads={activeExample.uploads}
          uploadFiles={uploadFiles}
          onUpload={handleUpload}
          onParametersChange={handleParametersChange}
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

/**
 * Resolve the `:model` path segment (Pages gallery routes) to a known example
 * id. The param only exists on the Pages build's route table, so `params` is
 * typed loosely; unknown segments fall through to the `?model=` search lookup.
 */
function readPathModelId(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) {
    return undefined;
  }

  const candidate = (params as Record<string, unknown>)['model'];
  return typeof candidate === 'string' && playgroundExamples.some((example) => example.id === candidate)
    ? candidate
    : undefined;
}

/**
 * Write the canonical location for a model onto a URL. The Pages gallery
 * addresses models by root-level path (`/<model>`); the app build keeps the
 * `?model=` form on `/playground`. The legacy `example` parameter is dropped
 * either way.
 */
function writeModelLocation(url: URL, exampleId: string): void {
  if (isGithubPagesBuild) {
    url.pathname = `/${exampleId}`;
    url.searchParams.delete('model');
  } else {
    url.searchParams.set('model', exampleId);
  }
  url.searchParams.delete('example');
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
 * Materialize a non-default variant as the effective example: the variant's entry
 * file drives the editor, kernel selection, and export formats. Presets and initial
 * parameters are dropped — they are authored against the default variant's schema.
 */
function applyVariant(example: PlaygroundExample, variant: PlaygroundVariant | undefined): PlaygroundExample {
  if (!variant) {
    return example;
  }

  // The example's own preview settings (timeout, preview lines, render options)
  // describe the DEFAULT variant's kernel — never inherit them into another kernel.
  const {
    initialParameters: _initialParameters,
    presets: _presets,
    renderTimeout: _renderTimeout,
    showPreviewLines: _showPreviewLines,
    renderOptions: _renderOptions,
    ...rest
  } = example;
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
    <div role='group' aria-label='Kernel variant' className='flex h-8 items-center overflow-hidden rounded-md border'>
      {example.variants.map((variant) => (
        <button
          key={variant.id}
          type='button'
          aria-pressed={variant.id === selectedVariantId}
          aria-label={variant.label}
          className={cn(
            'h-full px-2.5 text-xs font-medium transition-colors',
            variant.id === selectedVariantId
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => {
            onSwitch(variant.id);
          }}
        >
          {/* Abbreviated on phones (e.g. "SCAD"/"OCCT") so the header stays within a thumb-width. */}
          <span className='md:hidden'>{variant.shortLabel}</span>
          <span className='max-md:hidden'>{variant.label}</span>
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
