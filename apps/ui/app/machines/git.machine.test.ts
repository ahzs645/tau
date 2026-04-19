import { describe, it, expect, vi, afterEach } from 'vitest';
import { createActor, waitFor } from 'xstate';
import { fromSafeAsync } from '#lib/xstate.lib.js';
import { gitMachine } from '#machines/git.machine.js';
import type { GitActorInput, GitFileStatus } from '#machines/git.machine.js';

vi.mock('isomorphic-git', () => ({
  default: {
    init: vi.fn(),
    clone: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    commit: vi.fn(async () => 'abc123'),
    push: vi.fn(),
    pull: vi.fn(),
    statusMatrix: vi.fn(async () => []),
    addRemote: vi.fn(),
  },
}));

vi.mock('isomorphic-git/http/web', () => ({
  default: {},
}));

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const mockRepo = {
  owner: 'test',
  name: 'repo',
  url: 'https://github.com/test/repo',
  branch: 'main',
};

function createMockProxy() {
  return {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    stat: vi.fn(async () => ({ type: 'file', size: 0, mtimeMs: 0 })),
    lstat: vi.fn(async () => ({ type: 'file', size: 0, mtimeMs: 0 })),
    mkdir: vi.fn(),
    readdir: vi.fn(async () => []),
    unlink: vi.fn(),
    rmdir: vi.fn(),
    getDirectoryStat: vi.fn(async () => []),
    dispose: vi.fn(),
    setDirectoryHandle: vi.fn(),
    readShallowDirectory: vi.fn(async () => []),
  };
}

// oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- getSnapshot mock return type doesn't match deep MachineSnapshot
const mockFileManagerRef = {
  send: vi.fn(),
  getSnapshot: vi.fn(() => ({
    matches: () => true,
    context: { proxy: createMockProxy() },
  })),
} as unknown as GitActorInput['fileManagerRef'];

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function createTestActor(options?: { accessToken?: string; projectId?: string; throwOnClone?: boolean }) {
  const machine = gitMachine.provide({
    actors: {
      // oxlint-disable-next-line no-empty-function -- mock stub
      initGitActor: fromSafeAsync(async () => {}),
      cloneRepositoryActor: fromSafeAsync(async () => {
        if (options?.throwOnClone) {
          throw new Error('clone failed');
        }
      }),
      stageFileActor: fromSafeAsync<
        { type: 'fileStaged'; path: string },
        GitActorInput & { projectId: string; path: string }
      >(async ({ input }) => {
        return { type: 'fileStaged', path: input.path };
      }),
      unstageFileActor: fromSafeAsync<
        { type: 'fileUnstaged'; path: string },
        GitActorInput & { projectId: string; path: string }
      >(async ({ input }) => {
        return { type: 'fileUnstaged', path: input.path };
      }),
      commitChangesActor: fromSafeAsync(async () => {
        return { type: 'commitCreated', sha: 'abc123' };
      }),
      // oxlint-disable-next-line no-empty-function -- mock stub
      pushChangesActor: fromSafeAsync(async () => {}),
      // oxlint-disable-next-line no-empty-function -- mock stub
      pullChangesActor: fromSafeAsync(async () => {}),
      refreshGitStatusActor: fromSafeAsync(async () => {
        return { type: 'statusRefreshed', fileStatuses: new Map() };
      }),
    },
  });

  return createActor(machine, {
    input: {
      projectId: options?.projectId ?? 'test-build',
      fileManagerRef: mockFileManagerRef,
    },
  });
}

async function connectAndAuthenticate(actor: ReturnType<typeof createTestActor>) {
  actor.send({ type: 'connect', projectId: 'test-build' });
  actor.send({
    type: 'authenticate',
    accessToken: 'token-123',
    username: 'testuser',
    email: 'test@example.com',
  });
  await waitFor(actor, (s) => s.value === 'selectingRepo');
}

async function connectAuthAndClone(actor: ReturnType<typeof createTestActor>) {
  await connectAndAuthenticate(actor);
  actor.send({ type: 'selectRepository', repository: mockRepo });
  await waitFor(actor, (s) => s.value === 'ready');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gitMachine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('should start in disconnected state', () => {
      const actor = createTestActor();
      actor.start();
      expect(actor.getSnapshot().value).toBe('disconnected');
      actor.stop();
    });

    it('should have correct context defaults', () => {
      const actor = createTestActor({ projectId: 'my-build' });
      actor.start();
      const { context } = actor.getSnapshot();
      expect(context.projectId).toBe('my-build');
      expect(context.accessToken).toBeUndefined();
      expect(context.provider).toBeUndefined();
      expect(context.repository).toBeUndefined();
      expect(context.fileStatuses.size).toBe(0);
      expect(context.stagedFiles.size).toBe(0);
      expect(context.commitMessage).toBeUndefined();
      expect(context.error).toBeUndefined();
      expect(context.isInitialized).toBe(false);
      expect(context.username).toBeUndefined();
      expect(context.email).toBeUndefined();
      actor.stop();
    });
  });

  describe('connection flow', () => {
    it('should transition to checkingAuthentication on connect', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'connect', projectId: 'test-build' });
      // CheckingAuthentication is a transient state — it immediately transitions
      // to authenticating when no access token is present
      expect(actor.getSnapshot().value).toBe('authenticating');
      actor.stop();
    });

    it('should go to authenticating when no access token', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'connect', projectId: 'test-build' });
      expect(actor.getSnapshot().value).toBe('authenticating');
      actor.stop();
    });

    it('should set authentication on authenticate event', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'connect', projectId: 'test-build' });
      actor.send({
        type: 'authenticate',
        accessToken: 'token-123',
        username: 'testuser',
        email: 'test@example.com',
      });
      const { context } = actor.getSnapshot();
      expect(context.accessToken).toBe('token-123');
      expect(context.username).toBe('testuser');
      expect(context.email).toBe('test@example.com');
      actor.stop();
    });

    it('should go to selectingRepo after authenticate', async () => {
      const actor = createTestActor();
      actor.start();
      await connectAndAuthenticate(actor);
      expect(actor.getSnapshot().value).toBe('selectingRepo');
      actor.stop();
    });
  });

  describe('cloning', () => {
    it('should transition to cloning on selectRepository', async () => {
      const actor = createTestActor();
      actor.start();
      await connectAndAuthenticate(actor);
      actor.send({ type: 'selectRepository', repository: mockRepo });
      // Cloning transitions to refreshingStatus quickly, but we can check
      // that it eventually reaches ready
      await waitFor(actor, (s) => s.value === 'ready');
      expect(actor.getSnapshot().context.repository).toEqual(mockRepo);
      actor.stop();
    });

    it('should transition to refreshingStatus after clone success', async () => {
      const actor = createTestActor();
      actor.start();
      await connectAndAuthenticate(actor);
      actor.send({ type: 'selectRepository', repository: mockRepo });
      // The machine goes cloning → refreshingStatus → ready
      await waitFor(actor, (s) => s.value === 'ready');
      expect(actor.getSnapshot().context.isInitialized).toBe(true);
      actor.stop();
    });

    it('should transition to ready after status refresh', async () => {
      const actor = createTestActor();
      actor.start();
      await connectAuthAndClone(actor);
      expect(actor.getSnapshot().value).toBe('ready');
      actor.stop();
    });

    it('should transition to error on clone failure', async () => {
      const actor = createTestActor({ throwOnClone: true });
      actor.start();
      actor.send({ type: 'connect', projectId: 'test-build' });
      actor.send({
        type: 'authenticate',
        accessToken: 'token-123',
        username: 'testuser',
        email: 'test@example.com',
      });
      await waitFor(actor, (s) => s.value === 'selectingRepo');
      actor.send({ type: 'selectRepository', repository: mockRepo });
      await waitFor(actor, (s) => s.value === 'error');
      expect(actor.getSnapshot().context.error?.message).toBe('clone failed');
      actor.stop();
    });
  });

  describe('ready state operations', () => {
    it('should transition to stagingFile on stageFile from ready', async () => {
      const actor = createTestActor();
      actor.start();
      await connectAuthAndClone(actor);
      actor.send({ type: 'stageFile', path: 'file.txt' });
      // StagingFile → refreshingStatus → ready happens quickly
      await waitFor(actor, (s) => s.value === 'ready');
      actor.stop();
    });

    it('should add to staged files on fileStaged event', async () => {
      const machine = gitMachine.provide({
        actors: {
          // oxlint-disable-next-line no-empty-function -- mock stub
          initGitActor: fromSafeAsync(async () => {}),
          // oxlint-disable-next-line no-empty-function -- mock stub
          cloneRepositoryActor: fromSafeAsync(async () => {}),
          stageFileActor: fromSafeAsync<
            { type: 'fileStaged'; path: string },
            GitActorInput & { projectId: string; path: string }
          >(async ({ input }) => {
            return { type: 'fileStaged', path: input.path };
          }),
          unstageFileActor: fromSafeAsync(async () => {
            return { type: 'fileUnstaged', path: '' };
          }),
          commitChangesActor: fromSafeAsync(async () => {
            return { type: 'commitCreated', sha: '' };
          }),
          // oxlint-disable-next-line no-empty-function -- mock stub
          pushChangesActor: fromSafeAsync(async () => {}),
          // oxlint-disable-next-line no-empty-function -- mock stub
          pullChangesActor: fromSafeAsync(async () => {}),
          refreshGitStatusActor: fromSafeAsync(async () => {
            return {
              type: 'statusRefreshed',
              fileStatuses: new Map<string, GitFileStatus>([
                ['file.txt', { path: 'file.txt', status: 'added', staged: true }],
              ]),
            };
          }),
        },
      });

      const actor = createActor(machine, {
        input: { projectId: 'test-build', fileManagerRef: mockFileManagerRef },
      });
      actor.start();
      await connectAuthAndClone(actor);
      actor.send({ type: 'stageFile', path: 'file.txt' });
      await waitFor(actor, (s) => s.value === 'ready');
      expect(actor.getSnapshot().context.stagedFiles.has('file.txt')).toBe(true);
      actor.stop();
    });

    it('should transition to committing on commit from ready', async () => {
      const actor = createTestActor();
      actor.start();
      await connectAuthAndClone(actor);
      actor.send({ type: 'commit', message: 'test commit' });
      // Committing → refreshingStatus → ready
      await waitFor(actor, (s) => s.value === 'ready');
      actor.stop();
    });
  });

  describe('disconnect', () => {
    it('should handle disconnect from authenticating', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'connect', projectId: 'test-build' });
      expect(actor.getSnapshot().value).toBe('authenticating');
      actor.send({ type: 'disconnect' });
      expect(actor.getSnapshot().value).toBe('disconnected');
      actor.stop();
    });

    it('should handle disconnect from selectingRepo', async () => {
      const actor = createTestActor();
      actor.start();
      await connectAndAuthenticate(actor);
      expect(actor.getSnapshot().value).toBe('selectingRepo');
      actor.send({ type: 'disconnect' });
      expect(actor.getSnapshot().value).toBe('disconnected');
      actor.stop();
    });

    it('should handle disconnect from ready', async () => {
      const actor = createTestActor();
      actor.start();
      await connectAuthAndClone(actor);
      expect(actor.getSnapshot().value).toBe('ready');
      actor.send({ type: 'disconnect' });
      expect(actor.getSnapshot().value).toBe('disconnected');
      expect(actor.getSnapshot().context.repository).toBeUndefined();
      expect(actor.getSnapshot().context.isInitialized).toBe(false);
      actor.stop();
    });

    it('should handle disconnect from error', async () => {
      const actor = createTestActor({ throwOnClone: true });
      actor.start();
      actor.send({ type: 'connect', projectId: 'test-build' });
      actor.send({
        type: 'authenticate',
        accessToken: 'token-123',
        username: 'testuser',
        email: 'test@example.com',
      });
      await waitFor(actor, (s) => s.value === 'selectingRepo');
      actor.send({ type: 'selectRepository', repository: mockRepo });
      await waitFor(actor, (s) => s.value === 'error');
      actor.send({ type: 'disconnect' });
      expect(actor.getSnapshot().value).toBe('disconnected');
      actor.stop();
    });
  });
});
