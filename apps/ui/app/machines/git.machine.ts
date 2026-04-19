import { assign, assertEvent, setup, emit, fromCallback, waitFor } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import type { FileStat } from '@taucad/types';
import { fromSafeAsync } from '#lib/xstate.lib.js';
import { gitAttributesTemplate } from '#constants/gitattributes-template.js';
import { joinPath } from '@taucad/utils/path';
import type { FileManagerMachine } from '#machines/file-manager.machine.js';
import type { FileManagerProxy } from '#machines/file-manager.machine.types.js';
import type { FileContentService } from '#lib/file-content-service.js';

/** Git mount point prefix for git operations within the filesystem. */
const gitMountPrefix = '/git';

/**
 * Get the directory path for a project in the git virtual filesystem.
 * Uses the /git prefix for isolated git storage.
 */
export function getProjectDirectory(projectId: string): string {
  return joinPath(gitMountPrefix, 'projects', projectId);
}

/**
 * Wrap a simplified stat result into an isomorphic-git-compatible stat object.
 */

function wrapStat(s: FileStat): {
  size: number;
  mode: number;
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
} {
  return {
    isFile: () => s.type === 'file',
    isDirectory: () => s.type === 'dir',
    isSymbolicLink: () => false,
    size: s.size,
    mode: s.type === 'dir' ? 0o4_0755 : 0o10_0644,
    mtimeMs: s.mtimeMs,
  };
}

type GitFsAdapter = {
  promises: {
    readFile(path: string, options?: { encoding?: string }): Promise<unknown>;
    writeFile(path: string, data: unknown, encoding?: string): Promise<void>;
    stat(path: string): Promise<ReturnType<typeof wrapStat>>;
    lstat(path: string): Promise<ReturnType<typeof wrapStat>>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    readdir(path: string): Promise<string[]>;
    unlink(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
  };
};

/**
 * Create an isomorphic-git-compatible `fs` adapter from a FileManagerProxy.
 * Wraps stat/lstat return values so they include isFile()/isDirectory()/isSymbolicLink().
 */
function createGitFsAdapter(proxy: FileManagerProxy): GitFsAdapter {
  return {
    promises: {
      async readFile(path: string, options?: { encoding?: string }): Promise<unknown> {
        if (options?.encoding === 'utf8') {
          return proxy.readFile(path, 'utf8');
        }

        return proxy.readFile(path);
      },
      async writeFile(path: string, data: unknown): Promise<void> {
        return proxy.writeFile(path, data as Uint8Array<ArrayBuffer> | string);
      },
      async stat(path: string): Promise<ReturnType<typeof wrapStat>> {
        return wrapStat(await proxy.stat(path));
      },
      async lstat(path: string): Promise<ReturnType<typeof wrapStat>> {
        return wrapStat(await proxy.lstat(path));
      },
      async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
        return proxy.mkdir(path, options);
      },
      async readdir(path: string): Promise<string[]> {
        return proxy.readdir(path);
      },
      async unlink(path: string): Promise<void> {
        return proxy.unlink(path);
      },
      async rmdir(path: string): Promise<void> {
        return proxy.rmdir(path);
      },
    },
  };
}

/**
 * Obtain a git-compatible fs adapter from a file manager actor ref.
 * Waits for the file manager to enter the 'ready' state, then wraps its proxy.
 */
async function getGitFs(fileManagerReference: ActorRefFrom<FileManagerMachine>): Promise<GitFsAdapter> {
  const snapshot = await waitFor(fileManagerReference, (state) => state.matches('ready'));
  const { proxy } = snapshot.context;
  if (!proxy) {
    throw new Error('File manager proxy not available');
  }

  return createGitFsAdapter(proxy);
}

/**
 * Git File Status
 */
export type GitFileStatus = {
  path: string;
  status: 'clean' | 'modified' | 'added' | 'deleted' | 'untracked';
  staged: boolean;
};

/**
 * Git Repository Info
 */
export type GitRepository = {
  owner: string;
  name: string;
  url: string;
  branch: string;
};

/**
 * Git Machine Context
 */
export type GitContext = {
  projectId: string | undefined;
  accessToken: string | undefined;
  provider: 'github' | undefined;
  repository: GitRepository | undefined;
  fileStatuses: Map<string, GitFileStatus>;
  stagedFiles: Set<string>;
  commitMessage: string | undefined;
  error: Error | undefined;
  isInitialized: boolean;
  username: string | undefined;
  email: string | undefined;
  fileManagerRef: ActorRefFrom<FileManagerMachine>;
};

/**
 * Git Machine Input
 */
type GitInput = {
  projectId?: string;
  fileManagerRef: ActorRefFrom<FileManagerMachine>;
};

export type GitActorInput = {
  fileManagerRef: ActorRefFrom<FileManagerMachine>;
};

const initGitActor = fromSafeAsync<void, GitActorInput & { projectId: string; repository: GitRepository }>(
  async ({ input }) => {
    const fs = await getGitFs(input.fileManagerRef);
    const directory = getProjectDirectory(input.projectId);

    await git.init({ fs, dir: directory, defaultBranch: input.repository.branch });

    await git.addRemote({
      fs,
      dir: directory,
      remote: 'origin',
      url: input.repository.url,
    });

    const gitAttributesPath = joinPath(directory, '.gitattributes');
    try {
      await fs.promises.stat(gitAttributesPath);
    } catch {
      await fs.promises.writeFile(gitAttributesPath, gitAttributesTemplate, 'utf8');
    }
  },
);

type CloneRepositoryInput = GitActorInput & {
  projectId: string;
  repository: GitRepository;
  accessToken: string;
  username: string;
};

const cloneRepositoryActor = fromSafeAsync<void, CloneRepositoryInput>(async ({ input }) => {
  const fs = await getGitFs(input.fileManagerRef);
  const directory = getProjectDirectory(input.projectId);

  await git.clone({
    fs,
    http,
    dir: directory,
    url: input.repository.url,
    ref: input.repository.branch,
    singleBranch: true,
    depth: 1,
    onAuth: () => ({
      username: input.username,
      password: input.accessToken,
    }),
  });
});

type StageInput = GitActorInput & { projectId: string; path: string };

const stageFileActor = fromSafeAsync<{ type: 'fileStaged'; path: string }, StageInput>(async ({ input }) => {
  const fs = await getGitFs(input.fileManagerRef);
  const directory = getProjectDirectory(input.projectId);

  await git.add({
    fs,
    dir: directory,
    filepath: input.path,
  });

  return { type: 'fileStaged', path: input.path };
});

const unstageFileActor = fromSafeAsync<{ type: 'fileUnstaged'; path: string }, StageInput>(async ({ input }) => {
  const fs = await getGitFs(input.fileManagerRef);
  const directory = getProjectDirectory(input.projectId);

  await git.remove({
    fs,
    dir: directory,
    filepath: input.path,
  });

  return { type: 'fileUnstaged', path: input.path };
});

type CommitInput = GitActorInput & {
  projectId: string;
  message: string;
  username: string;
  email: string;
};

const commitChangesActor = fromSafeAsync<{ type: 'commitCreated'; sha: string }, CommitInput>(async ({ input }) => {
  const fs = await getGitFs(input.fileManagerRef);
  const directory = getProjectDirectory(input.projectId);

  const sha = await git.commit({
    fs,
    dir: directory,
    message: input.message,
    author: {
      name: input.username,
      email: input.email,
    },
  });

  return { type: 'commitCreated', sha };
});

const pushChangesActor = fromSafeAsync<void, CloneRepositoryInput>(async ({ input }) => {
  const fs = await getGitFs(input.fileManagerRef);
  const directory = getProjectDirectory(input.projectId);

  await git.push({
    fs,
    http,
    dir: directory,
    remote: 'origin',
    ref: input.repository.branch,
    onAuth: () => ({
      username: input.username,
      password: input.accessToken,
    }),
  });
});

const pullChangesActor = fromSafeAsync<void, CloneRepositoryInput>(async ({ input }) => {
  const fs = await getGitFs(input.fileManagerRef);
  const directory = getProjectDirectory(input.projectId);

  await git.pull({
    fs,
    http,
    dir: directory,
    ref: input.repository.branch,
    author: {
      name: input.username,
      email: input.username,
    },
    onAuth: () => ({
      username: input.username,
      password: input.accessToken,
    }),
  });
});

// oxlint-disable-next-line complexity -- TODO: address
const refreshGitStatusActor = fromSafeAsync<
  { type: 'statusRefreshed'; fileStatuses: Map<string, GitFileStatus> },
  GitActorInput & { projectId: string }
>(async ({ input }) => {
  const fs = await getGitFs(input.fileManagerRef);
  const directory = getProjectDirectory(input.projectId);

  try {
    const statusMatrix = await git.statusMatrix({ fs, dir: directory });
    const fileStatuses = new Map<string, GitFileStatus>();

    for (const [filepath, headStatus, workdirStatus, stageStatus] of statusMatrix) {
      let status: 'clean' | 'modified' | 'added' | 'deleted' | 'untracked' = 'clean';
      let staged = false;

      if (headStatus === 0 && workdirStatus === 2 && stageStatus === 0) {
        status = 'untracked';
      } else if (headStatus === 1 && workdirStatus === 2 && stageStatus === 2) {
        status = 'clean';
      } else if (headStatus === 1 && workdirStatus === 2 && stageStatus === 1) {
        status = 'modified';
        staged = false;
      } else if (headStatus === 0 && workdirStatus === 2 && stageStatus === 2) {
        status = 'added';
        staged = true;
      } else if (headStatus === 1 && workdirStatus === 0) {
        status = 'deleted';
      } else if (stageStatus === 2) {
        staged = true;
        if (headStatus === 1 && workdirStatus === 2) {
          status = 'modified';
        }
      }

      fileStatuses.set(filepath, {
        path: filepath,
        status,
        staged,
      });
    }

    return { type: 'statusRefreshed', fileStatuses };
  } catch {
    return { type: 'statusRefreshed', fileStatuses: new Map<string, GitFileStatus>() };
  }
});

const projectListenerActor = fromCallback<
  { type: 'refreshStatus' },
  { contentService: FileContentService | undefined }
>(({ input, sendBack }) => {
  if (!input.contentService) {
    return () => {
      // No cleanup needed
    };
  }

  return input.contentService.onDidContentChange((event) => {
    if (event.type !== 'read') {
      sendBack({ type: 'refreshStatus' });
    }
  });
});

const gitActors = {
  initGitActor,
  cloneRepositoryActor,
  stageFileActor,
  unstageFileActor,
  commitChangesActor,
  pushChangesActor,
  pullChangesActor,
  refreshGitStatusActor,
  buildListener: projectListenerActor,
} as const;

/**
 * Git Machine Events
 */
type GitEvent =
  | { type: 'connect'; projectId: string }
  | {
      type: 'authenticate';
      accessToken: string;
      username: string;
      email: string;
    }
  | { type: 'selectRepository'; repository: GitRepository }
  | { type: 'createRepository'; name: string; isPrivate: boolean }
  | { type: 'clone'; repository: GitRepository }
  | { type: 'stageFile'; path: string }
  | { type: 'unstageFile'; path: string }
  | { type: 'commit'; message: string }
  | { type: 'push' }
  | { type: 'pull' }
  | { type: 'refreshStatus' }
  | { type: 'disconnect' }
  | { type: 'retry' }
  | { type: 'fileStaged'; path: string }
  | { type: 'fileUnstaged'; path: string }
  | { type: 'commitCreated'; sha: string }
  | { type: 'statusRefreshed'; fileStatuses: Map<string, GitFileStatus> };

/**
 * Git Machine Emitted Events
 */
type GitEmitted =
  | { type: 'authenticationRequired' }
  | { type: 'authenticated'; username: string }
  | { type: 'repositorySelected'; repository: GitRepository }
  | { type: 'repositoryCreated'; repository: GitRepository }
  | { type: 'cloneComplete' }
  | { type: 'fileStaged'; path: string }
  | { type: 'fileUnstaged'; path: string }
  | { type: 'commitCreated'; sha: string }
  | { type: 'pushComplete' }
  | { type: 'pullComplete' }
  | { type: 'statusUpdated'; fileStatuses: Map<string, GitFileStatus> }
  | { type: 'error'; error: Error };

/**
 * Git Machine
 *
 * Orchestrates Git operations using isomorphic-git.
 * Manages authentication, repository connections, and version control operations.
 *
 * States:
 * - disconnected: No repository connected
 * - authenticating: OAuth flow in progress
 * - selectingRepo: Choosing or creating a repository
 * - cloning: Initial repository clone
 * - ready: Working directory ready for operations
 * - staging: Managing staged files
 * - committing: Creating a commit
 * - pushing: Uploading to remote
 * - pulling: Downloading from remote
 * - error: An error occurred
 */
export const gitMachine = setup({
  types: {
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    context: {} as GitContext,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    events: {} as GitEvent,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    emitted: {} as GitEmitted,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    input: {} as GitInput,
  },
  actors: gitActors,
  guards: {
    hasAccessToken({ context }) {
      return Boolean(context.accessToken);
    },
    isAuthError({ context }) {
      return Boolean(context.error?.message.includes('auth'));
    },
    isCloneError({ context }) {
      return Boolean(context.error?.message.includes('clone'));
    },
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
    }),
    setProjectId: assign({
      projectId({ event }) {
        assertEvent(event, 'connect');
        return event.projectId;
      },
    }),
    setAuthentication: assign({
      accessToken({ event }) {
        assertEvent(event, 'authenticate');
        return event.accessToken;
      },
      username({ event }) {
        assertEvent(event, 'authenticate');
        return event.username;
      },
      email({ event }) {
        assertEvent(event, 'authenticate');
        return event.email;
      },
    }),
    setRepository: assign({
      repository({ event }) {
        assertEvent(event, ['selectRepository', 'clone']);
        return event.repository;
      },
    }),
    updateFileStatuses: assign({
      fileStatuses({ event }) {
        assertEvent(event, 'statusRefreshed');
        return event.fileStatuses;
      },
      stagedFiles({ event }) {
        assertEvent(event, 'statusRefreshed');
        const staged = new Set<string>();
        for (const [path, status] of event.fileStatuses) {
          if (status.staged) {
            staged.add(path);
          }
        }

        return staged;
      },
    }),
    addToStagedFiles: assign({
      stagedFiles({ context, event }) {
        assertEvent(event, 'fileStaged');
        const updated = new Set(context.stagedFiles);
        updated.add(event.path);
        return updated;
      },
    }),
    removeFromStagedFiles: assign({
      stagedFiles({ context, event }) {
        assertEvent(event, 'fileUnstaged');
        const updated = new Set(context.stagedFiles);
        updated.delete(event.path);
        return updated;
      },
    }),
    setCommitMessage: assign({
      commitMessage({ event }) {
        assertEvent(event, 'commit');
        return event.message;
      },
    }),
    clearCommitMessage: assign({
      commitMessage: undefined,
    }),
    markInitialized: assign({
      isInitialized: true,
    }),
    disconnect: assign({
      repository: undefined,
      fileStatuses: new Map(),
      stagedFiles: new Set(),
      commitMessage: undefined,
      isInitialized: false,
    }),
  },
}).createMachine({
  id: 'git',
  context: ({ input }) => ({
    projectId: input.projectId,
    accessToken: undefined,
    provider: undefined,
    repository: undefined,
    fileStatuses: new Map(),
    stagedFiles: new Set(),
    commitMessage: undefined,
    error: undefined,
    isInitialized: false,
    username: undefined,
    email: undefined,
    fileManagerRef: input.fileManagerRef,
  }),
  initial: 'disconnected',
  states: {
    disconnected: {
      on: {
        connect: {
          target: 'checkingAuthentication',
          actions: 'setProjectId',
        },
      },
    },
    checkingAuthentication: {
      always: [
        {
          guard: 'hasAccessToken',
          target: 'selectingRepo',
        },
        {
          target: 'authenticating',
          actions: emit({ type: 'authenticationRequired' }),
        },
      ],
    },
    authenticating: {
      on: {
        authenticate: {
          target: 'selectingRepo',
          actions: [
            'setAuthentication',
            emit(({ event }) => ({
              type: 'authenticated',
              username: event.username,
            })),
          ],
        },
        disconnect: {
          target: 'disconnected',
        },
      },
    },
    selectingRepo: {
      on: {
        selectRepository: {
          target: 'cloning',
          actions: [
            'setRepository',
            emit(({ event }) => ({
              type: 'repositorySelected',
              repository: event.repository,
            })),
          ],
        },
        createRepository: {
          // Repository creation would be handled externally via GitHub API
          // then the created repo would be selected
          actions: emit(({ event }) => ({
            type: 'repositoryCreated',
            repository: {
              owner: '',
              name: event.name,
              url: '',
              branch: 'main',
            },
          })),
        },
        disconnect: {
          target: 'disconnected',
          actions: 'disconnect',
        },
      },
    },
    cloning: {
      entry: 'clearError',
      invoke: {
        src: 'cloneRepositoryActor',
        input: ({ context }) => ({
          fileManagerRef: context.fileManagerRef,
          projectId: context.projectId!,
          repository: context.repository!,
          accessToken: context.accessToken!,
          username: context.username!,
        }),
        onDone: {
          target: 'refreshingStatus',
          actions: ['markInitialized', emit({ type: 'cloneComplete' })],
        },
        onError: {
          target: 'error',
          actions: [
            'setError',
            emit(({ event }) => ({
              type: 'error',
              error: event.error as Error,
            })),
          ],
        },
      },
    },
    ready: {
      invoke: {
        id: 'buildListener',
        src: 'buildListener',
        input: ({ context }) => ({
          contentService: context.fileManagerRef.getSnapshot().context.contentService,
        }),
      },
      on: {
        stageFile: 'stagingFile',
        unstageFile: 'unstagingFile',
        commit: 'committing',
        push: 'pushing',
        pull: 'pulling',
        refreshStatus: 'refreshingStatus',
        disconnect: {
          target: 'disconnected',
          actions: 'disconnect',
        },
      },
    },
    stagingFile: {
      entry: 'clearError',
      invoke: {
        src: 'stageFileActor',
        input({ context, event }) {
          assertEvent(event, 'stageFile');
          return {
            fileManagerRef: context.fileManagerRef,
            projectId: context.projectId!,
            path: event.path,
          };
        },
        onDone: 'refreshingStatus',
        onError: {
          target: 'error',
          actions: [
            'setError',
            emit(({ event }) => ({
              type: 'error',
              error: event.error as Error,
            })),
          ],
        },
      },
      on: {
        fileStaged: {
          actions: [
            'addToStagedFiles',
            emit(({ event }) => ({
              type: 'fileStaged',
              path: event.path,
            })),
          ],
        },
      },
    },
    unstagingFile: {
      entry: 'clearError',
      invoke: {
        src: 'unstageFileActor',
        input({ context, event }) {
          assertEvent(event, 'unstageFile');
          return {
            fileManagerRef: context.fileManagerRef,
            projectId: context.projectId!,
            path: event.path,
          };
        },
        onDone: 'refreshingStatus',
        onError: {
          target: 'error',
          actions: [
            'setError',
            emit(({ event }) => ({
              type: 'error',
              error: event.error as Error,
            })),
          ],
        },
      },
      on: {
        fileUnstaged: {
          actions: [
            'removeFromStagedFiles',
            emit(({ event }) => ({
              type: 'fileUnstaged',
              path: event.path,
            })),
          ],
        },
      },
    },
    committing: {
      entry: ['clearError', 'setCommitMessage'],
      invoke: {
        src: 'commitChangesActor',
        input: ({ context }) => ({
          fileManagerRef: context.fileManagerRef,
          projectId: context.projectId!,
          message: context.commitMessage!,
          username: context.username!,
          email: context.email!,
        }),
        onDone: {
          target: 'refreshingStatus',
          actions: 'clearCommitMessage',
        },
        onError: {
          target: 'error',
          actions: [
            'setError',
            emit(({ event }) => ({
              type: 'error',
              error: event.error as Error,
            })),
          ],
        },
      },
      on: {
        commitCreated: {
          actions: emit(({ event }) => ({
            type: 'commitCreated',
            sha: event.sha,
          })),
        },
      },
    },
    pushing: {
      entry: 'clearError',
      invoke: {
        src: 'pushChangesActor',
        input: ({ context }) => ({
          fileManagerRef: context.fileManagerRef,
          projectId: context.projectId!,
          repository: context.repository!,
          accessToken: context.accessToken!,
          username: context.username!,
        }),
        onDone: {
          target: 'ready',
          actions: emit({ type: 'pushComplete' }),
        },
        onError: {
          target: 'error',
          actions: [
            'setError',
            emit(({ event }) => ({
              type: 'error',
              error: event.error as Error,
            })),
          ],
        },
      },
    },
    pulling: {
      entry: 'clearError',
      invoke: {
        src: 'pullChangesActor',
        input: ({ context }) => ({
          fileManagerRef: context.fileManagerRef,
          projectId: context.projectId!,
          repository: context.repository!,
          accessToken: context.accessToken!,
          username: context.username!,
        }),
        onDone: {
          target: 'refreshingStatus',
          actions: emit({ type: 'pullComplete' }),
        },
        onError: {
          target: 'error',
          actions: [
            'setError',
            emit(({ event }) => ({
              type: 'error',
              error: event.error as Error,
            })),
          ],
        },
      },
    },
    refreshingStatus: {
      invoke: {
        src: 'refreshGitStatusActor',
        input: ({ context }) => ({
          fileManagerRef: context.fileManagerRef,
          projectId: context.projectId!,
        }),
        onDone: 'ready',
        onError: {
          target: 'ready',
        },
      },
      on: {
        statusRefreshed: {
          actions: [
            'updateFileStatuses',
            emit(({ event }) => ({
              type: 'statusUpdated',
              fileStatuses: event.fileStatuses,
            })),
          ],
        },
      },
    },
    error: {
      on: {
        retry: [
          {
            guard: 'isAuthError',
            target: 'authenticating',
          },
          {
            guard: 'isCloneError',
            target: 'cloning',
          },
          {
            target: 'ready',
          },
        ],
        disconnect: {
          target: 'disconnected',
          actions: 'disconnect',
        },
      },
    },
  },
});
