import { assign, assertEvent, setup, fromPromise, enqueueActions } from 'xstate';
import type { AnyActorRef, ActorRefFrom, OutputFrom, DoneActorEvent } from 'xstate';
import { unzipMachine } from '#machines/unzip.machine.js';
import type { UnzipMachineActor } from '#machines/unzip.machine.js';
import { assertActorDoneEvent } from '#lib/xstate.js';
import { getGitHubClient } from '#lib/github-api.js';

/**
 * Import GitHub Machine Context
 */
export type ImportGitHubContext = {
  parentRef: AnyActorRef | undefined;
  repoUrl: string;
  owner: string;
  repo: string;
  ref: string;
  requestedMainFile: string;
  selectedMainFile: string | undefined;
  repoMetadata:
    | {
        avatarUrl: string | undefined;
        description: string | undefined;
        stars: number | undefined;
        forks: number | undefined;
        watchers: number | undefined;
        license: string | undefined;
        defaultBranch: string | undefined;
        isPrivate: boolean | undefined;
        lastUpdated: string | undefined;
      }
    | undefined;
  branches: Array<{ name: string; sha: string; updatedAt: number }>;
  selectedBranch: string;
  branchesCursor: string | undefined;
  hasMoreBranches: boolean;
  isLoadingMoreBranches: boolean;
  /** List of files in the repository (fetched via GitHub Trees API) */
  repoFiles: Array<{ path: string; size: number }>;
  isLoadingFiles: boolean;
  downloadProgress: { loaded: number; total: number };
  extractProgress: { processed: number; total: number };
  unzipRef: ActorRefFrom<UnzipMachineActor> | undefined;
  unzipSubscription: { unsubscribe: () => void } | undefined;
  files: Map<string, { filename: string; content: Uint8Array }>;
  buildId: string | undefined;
  error: Error | undefined;
  fetchErrors: {
    metadata: Error | undefined;
    branches: Error | undefined;
    files: Error | undefined;
  };
  /** Flag to track if last URL change was from navigation (syncLocation) */
  urlFromNavigation: boolean;
};

function toMetadataFetchError(error: unknown): Error {
  const errorMessage = error instanceof Error ? error.message : String(error);

  if (errorMessage.includes('404')) {
    return new Error('Repository not found. Please check the URL and try again.');
  }

  if (errorMessage.includes('403') || errorMessage.includes('rate limit')) {
    return new Error(
      'GitHub API rate limit exceeded. Please add a GITHUB_API_TOKEN to your environment or wait before trying again.',
    );
  }

  return new Error(`Failed to fetch repository metadata: ${errorMessage}`);
}

/**
 * Import GitHub Machine Input
 */
type ImportGitHubInput = {
  parentRef?: AnyActorRef;
  owner?: string;
  repo?: string;
  ref?: string;
  mainFile?: string;
};

/**
 * Import GitHub Machine Events
 */
type ImportGitHubEventInternal =
  | { type: 'retry' }
  | { type: 'updateRepoUrl'; url: string }
  | { type: 'selectBranch'; branch: string }
  | { type: 'selectMainFile'; file: string }
  | { type: 'syncLocation'; owner: string; repo: string; ref: string; mainFile: string }
  | { type: 'startImport' }
  | { type: 'cancelDownload' }
  | { type: 'loadMoreBranches' }
  | {
      type: 'updateDownloadProgress';
      loaded: number;
      total: number;
    }
  | {
      type: 'updateExtractProgress';
      processed: number;
      total: number;
    }
  | {
      type: 'extractionComplete';
      files: Map<string, { filename: string; content: Uint8Array }>;
    }
  | {
      type: 'extractionError';
      error: Error;
    }
  | { type: 'confirmImport' };

/**
 * Events emitted by the machine for external listeners (e.g., URL sync)
 *
 * - urlReplaced: Update URL bar without affecting back/forward stack (for typing)
 * - urlPushed: Push to history stack for meaningful navigation points
 */
type ImportGitHubEmitted =
  | {
      type: 'urlReplaced';
      url: string;
    }
  | {
      type: 'urlPushed';
      url: string;
    };

type ImportGitHubEvent = ImportGitHubEventExternalDone | ImportGitHubEventInternal;

// Actor output types
type DownloadResult = { type: 'downloaded'; blob: Blob };
type RepoMetadataResult = {
  type: 'metadataRetrieved';
  metadata: {
    avatarUrl: string | undefined;
    description: string | undefined;
    stars: number | undefined;
    forks: number | undefined;
    watchers: number | undefined;
    license: string | undefined;
    defaultBranch: string | undefined;
    isPrivate: boolean | undefined;
    lastUpdated: string | undefined;
  };
};
type BranchesResult = {
  type: 'branchesRetrieved';
  branches: Array<{ name: string; sha: string; updatedAt: number }>;
  hasMore: boolean;
  endCursor: string | undefined;
};

/**
 * Build the URL string for the current machine state
 */
function buildImportUrl(
  owner: string,
  repo: string,
  selectedBranch: string,
  selectedMainFile: string | undefined,
): string {
  if (!owner || !repo) {
    return '/import';
  }

  // Use github.com/owner/repo without protocol to avoid browser normalizing // to /
  // The full https:// is implied and added when parsing
  const repoUrl = `github.com/${owner}/${repo}`;
  const path = `/import/${repoUrl}`;

  const parameters = new URLSearchParams();

  if (selectedBranch && selectedBranch !== 'main') {
    parameters.set('ref', selectedBranch);
  }

  if (selectedMainFile) {
    parameters.set('main', selectedMainFile);
  }

  const queryString = parameters.size > 0 ? `?${parameters.toString()}` : '';

  return `${path}${queryString}`;
}

// Get repository metadata actor
const getRepoMetadataActor = fromPromise<RepoMetadataResult, { owner: string; repo: string }>(async ({ input }) => {
  const client = getGitHubClient();
  const metadata = await client.getRepository(input.owner, input.repo);

  return {
    type: 'metadataRetrieved',
    metadata,
  };
});

// Get branches actor
const getBranchesActor = fromPromise<BranchesResult, { owner: string; repo: string; cursor?: string }>(
  async ({ input }): Promise<BranchesResult> => {
    const client = getGitHubClient();
    const result = await client.listBranches(input.owner, input.repo, 100, input.cursor);

    return {
      type: 'branchesRetrieved' as const,
      branches: result.branches,
      hasMore: result.hasMore,
      endCursor: result.endCursor,
    };
  },
);

// Get files actor - lists files in the repository tree without downloading content
type FilesResult = {
  type: 'filesRetrieved';
  files: Array<{ path: string; size: number }>;
};

const getFilesActor = fromPromise<FilesResult, { owner: string; repo: string; ref: string }>(
  async ({ input }): Promise<FilesResult> => {
    const client = getGitHubClient();
    const files = await client.listFiles(input.owner, input.repo, input.ref);

    return {
      type: 'filesRetrieved' as const,
      files,
    };
  },
);

// Download actor
const downloadZipActor = fromPromise<
  DownloadResult,
  {
    owner: string;
    repo: string;
    ref: string;
    onProgress: (loaded: number, total: number) => void;
  }
>(async ({ input, signal }) => {
  const client = getGitHubClient();

  // Download the archive and get size from the GET response headers
  // Pass the signal to abort the fetch request if canceled
  const { stream, size: contentLength } = await client.downloadArchiveWithSize(
    input.owner,
    input.repo,
    input.ref,
    signal,
  );

  // Use size from Content-Length header (available immediately when download starts)
  const totalBytes = contentLength ?? 0;

  // Send initial progress with total size
  input.onProgress(0, totalBytes);

  const reader = stream.getReader();

  const chunks: Uint8Array[] = [];
  let receivedLength = 0;
  let lastProgressUpdate = 0;
  const progressUpdateInterval = 100; // Update every 100ms

  try {
    // Read the stream in chunks
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- standard stream reading pattern
    while (true) {
      // Check if aborted before reading next chunk
      if (signal.aborted) {
        // eslint-disable-next-line no-await-in-loop -- need to cancel stream before throwing
        await reader.cancel();
        throw new Error('Download canceled');
      }

      // eslint-disable-next-line no-await-in-loop -- reading stream sequentially
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      chunks.push(value);
      receivedLength += value.length;

      // Throttle progress updates to avoid overwhelming the UI
      const now = Date.now();
      if (now - lastProgressUpdate >= progressUpdateInterval || lastProgressUpdate === 0) {
        input.onProgress(receivedLength, totalBytes);
        lastProgressUpdate = now;
      }
    }

    // Always send final progress update with actual total
    input.onProgress(receivedLength, totalBytes);

    // Combine chunks into a single Uint8Array
    const zipData = new Uint8Array(receivedLength);
    let position = 0;
    for (const chunk of chunks) {
      zipData.set(chunk, position);
      position += chunk.length;
    }

    return { type: 'downloaded', blob: new Blob([zipData], { type: 'application/zip' }) };
  } finally {
    // Always release the reader lock
    reader.releaseLock();
  }
});

// This actor should be provided via the `provide` mechanism in the route
const createBuildActor = fromPromise<
  { type: 'buildCreated'; buildId: string },
  {
    owner: string;
    repo: string;
    ref: string;
    mainFile: string;
    files: Map<string, { filename: string; content: Uint8Array }>;
  }
>(async () => {
  throw new Error('Not implemented');
});

const importGitHubActors = {
  getRepoMetadataActor,
  getBranchesActor,
  getFilesActor,
  downloadZipActor,
  createBuildActor,
} as const;

type ImportGitHubActorNames = keyof typeof importGitHubActors;

// Define the events that actors can emit
export type ImportGitHubEventExternal = OutputFrom<(typeof importGitHubActors)[ImportGitHubActorNames]>;
type ImportGitHubEventExternalDone = DoneActorEvent<ImportGitHubEventExternal, ImportGitHubActorNames>;

/**
 * Import GitHub Machine
 *
 * Manages importing a GitHub repository as a build.
 *
 * States:
 * - downloading: Downloading ZIP from GitHub with progress tracking
 * - extracting: Extracting files from ZIP with progress tracking
 * - selectingMainFile: User reviews files and selects main file
 * - creating: Creating the build with selected main file
 * - success: Import completed successfully
 * - error: An error occurred during import
 *
 * Progress Tracking:
 * - Download progress is tracked via contentLength header or receivedLength
 * - Extract progress is tracked via processed/total file counts
 * - Progress updates are applied immediately for responsive UI feedback
 */
export const importGitHubMachine = setup({
  types: {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    context: {} as ImportGitHubContext,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    events: {} as ImportGitHubEvent,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    input: {} as ImportGitHubInput,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    emitted: {} as ImportGitHubEmitted,
  },
  actors: {
    ...importGitHubActors,
    unzipMachine,
  },
  delays: {
    debounceDelay: 500,
  },
  actions: {
    setError: assign({
      error({ event }) {
        if ('error' in event && event.error instanceof Error) {
          return event.error;
        }

        return new Error('Unknown error');
      },
    }),
    clearError: assign({
      error: undefined,
      fetchErrors: {
        metadata: undefined,
        branches: undefined,
        files: undefined,
      },
    }),
    updateRepoUrl: assign({
      repoUrl({ event }) {
        assertEvent(event, 'updateRepoUrl');
        return event.url;
      },
      // Clear navigation flag - this is a user-driven change
      urlFromNavigation: false,
    }),
    parseRepoUrl: assign(({ context }) => {
      // If URL is empty, reset all repo-related state
      if (!context.repoUrl) {
        return {
          owner: '',
          repo: '',
          ref: 'main',
          repoMetadata: undefined,
          branches: [],
          selectedBranch: 'main',
          branchesCursor: undefined,
          hasMoreBranches: false,
          repoFiles: [],
          selectedMainFile: undefined,
        };
      }

      // Parse GitHub URL and extract owner/repo/ref
      try {
        const url = new URL(context.repoUrl);
        if (url.hostname !== 'github.com') {
          return {
            owner: '',
            repo: '',
            repoMetadata: undefined,
            branches: [],
            repoFiles: [],
          };
        }

        const pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts.length < 2) {
          return {
            owner: '',
            repo: '',
            repoMetadata: undefined,
            branches: [],
            repoFiles: [],
          };
        }

        const [owner, repoRaw] = pathParts;
        if (!owner || !repoRaw) {
          return {
            owner: '',
            repo: '',
            repoMetadata: undefined,
            branches: [],
          };
        }

        const repo = repoRaw.replace(/\.git$/, '');
        const ref = 'main'; // Default to main, could be extended later

        // If the repo changed, clear metadata and branches
        if (owner !== context.owner || repo !== context.repo) {
          return {
            owner,
            repo,
            ref,
            repoMetadata: undefined,
            branches: [],
            selectedBranch: 'main',
            branchesCursor: undefined,
            hasMoreBranches: false,
          };
        }

        return { owner, repo, ref };
      } catch {
        return {
          owner: '',
          repo: '',
          repoMetadata: undefined,
          branches: [],
        };
      }
    }),
    setRepoMetadata: assign({
      repoMetadata({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'metadataRetrieved');
        return event.output.metadata;
      },
      selectedBranch({ event, context }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'metadataRetrieved');
        // Use default branch from metadata, or keep current selection
        return event.output.metadata.defaultBranch ?? context.selectedBranch;
      },
      ref({ event, context }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'metadataRetrieved');
        // If ref is 'main' and metadata has a different default branch, use it
        // This handles cases where repos use 'master' or other default branches
        return context.ref === 'main' && event.output.metadata.defaultBranch
          ? event.output.metadata.defaultBranch
          : context.ref;
      },
      fetchErrors({ context }) {
        return {
          ...context.fetchErrors,
          metadata: undefined,
        };
      },
      error: undefined,
    }),
    setBranches: assign({
      branches({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'branchesRetrieved');
        return event.output.branches;
      },
      hasMoreBranches({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'branchesRetrieved');
        return event.output.hasMore;
      },
      branchesCursor({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'branchesRetrieved');
        return event.output.endCursor;
      },
    }),
    appendBranches: assign({
      branches({ event, context }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'branchesRetrieved');
        // Filter out branches that already exist to prevent duplicates
        const existingNames = new Set(context.branches.map((b) => b.name));
        const newBranches = event.output.branches.filter((b) => !existingNames.has(b.name));
        return [...context.branches, ...newBranches];
      },
      hasMoreBranches({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'branchesRetrieved');
        return event.output.hasMore;
      },
      branchesCursor({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'branchesRetrieved');
        return event.output.endCursor;
      },
      isLoadingMoreBranches: false,
    }),
    setLoadingMoreBranches: assign({
      isLoadingMoreBranches: true,
    }),
    setSelectedBranch: assign({
      selectedBranch({ event }) {
        assertEvent(event, 'selectBranch');
        return event.branch;
      },
      ref({ event }) {
        assertEvent(event, 'selectBranch');
        return event.branch;
      },
    }),
    applyDownloadProgressImmediately: assign({
      downloadProgress({ event }) {
        assertEvent(event, 'updateDownloadProgress');
        return { loaded: event.loaded, total: event.total };
      },
    }),
    applyExtractProgressImmediately: assign({
      extractProgress({ event }) {
        assertEvent(event, 'updateExtractProgress');
        return { processed: event.processed, total: event.total };
      },
    }),
    setFiles: assign({
      files({ event }) {
        if ('output' in event && event.output instanceof Map) {
          return event.output;
        }

        return new Map();
      },
    }),
    setBuildId: assign({
      buildId({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'buildCreated');
        return event.output.buildId;
      },
    }),
    initializeSelectedMainFile: assign({
      selectedMainFile({ context }) {
        // If main file was requested and exists, use it; otherwise undefined for user selection
        const fileNames = [...context.files.keys()];

        if (context.requestedMainFile.length > 0 && fileNames.includes(context.requestedMainFile)) {
          return context.requestedMainFile;
        }

        // Try to find a CAD file as suggestion
        const cadExtensions = ['.scad', '.jscad', '.ts', '.js'];
        const foundFile = fileNames.find((filename) => cadExtensions.some((ext) => filename.endsWith(ext)));

        return foundFile;
      },
    }),
    spawnUnzipMachine: assign({
      unzipRef({ spawn }) {
        return spawn('unzipMachine', { id: 'unzip', input: {} });
      },
    }),
    sendExtractToUnzip: enqueueActions(({ enqueue, context, event }) => {
      assertActorDoneEvent(event);
      assertEvent(event.output, 'downloaded');
      if (context.unzipRef) {
        enqueue.sendTo(context.unzipRef, { type: 'extract', zipBlob: event.output.blob });
      }
    }),
    setMetadataError: assign({
      fetchErrors: ({ context, event }) => ({
        ...context.fetchErrors,
        metadata:
          'error' in event && event.error instanceof Error
            ? event.error
            : new Error('Failed to fetch repository metadata'),
      }),
    }),
    setBranchesError: assign({
      fetchErrors: ({ context, event }) => ({
        ...context.fetchErrors,
        branches:
          'error' in event && event.error instanceof Error ? event.error : new Error('Failed to fetch branches'),
      }),
    }),
    setRepoFiles: assign({
      repoFiles({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'filesRetrieved');
        return event.output.files;
      },
      isLoadingFiles: false,
    }),
    setRepoFilesError: assign({
      fetchErrors: ({ context, event }) => ({
        ...context.fetchErrors,
        files: 'error' in event && event.error instanceof Error ? event.error : new Error('Failed to fetch files'),
      }),
      isLoadingFiles: false,
    }),
    setLoadingRepoFiles: assign({
      isLoadingFiles: true,
    }),
    setSelectedMainFile: assign({
      selectedMainFile({ event }) {
        assertEvent(event, 'selectMainFile');
        return event.file;
      },
    }),
    // Sync location from React Router (for back/forward navigation)
    syncLocation: assign(({ event }) => {
      assertEvent(event, 'syncLocation');

      // If no owner/repo from location, reset to empty state
      if (!event.owner || !event.repo) {
        return {
          repoUrl: '',
          owner: '',
          repo: '',
          ref: 'main',
          selectedBranch: 'main',
          repoMetadata: undefined,
          branches: [],
          branchesCursor: undefined,
          hasMoreBranches: false,
          repoFiles: [],
          selectedMainFile: undefined,
          urlFromNavigation: true, // Mark as navigation-driven
        };
      }

      return {
        repoUrl: `https://github.com/${event.owner}/${event.repo}`,
        owner: event.owner,
        repo: event.repo,
        ref: event.ref || 'main',
        selectedBranch: event.ref || 'main',
        requestedMainFile: event.mainFile || '',
        selectedMainFile: event.mainFile || undefined,
        urlFromNavigation: true, // Mark as navigation-driven
      };
    }),
    // Emit URL replacement for real-time typing updates (no history change)
    emitUrlReplaced: enqueueActions(({ enqueue, context }) => {
      const url = buildImportUrl(context.owner, context.repo, context.selectedBranch, context.selectedMainFile);
      enqueue.emit({ type: 'urlReplaced' as const, url });
    }),
    // Emit URL push for meaningful navigation points (adds to history)
    emitUrlPushed: enqueueActions(({ enqueue, context }) => {
      const url = buildImportUrl(context.owner, context.repo, context.selectedBranch, context.selectedMainFile);
      enqueue.emit({ type: 'urlPushed' as const, url });
    }),
    // Emit URL based on whether we're clearing or setting a full repo URL
    // Clearing (empty URL) → push to history
    // Valid repo detected → push to history (for back button support)
    // Partial/incomplete URL → replace (for real-time typing feedback)
    emitUrlChange: enqueueActions(({ enqueue, context }) => {
      const url = buildImportUrl(context.owner, context.repo, context.selectedBranch, context.selectedMainFile);
      // If owner/repo are empty, this is a clear action - push to history
      if (!context.owner || !context.repo) {
        enqueue.emit({ type: 'urlPushed' as const, url });
      } else {
        // Valid repo - always replace during typing; we'll push on debounce completion
        enqueue.emit({ type: 'urlReplaced' as const, url });
      }
    }),
  },
  guards: {
    hasValidRepo({ context }) {
      return context.owner.length > 0 && context.repo.length > 0 && context.ref.length > 0;
    },
    hasValidRepoWithoutError({ context }) {
      return (
        context.owner.length > 0 && context.repo.length > 0 && context.ref.length > 0 && context.error === undefined
      );
    },
    shouldFetchRepoInfo({ context }) {
      // Only fetch if we have a valid repo AND we haven't fetched metadata yet (or encountered a blocking error)
      return (
        context.owner.length > 0 &&
        context.repo.length > 0 &&
        context.ref.length > 0 &&
        context.repoMetadata === undefined &&
        context.fetchErrors.metadata === undefined
      );
    },
    hasSelectedMainFile({ context }) {
      return context.selectedMainFile !== undefined && context.selectedMainFile.length > 0;
    },
    hasCriticalFetchError({ context }) {
      // Critical errors are 404 or rate limit on metadata (means repo doesn't exist or is inaccessible)
      const metadataError = context.fetchErrors.metadata;
      if (!metadataError) {
        return false;
      }

      const errorMessage = metadataError.message;
      return errorMessage.includes('404') || errorMessage.includes('403') || errorMessage.includes('rate limit');
    },
    canLoadMoreBranches({ context }) {
      return context.hasMoreBranches && !context.isLoadingMoreBranches;
    },
    // Check if location sync would change the current state
    locationDiffersFromState({ context, event }) {
      assertEvent(event, 'syncLocation');
      const currentRepoUrl = context.owner && context.repo ? `https://github.com/${context.owner}/${context.repo}` : '';
      const newRepoUrl = event.owner && event.repo ? `https://github.com/${event.owner}/${event.repo}` : '';
      return currentRepoUrl !== newRepoUrl || context.selectedBranch !== (event.ref || 'main');
    },
    // Only push URL to history if not from navigation (avoids double-push)
    shouldPushUrl({ context }) {
      return !context.urlFromNavigation;
    },
    // Combined guard: valid repo AND should push URL
    hasValidRepoAndShouldPush({ context }) {
      return (
        context.owner.length > 0 && context.repo.length > 0 && context.ref.length > 0 && !context.urlFromNavigation
      );
    },
  },
}).createMachine({
  id: 'importGitHub',
  context: ({ input }) => ({
    parentRef: input.parentRef,
    repoUrl: input.owner && input.repo ? `https://github.com/${input.owner}/${input.repo}` : '',
    owner: input.owner ?? '',
    repo: input.repo ?? '',
    ref: input.ref ?? 'main',
    requestedMainFile: input.mainFile ?? '',
    // Initialize selectedMainFile from input if provided (for URL loading with ?main=)
    // Empty string means no file selected, so treat as undefined
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentionally treat '' as falsy
    selectedMainFile: input.mainFile || undefined,
    repoMetadata: undefined,
    branches: [],
    selectedBranch: input.ref ?? 'main',
    branchesCursor: undefined,
    hasMoreBranches: false,
    isLoadingMoreBranches: false,
    repoFiles: [],
    isLoadingFiles: false,
    downloadProgress: { loaded: 0, total: 0 },
    extractProgress: { processed: 0, total: 0 },
    unzipRef: undefined,
    unzipSubscription: undefined,
    files: new Map(),
    buildId: undefined,
    error: undefined,
    fetchErrors: {
      metadata: undefined,
      branches: undefined,
      files: undefined,
    },
    // If we have owner and repo from input, this is from URL navigation
    urlFromNavigation: Boolean(input.owner && input.repo),
  }),
  initial: 'enteringDetails',
  states: {
    enteringDetails: {
      always: [
        {
          target: 'checkingRepo',
          guard: 'shouldFetchRepoInfo',
        },
      ],
      on: {
        updateRepoUrl: {
          actions: ['clearError', 'updateRepoUrl', 'parseRepoUrl', 'emitUrlChange'],
          target: 'checkingRepo',
          reenter: true,
        },
        selectBranch: {
          // When branch changes, re-fetch files for the new branch
          actions: ['setSelectedBranch', 'emitUrlReplaced'],
          target: 'fetchingFiles',
        },
        selectMainFile: {
          actions: ['setSelectedMainFile', 'emitUrlReplaced'],
        },
        syncLocation: {
          actions: 'syncLocation',
          guard: 'locationDiffersFromState',
          target: 'checkingRepo',
          reenter: true,
        },
        startImport: {
          target: 'downloading',
          guard: 'hasValidRepo',
        },
        loadMoreBranches: {
          target: 'loadingMoreBranches',
          guard: 'canLoadMoreBranches',
        },
      },
    },
    loadingMoreBranches: {
      entry: 'setLoadingMoreBranches',
      invoke: {
        id: 'loadMoreBranches',
        src: 'getBranchesActor',
        input: ({ context }) => ({
          owner: context.owner,
          repo: context.repo,
          cursor: context.branchesCursor,
        }),
        onDone: {
          target: 'enteringDetails',
          actions: 'appendBranches',
        },
        onError: {
          target: 'enteringDetails',
          actions: assign({
            isLoadingMoreBranches: false,
          }),
        },
      },
      on: {
        updateRepoUrl: {
          actions: ['clearError', 'updateRepoUrl', 'parseRepoUrl', 'emitUrlChange'],
          target: 'checkingRepo',
          reenter: true,
        },
        selectBranch: {
          // When branch changes, re-fetch files for the new branch
          actions: ['setSelectedBranch', 'emitUrlReplaced'],
          target: 'fetchingFiles',
        },
        selectMainFile: {
          actions: ['setSelectedMainFile', 'emitUrlReplaced'],
        },
        syncLocation: {
          actions: 'syncLocation',
          guard: 'locationDiffersFromState',
          target: 'checkingRepo',
          reenter: true,
        },
      },
    },
    checkingRepo: {
      after: {
        debounceDelay: [
          {
            target: 'fetchingRepoInfo',
            guard: 'hasValidRepoAndShouldPush',
            // Push URL when valid repo is detected via typing (debounce completed)
            // Only push if NOT from navigation (avoids double-push)
            actions: 'emitUrlPushed',
          },
          {
            target: 'fetchingRepoInfo',
            guard: 'hasValidRepo',
            // From navigation - don't push URL (already pushed by React Router)
          },
        ],
      },
      on: {
        updateRepoUrl: {
          actions: ['updateRepoUrl', 'parseRepoUrl', 'emitUrlChange'],
          target: 'checkingRepo',
          reenter: true,
        },
        syncLocation: {
          actions: 'syncLocation',
          guard: 'locationDiffersFromState',
          target: 'checkingRepo',
          reenter: true,
        },
        startImport: {
          target: 'downloading',
          guard: 'hasValidRepo',
        },
      },
    },
    fetchingRepoInfo: {
      type: 'parallel',
      states: {
        metadata: {
          initial: 'fetching',
          states: {
            fetching: {
              invoke: {
                id: 'fetchMetadata',
                src: 'getRepoMetadataActor',
                input: ({ context }) => ({
                  owner: context.owner,
                  repo: context.repo,
                }),
                onDone: {
                  target: 'success',
                  actions: 'setRepoMetadata',
                },
                onError: {
                  target: 'error',
                  actions: [
                    'setMetadataError',
                    assign({
                      repoMetadata: undefined,
                      error: ({ event }) => toMetadataFetchError(event.error),
                    }),
                  ],
                },
              },
            },
            success: {
              type: 'final',
            },
            error: {
              type: 'final',
            },
          },
        },
        branches: {
          initial: 'fetching',
          states: {
            fetching: {
              invoke: {
                id: 'fetchBranches',
                src: 'getBranchesActor',
                input: ({ context }) => ({
                  owner: context.owner,
                  repo: context.repo,
                  cursor: undefined,
                }),
                onDone: {
                  target: 'success',
                  actions: 'setBranches',
                },
                onError: {
                  target: 'error',
                  actions: [
                    'setBranchesError',
                    assign({
                      branches: [],
                      hasMoreBranches: false,
                    }),
                  ],
                },
              },
            },
            success: {
              type: 'final',
            },
            error: {
              type: 'final',
            },
          },
        },
        files: {
          initial: 'fetching',
          states: {
            fetching: {
              entry: 'setLoadingRepoFiles',
              invoke: {
                id: 'fetchFiles',
                src: 'getFilesActor',
                input: ({ context }) => ({
                  owner: context.owner,
                  repo: context.repo,
                  ref: context.selectedBranch,
                }),
                onDone: {
                  target: 'success',
                  actions: 'setRepoFiles',
                },
                onError: {
                  target: 'error',
                  actions: [
                    'setRepoFilesError',
                    assign({
                      repoFiles: [],
                    }),
                  ],
                },
              },
            },
            success: {
              type: 'final',
            },
            error: {
              type: 'final',
            },
          },
        },
      },
      onDone: {
        target: 'enteringDetails',
      },
      on: {
        updateRepoUrl: {
          actions: ['updateRepoUrl', 'parseRepoUrl', 'emitUrlChange'],
          target: 'checkingRepo',
          reenter: true,
        },
        syncLocation: {
          actions: 'syncLocation',
          guard: 'locationDiffersFromState',
          target: 'checkingRepo',
          reenter: true,
        },
      },
    },
    // Fetch files only (when branch changes)
    fetchingFiles: {
      entry: 'setLoadingRepoFiles',
      invoke: {
        id: 'fetchFilesOnBranchChange',
        src: 'getFilesActor',
        input: ({ context }) => ({
          owner: context.owner,
          repo: context.repo,
          ref: context.selectedBranch,
        }),
        onDone: {
          target: 'enteringDetails',
          actions: 'setRepoFiles',
        },
        onError: {
          target: 'enteringDetails',
          actions: [
            'setRepoFilesError',
            assign({
              repoFiles: [],
            }),
          ],
        },
      },
      on: {
        updateRepoUrl: {
          actions: ['updateRepoUrl', 'parseRepoUrl', 'emitUrlChange'],
          target: 'checkingRepo',
          reenter: true,
        },
        selectBranch: {
          // If branch changes while fetching files, restart with new branch
          actions: ['setSelectedBranch', 'emitUrlReplaced'],
          target: 'fetchingFiles',
          reenter: true,
        },
        syncLocation: {
          actions: 'syncLocation',
          guard: 'locationDiffersFromState',
          target: 'checkingRepo',
          reenter: true,
        },
      },
    },
    downloading: {
      entry: ['clearError', 'spawnUnzipMachine'],
      invoke: {
        src: 'downloadZipActor',
        input: ({ context, self }) => ({
          owner: context.owner,
          repo: context.repo,
          ref: context.ref,
          onProgress(loaded: number, total: number) {
            self.send({ type: 'updateDownloadProgress', loaded, total });
          },
        }),
        onDone: {
          target: 'extracting',
          actions: 'sendExtractToUnzip',
        },
        onError: {
          target: 'error',
          actions: 'setError',
        },
      },
      on: {
        updateDownloadProgress: {
          actions: 'applyDownloadProgressImmediately',
        },
        cancelDownload: {
          target: 'enteringDetails',
          actions: 'clearError',
        },
      },
    },
    extracting: {
      entry: assign({
        unzipSubscription({ context, self }) {
          // Subscribe to the spawned unzip machine's state changes and events
          if (!context.unzipRef) {
            return undefined;
          }

          // Subscribe to state changes
          const stateSubscription = context.unzipRef.subscribe((state) => {
            if (state.matches('ready')) {
              // Unzip completed successfully
              self.send({
                type: 'extractionComplete',
                files: state.context.files,
              });
            } else if (state.matches('error')) {
              // Unzip failed
              self.send({
                type: 'extractionError',
                error: state.context.error ?? new Error('Failed to extract ZIP'),
              });
            }
            // If state is 'extracting' or 'idle', we just wait for the next state change
          });

          // Subscribe to progress events
          const progressSubscription = context.unzipRef.on('progress', ({ processedBytes, totalBytes }) => {
            self.send({
              type: 'updateExtractProgress',
              processed: processedBytes,
              total: totalBytes,
            });
          });

          // Return combined cleanup
          return {
            unsubscribe() {
              stateSubscription.unsubscribe();
              progressSubscription.unsubscribe();
            },
          };
        },
      }),
      exit({ context }) {
        // Clean up subscription
        if (context.unzipSubscription) {
          context.unzipSubscription.unsubscribe();
        }
      },
      on: {
        updateExtractProgress: {
          actions: 'applyExtractProgressImmediately',
        },
        cancelDownload: {
          target: 'enteringDetails',
          actions: 'clearError',
        },
        extractionComplete: {
          target: 'selectingMainFile',
          actions: [
            assign({
              files({ event }) {
                assertEvent(event, 'extractionComplete');
                return event.files;
              },
            }),
            'initializeSelectedMainFile',
          ],
        },
        extractionError: {
          target: 'error',
          actions: assign({
            error({ event }) {
              assertEvent(event, 'extractionError');
              return event.error;
            },
          }),
        },
      },
    },
    selectingMainFile: {
      on: {
        selectMainFile: {
          actions: 'setSelectedMainFile',
        },
        confirmImport: {
          target: 'creating',
          guard: 'hasSelectedMainFile',
        },
      },
    },
    creating: {
      invoke: {
        src: 'createBuildActor',
        input: ({ context }) => ({
          owner: context.owner,
          repo: context.repo,
          ref: context.ref,
          mainFile: context.selectedMainFile!,
          files: context.files,
        }),
        onDone: {
          target: 'success',
          actions: 'setBuildId',
        },
        onError: {
          target: 'error',
          actions: 'setError',
        },
      },
    },
    success: {
      type: 'final',
    },
    error: {
      on: {
        retry: 'enteringDetails',
      },
    },
  },
});

export type ImportGitHubMachineActor = typeof importGitHubMachine;
