import { useLoaderData, useLocation, useNavigate } from 'react-router';
import type { MetaDescriptor } from 'react-router';
import { useEffect, useRef } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { AlertCircle, RotateCcw, X, XCircle } from 'lucide-react';
import { fromPromise } from 'xstate';
import type { Route } from './+types/route.js';
import type { Handle } from '#types/matches.types.js';
import { importGitHubMachine } from '#machines/import-github.machine.js';
import { LoadingSpinner } from '#components/ui/loading-spinner.js';
import { Progress } from '#components/ui/progress.js';
import { Button } from '#components/ui/button.js';
import { Input } from '#components/ui/input.js';
import { SvgIcon } from '#components/icons/svg-icon.js';
import { formatFileSize } from '#components/geometry/converter/converter-utils.js';
import { useBuildManager } from '#hooks/use-build-manager.js';
import { RepositoryCard } from '#routes/import.$/repository-card.js';
import { BranchSelector } from '#routes/import.$/branch-selector.js';
import { FileSelector } from '#components/files/file-selector.js';
import { SuggestedClones } from '#routes/import.$/suggested-clones.js';
import { inspect } from '#machines/inspector.js';
import { CopyButton } from '#components/copy-button.js';
import { ImportViewer } from '#routes/import.$/import-viewer.js';

export const handle: Handle = {
  enableOverflowY: true,
};

type GitHubRepoInfo = {
  owner: string;
  repo: string;
  ref: string;
  mainFile: string;
};

/**
 * Parse GitHub URL and extract owner/repo
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | undefined {
  try {
    const parsed = new URL(url);

    // Only allow github.com
    if (parsed.hostname !== 'github.com') {
      return undefined;
    }

    // Parse /owner/repo or /owner/repo.git
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length < 2) {
      return undefined;
    }

    const [owner, repoRaw] = pathParts;
    if (!owner || !repoRaw) {
      return undefined;
    }

    const repo = repoRaw.replace(/\.git$/, '');

    return { owner, repo };
  } catch {
    return undefined;
  }
}

/**
 * Build hierarchical file tree from flat file list
 */

export function meta({ loaderData }: Route.MetaArgs): MetaDescriptor[] {
  const repo = `${loaderData.owner}/${loaderData.repo} ${loaderData.ref === 'main' ? '' : `@ ${loaderData.ref}`}`;
  const title = `Import ${repo} from GitHub into Tau`;
  const description = `Get started with ${repo} by importing it into Tau.`;
  return [{ title, description }];
}

/**
 * Normalize a GitHub URL from the path.
 * Browser may normalize https:// to https:/ in URL paths.
 */
function normalizeGitHubUrl(splatPath: string): string {
  let repoUrl = splatPath;

  // Handle various URL formats and normalize to https://github.com/...

  // Handle fully encoded protocol (https%3A%2F%2F or https%3a%2f%2f)
  if (repoUrl.startsWith('https%3A%2F%2F') || repoUrl.startsWith('https%3a%2f%2f')) {
    repoUrl = repoUrl.replace(/^https%3[Aa]%2[Ff]%2[Ff]/, 'https://');
  }

  if (repoUrl.startsWith('http%3A%2F%2F') || repoUrl.startsWith('http%3a%2f%2f')) {
    repoUrl = repoUrl.replace(/^http%3[Aa]%2[Ff]%2[Ff]/, 'http://');
  }

  // Handle partially encoded colon (https%3A// or https%3a//)
  if (repoUrl.startsWith('https%3A//') || repoUrl.startsWith('https%3a//')) {
    repoUrl = repoUrl.replace(/^https%3[Aa]\/\//, 'https://');
  }

  if (repoUrl.startsWith('http%3A//') || repoUrl.startsWith('http%3a//')) {
    repoUrl = repoUrl.replace(/^http%3[Aa]\/\//, 'http://');
  }

  // Fix URL normalization (browser might normalize https:// to https:/)
  if (repoUrl.startsWith('https:/') && !repoUrl.startsWith('https://')) {
    repoUrl = repoUrl.replace('https:/', 'https://');
  }

  if (repoUrl.startsWith('http:/') && !repoUrl.startsWith('http://')) {
    repoUrl = repoUrl.replace('http:/', 'http://');
  }

  // Handle bare domain (github.com/owner/repo) - add https://
  if (repoUrl.startsWith('github.com/')) {
    repoUrl = `https://${repoUrl}`;
  }

  return repoUrl;
}

/**
 * Splat route loader for /import/*
 *
 * Handles path-based GitHub URLs like:
 * - /import/https://github.com/owner/repo
 * - /import/https://github.com/owner/repo?ref=main&main=file.scad
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- inferred type
export function loader({ request, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const splatPath = (params as { '*'?: string })['*'] ?? '';

  const ref = url.searchParams.get('ref') ?? 'main';
  const mainFile = url.searchParams.get('main') ?? '';

  // If no splat path, return defaults for entering details state
  if (!splatPath) {
    return {
      owner: '',
      repo: '',
      ref: 'main',
      mainFile: '',
    } satisfies GitHubRepoInfo;
  }

  // Normalize the GitHub URL from the path
  const repoUrl = normalizeGitHubUrl(splatPath);

  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    throw new Error('Invalid GitHub URL. Only github.com repositories are supported.');
  }

  return {
    owner: parsed.owner,
    repo: parsed.repo,
    ref,
    mainFile,
  } satisfies GitHubRepoInfo;
}

// eslint-disable-next-line complexity -- TODO: consider refactoring.
export default function ImportRoute(): React.JSX.Element {
  const { owner, repo, ref, mainFile } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const buildManager = useBuildManager();

  // Create import machine actor
  const importActorRef = useActorRef(
    importGitHubMachine.provide({
      actors: {
        createBuildActor: fromPromise(async ({ input }) => {
          const buildFiles: Record<string, { content: Uint8Array }> = {};
          for (const [path, file] of input.files) {
            buildFiles[path] = { content: file.content };
          }

          const build = await buildManager.createBuild(
            {
              name: `${input.owner}/${input.repo}`,
              description: `Imported from GitHub: https://github.com/${input.owner}/${input.repo}`,
              stars: 0,
              forks: 0,
              author: {
                name: 'You',
                avatar: '/avatar-sample.png',
              },
              tags: [],
              thumbnail: '',
              assets: {
                mechanical: {
                  main: input.mainFile,
                  parameters: {},
                },
              },
            },
            buildFiles,
          );

          return { type: 'buildCreated', buildId: build.id };
        }),
      },
    }),
    {
      input: {
        owner,
        repo,
        ref,
        mainFile,
      },
      inspect,
    },
  );

  // Select state from machine
  const state = useSelector(importActorRef, (snapshot) => snapshot);
  const downloadProgress = useSelector(
    importActorRef,
    (snapshot) => snapshot.context.downloadProgress as { loaded: number; total: number },
  );
  const extractProgress = useSelector(
    importActorRef,
    (snapshot) => snapshot.context.extractProgress as { processed: number; total: number },
  );
  const error = useSelector(importActorRef, (snapshot) => snapshot.context.error);
  const buildId = useSelector(importActorRef, (snapshot) => snapshot.context.buildId);
  const files = useSelector(importActorRef, (snapshot) => snapshot.context.files);
  const selectedMainFile = useSelector(importActorRef, (snapshot) => snapshot.context.selectedMainFile);
  const requestedMainFile = useSelector(importActorRef, (snapshot) => snapshot.context.requestedMainFile);
  const repoUrl = useSelector(importActorRef, (snapshot) => snapshot.context.repoUrl);
  const repoOwner = useSelector(importActorRef, (snapshot) => snapshot.context.owner);
  const repoName = useSelector(importActorRef, (snapshot) => snapshot.context.repo);
  const repoMetadata = useSelector(importActorRef, (snapshot) => snapshot.context.repoMetadata);
  const branches = useSelector(importActorRef, (snapshot) => snapshot.context.branches);
  const selectedBranch = useSelector(importActorRef, (snapshot) => snapshot.context.selectedBranch);
  const repoFiles = useSelector(importActorRef, (snapshot) => snapshot.context.repoFiles);
  const isLoadingFiles = useSelector(importActorRef, (snapshot) => snapshot.context.isLoadingFiles);
  const fetchErrors = useSelector(importActorRef, (snapshot) => snapshot.context.fetchErrors);
  const hasMoreBranches = useSelector(importActorRef, (snapshot) => snapshot.context.hasMoreBranches);
  const isLoadingMoreBranches = useSelector(importActorRef, (snapshot) => snapshot.context.isLoadingMoreBranches);

  // Track if this is the initial mount to avoid syncing on first render
  const isInitialMount = useRef(true);
  const location = useLocation();

  // Sync location changes to machine (for back/forward navigation)
  // This is the single source of truth for URL → Machine state
  useEffect(() => {
    // Skip on initial mount - let the loader data initialize the machine
    if (isInitialMount.current) {
      isInitialMount.current = false;
      // But still send initial location to ensure machine has correct state
      importActorRef.send({
        type: 'syncLocation',
        owner,
        repo,
        ref,
        mainFile,
      });
      return;
    }

    // Send location changes to machine
    importActorRef.send({
      type: 'syncLocation',
      owner,
      repo,
      ref,
      mainFile,
    });
  }, [location.pathname, location.search, owner, repo, ref, mainFile, importActorRef]);

  // Listen to machine's URL events and update browser URL
  useEffect(() => {
    const subscription = importActorRef.on('urlReplaced', (event) => {
      // Normalize URLs for comparison (handle all format variants)
      const normalizeForCompare = (url: string): string =>
        url
          // Remove protocol variations to compare just the path
          .replace('/import/https%3A%2F%2Fgithub.com/', '/import/github.com/')
          .replace('/import/https%3A//github.com/', '/import/github.com/')
          .replace('/import/https://github.com/', '/import/github.com/')
          .replace('/import/https:/github.com/', '/import/github.com/');

      const currentUrl = globalThis.location.pathname + globalThis.location.search;

      if (normalizeForCompare(currentUrl) !== normalizeForCompare(event.url)) {
        globalThis.history.replaceState(null, '', event.url);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [importActorRef]);

  useEffect(() => {
    const subscription = importActorRef.on('urlPushed', (event) => {
      // Normalize URLs for comparison (handle all format variants)
      const normalizeForCompare = (url: string): string =>
        url
          // Remove protocol variations to compare just the path
          .replace('/import/https%3A%2F%2Fgithub.com/', '/import/github.com/')
          .replace('/import/https%3A//github.com/', '/import/github.com/')
          .replace('/import/https://github.com/', '/import/github.com/')
          .replace('/import/https:/github.com/', '/import/github.com/');

      const currentUrl = globalThis.location.pathname + globalThis.location.search;

      if (normalizeForCompare(currentUrl) !== normalizeForCompare(event.url)) {
        globalThis.history.pushState(null, '', event.url);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [importActorRef]);

  // Navigate when build is created
  useEffect(() => {
    if (state.matches('success') && buildId) {
      void navigate(`/builds/${buildId}`);
    }
  }, [state, buildId, navigate]);

  switch (true) {
    case state.matches('enteringDetails') ||
      state.matches('checkingRepo') ||
      state.matches('fetchingRepoInfo') ||
      state.matches('loadingMoreBranches'): {
      const isValidRepo = repoOwner.length > 0 && repoName.length > 0;
      const isCheckingOrFetching = state.matches('checkingRepo') || state.matches('fetchingRepoInfo');

      return (
        <div className="flex min-h-full flex-col items-center justify-start px-4 pt-6 pb-16 md:justify-center md:pt-8">
          <div className="w-full max-w-2xl space-y-6">
            <div className="flex flex-col items-center gap-4">
              <div className="flex size-16 items-center justify-center rounded-full bg-linear-to-br from-primary/20 to-primary/10">
                <SvgIcon id="github" className="size-8 text-primary" />
              </div>

              <div className="text-center">
                <h1 className="text-2xl font-semibold">Import from GitHub</h1>
                <p className="text-sm text-muted-foreground">Enter a GitHub repository URL to get started</p>
              </div>
            </div>

            <div className="space-y-4">
              {/* Repository URL Input */}
              <div className="space-y-2 rounded-lg border bg-sidebar p-6">
                <label htmlFor="repo-url" className="text-sm font-medium">
                  Repository URL
                </label>
                <div className="group relative">
                  <Input
                    id="repo-url"
                    type="url"
                    placeholder="https://github.com/owner/repo"
                    value={repoUrl}
                    className="pr-8 font-mono text-sm"
                    onChange={(event) => {
                      importActorRef.send({ type: 'updateRepoUrl', url: event.target.value });
                    }}
                  />
                  {repoUrl.length > 0 ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute top-1/2 right-1.5 size-5 -translate-y-1/2 p-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
                      type="button"
                      aria-label="Clear URL"
                      onClick={() => {
                        // Clear URL - machine will emit urlPushed to update browser URL
                        importActorRef.send({ type: 'updateRepoUrl', url: '' });
                      }}
                    >
                      <X className="size-3.5" />
                    </Button>
                  ) : undefined}
                </div>
              </div>

              {/* Repository Preview Card or Suggested Clones */}
              {isValidRepo ? (
                <>
                  <RepositoryCard
                    metadata={repoMetadata}
                    owner={repoOwner}
                    repo={repoName}
                    isLoading={isCheckingOrFetching}
                  />

                  {/* Validation Feedback */}
                  {!isCheckingOrFetching && !repoMetadata ? (
                    <div className="flex items-start gap-3 rounded-lg border border-warning/50 bg-warning/10 p-4 text-warning">
                      <AlertCircle className="size-5 shrink-0" />
                      <div className="flex flex-col gap-1">
                        <div className="font-semibold">Repository Not Found</div>
                        <div className="text-sm">
                          The repository may not exist, be private, or you may not have access to it. Please check the
                          URL and try again.
                        </div>
                      </div>
                    </div>
                  ) : undefined}

                  {!isCheckingOrFetching && repoMetadata?.isPrivate ? (
                    <div className="border-info/50 bg-info/10 text-info flex items-start gap-3 rounded-lg border p-4">
                      <AlertCircle className="size-5 shrink-0" />
                      <div className="flex flex-col gap-1">
                        <div className="font-semibold">Private Repository</div>
                        <div className="text-sm">
                          This is a private repository. Make sure you have access permissions to import it.
                        </div>
                      </div>
                    </div>
                  ) : undefined}

                  {/* Fetch Errors - Show warnings for non-critical failures */}
                  {repoMetadata && !isCheckingOrFetching && fetchErrors.branches ? (
                    <div className="flex items-start gap-3 rounded-lg border border-warning/50 bg-warning/10 p-4 text-warning">
                      <AlertCircle className="size-5 shrink-0" />
                      <div className="flex flex-col gap-1">
                        <div className="font-semibold">Partial Information</div>
                        <div className="text-sm">
                          <div>Could not fetch branches list</div>
                          <div className="mt-1">You can still proceed with the import.</div>
                        </div>
                      </div>
                    </div>
                  ) : undefined}

                  {/* File Tree Errors - Show when file listing fails (e.g., truncation for large repos) */}
                  {repoMetadata && !isCheckingOrFetching && fetchErrors.files ? (
                    <div className="flex items-start gap-3 rounded-lg border border-warning/50 bg-warning/10 p-4 text-warning">
                      <AlertCircle className="size-5 shrink-0" />
                      <div className="flex flex-col gap-1">
                        <div className="font-semibold">Could Not List Files</div>
                        <div className="text-sm">
                          <div>{fetchErrors.files.message}</div>
                          <div className="mt-1">You can still proceed with the import.</div>
                        </div>
                      </div>
                    </div>
                  ) : undefined}

                  {/* Branch & Main File Selectors */}
                  {branches.length > 0 || repoFiles.length > 0 ? (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      {/* Branch Selector */}
                      {branches.length > 0 ? (
                        <div className="space-y-2 rounded-lg border bg-sidebar p-6">
                          <label className="text-sm font-medium">Branch</label>
                          <BranchSelector
                            branches={branches}
                            selectedBranch={selectedBranch}
                            isLoadingMore={isLoadingMoreBranches}
                            onSelect={(branch) => {
                              importActorRef.send({ type: 'selectBranch', branch });
                            }}
                            onLoadMore={
                              hasMoreBranches
                                ? () => {
                                    importActorRef.send({ type: 'loadMoreBranches' });
                                  }
                                : undefined
                            }
                          />
                        </div>
                      ) : undefined}

                      {/* Main File Selector */}
                      {repoFiles.length > 0 || isLoadingFiles ? (
                        <div className="space-y-2 rounded-lg border bg-sidebar p-6">
                          <label className="text-sm font-medium">Main File</label>
                          <FileSelector
                            files={repoFiles}
                            selectedFile={selectedMainFile}
                            isLoading={isLoadingFiles}
                            popoverProperties={{
                              side: 'top',
                            }}
                            onSelect={(file) => {
                              importActorRef.send({ type: 'selectMainFile', file });
                            }}
                          />
                        </div>
                      ) : undefined}
                    </div>
                  ) : undefined}

                  {/* Start Import Button and Short Link */}
                  <div className="flex gap-2">
                    <Button
                      className="flex-1"
                      size="lg"
                      disabled={isCheckingOrFetching || !repoMetadata}
                      onClick={() => {
                        importActorRef.send({ type: 'startImport' });
                      }}
                    >
                      Start Import
                    </Button>
                    <CopyButton
                      size="icon"
                      className="size-11"
                      variant="outline"
                      tooltip="Copy short link"
                      readyToCopyText=""
                      copiedText=""
                      getText={() => {
                        // Build short URL with /i instead of /import
                        // Use repoUrl from machine context (not browser URL) to avoid https:/ normalization
                        const parameters = new URLSearchParams();

                        if (selectedBranch && selectedBranch !== 'main') {
                          parameters.set('ref', selectedBranch);
                        }

                        const queryString = parameters.size > 0 ? `?${parameters.toString()}` : '';

                        return `${globalThis.location.origin}/i/${repoUrl}${queryString}`;
                      }}
                    />
                  </div>
                </>
              ) : (
                <SuggestedClones
                  onSelect={(repository) => {
                    // Use github.com without protocol to avoid browser normalizing // to /
                    const repoUrl = `github.com/${repository.owner}/${repository.repo}`;
                    const parameters = new URLSearchParams();

                    if (repository.ref !== 'main') {
                      parameters.set('ref', repository.ref);
                    }

                    if (repository.mainFile) {
                      parameters.set('main', repository.mainFile);
                    }

                    const queryString = parameters.size > 0 ? `?${parameters.toString()}` : '';
                    const targetUrl = `/import/${repoUrl}${queryString}`;

                    // Use React Router navigate for proper history management
                    void navigate(targetUrl);
                  }}
                />
              )}
            </div>
          </div>
        </div>
      );
    }

    case state.matches('selectingMainFile'): {
      const fileNames = [...files.keys()];

      return (
        <div className="flex min-h-full flex-col items-center justify-start px-4 pt-6 pb-16 md:justify-center md:pt-8">
          <div className="w-full max-w-5xl space-y-6">
            <div className="flex flex-col items-center gap-4">
              <div className="flex size-16 items-center justify-center rounded-full bg-linear-to-br from-primary/20 to-primary/10">
                <SvgIcon id="github" className="size-8 text-primary" />
              </div>

              <div className="text-center">
                <h1 className="text-2xl font-semibold">Review Import</h1>
                <p className="text-sm text-muted-foreground">
                  {owner}/{repo}
                  {ref === 'main' ? '' : ` @ ${ref}`}
                </p>
                {requestedMainFile.length > 0 && !fileNames.includes(requestedMainFile) ? (
                  <p className="mt-2 text-sm text-warning">
                    Requested file &quot;{requestedMainFile}&quot; not found. Please select a main file.
                  </p>
                ) : undefined}
              </div>
            </div>

            <div className="flex flex-col gap-6 md:flex-row">
              {/* Left: CAD Preview */}
              <div className="h-[60vh] flex-1 overflow-hidden rounded-lg border bg-sidebar">
                <ImportViewer files={files} mainFile={selectedMainFile} owner={owner} repo={repo} />
              </div>

              {/* Right: Main File Selection */}
              <div className="flex w-full flex-col justify-start gap-4 md:w-64">
                <div className="space-y-3">
                  <h2 className="text-sm font-medium">Main File</h2>
                  <FileSelector
                    files={fileNames.map((path) => ({ path }))}
                    selectedFile={selectedMainFile}
                    placeholder="Select main file..."
                    title="Select Main File"
                    description="Choose the main entry file for your project"
                    emptyMessage="No files found"
                    onSelect={(file) => {
                      importActorRef.send({ type: 'selectMainFile', file });
                    }}
                  />
                </div>

                {selectedMainFile ? (
                  <div className="rounded-md bg-muted/50 p-3 text-xs">
                    <div className="font-medium">Selected:</div>
                    <div className="mt-1 break-all text-muted-foreground">{selectedMainFile}</div>
                  </div>
                ) : undefined}

                <Button
                  className="w-full"
                  disabled={!selectedMainFile}
                  onClick={() => {
                    importActorRef.send({ type: 'confirmImport' });
                  }}
                >
                  Import Project
                </Button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    case state.matches('error'): {
      return (
        <div className="flex min-h-full flex-col items-center justify-start px-4 pt-6 pb-16 md:justify-center md:pt-8">
          <div className="w-full max-w-md space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive">
              <AlertCircle className="size-5 shrink-0" />
              <div className="flex flex-col gap-1">
                <div className="font-semibold">Import Failed</div>
                <div className="text-sm">{error?.message ?? 'Unknown error occurred'}</div>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                variant="default"
                className="flex-1"
                onClick={() => {
                  importActorRef.send({ type: 'retry' });
                }}
              >
                <RotateCcw className="mr-2 size-4" />
                Restart
              </Button>
              <Button asChild variant="outline" className="flex-1">
                <a href="/">Back to Home</a>
              </Button>
            </div>
          </div>
        </div>
      );
    }

    default: {
      return (
        <div className="flex min-h-full flex-col items-center justify-start px-4 pt-6 pb-16 md:justify-center md:pt-8">
          <div className="w-full max-w-2xl space-y-6">
            <div className="flex flex-col items-center gap-4">
              <div className="flex size-16 items-center justify-center rounded-full bg-linear-to-br from-primary/20 to-primary/10">
                <SvgIcon id="github" className="size-8 text-primary" />
              </div>

              <div className="text-center">
                <h1 className="text-2xl font-semibold">Importing Repository</h1>
                <p className="text-sm text-muted-foreground">
                  {repoOwner}/{repoName}
                  {selectedBranch && selectedBranch !== 'main' ? ` @ ${selectedBranch}` : ''}
                </p>
              </div>
            </div>

            {/* Repository Preview Card (read-only) */}
            {repoMetadata ? (
              <RepositoryCard metadata={repoMetadata} owner={repoOwner} repo={repoName} isLoading={false} />
            ) : undefined}

            <div className="space-y-4">
              {/* Downloading */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    {state.matches('downloading') ? (
                      <>
                        <LoadingSpinner />
                        <span>Downloading...</span>
                      </>
                    ) : (
                      '✓ Downloaded'
                    )}
                  </span>
                  {downloadProgress.loaded > 0 ? (
                    <span className="text-muted-foreground">
                      {downloadProgress.total > 0
                        ? `${formatFileSize(downloadProgress.loaded)} / ${formatFileSize(downloadProgress.total)}`
                        : formatFileSize(downloadProgress.loaded)}
                    </span>
                  ) : undefined}
                </div>
                <Progress
                  value={
                    downloadProgress.total > 0 && downloadProgress.loaded > 0
                      ? (downloadProgress.loaded / downloadProgress.total) * 100
                      : downloadProgress.loaded > 0
                        ? undefined
                        : 0
                  }
                  className="h-2"
                />
              </div>

              {/* Extracting */}
              {(state.matches('extracting') || state.matches('creating')) && downloadProgress.loaded > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 font-medium">
                      {state.matches('extracting') ? (
                        <>
                          <LoadingSpinner />
                          <span>Extracting files...</span>
                        </>
                      ) : (
                        '✓ Extracted'
                      )}
                    </span>
                    {extractProgress.total > 0 ? (
                      <span className="text-muted-foreground">
                        {extractProgress.processed} / {extractProgress.total} files
                      </span>
                    ) : undefined}
                  </div>
                  <Progress
                    value={extractProgress.total > 0 ? (extractProgress.processed / extractProgress.total) * 100 : 0}
                    className="h-2"
                  />
                </div>
              ) : undefined}

              {/* Creating */}
              {state.matches('creating') ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 font-medium">
                      <LoadingSpinner />
                      <span>Creating build...</span>
                    </span>
                  </div>
                  <Progress value={100} className="h-2" />
                </div>
              ) : undefined}

              {/* Cancel Button - show during download/extract only */}
              {state.matches('downloading') || state.matches('extracting') ? (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    importActorRef.send({ type: 'cancelDownload' });
                  }}
                >
                  <XCircle className="mr-2 size-4" />
                  Cancel Import
                </Button>
              ) : undefined}
            </div>
          </div>
        </div>
      );
    }
  }
}
