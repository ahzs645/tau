// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '#components/ui/tooltip.js';
import FilesRoute from '#routes/files/route.js';

type ReadShallowDirectoryOptions = {
  readonly scope?: {
    readonly backend?: string;
  };
};

type ReadShallowDirectoryMock = (
  path: string,
  options?: ReadShallowDirectoryOptions,
) => Promise<readonly unknown[]>;

type ElementChildrenProps = {
  readonly children: React.JSX.Element;
};

const {
  checkHandlePermissionMock,
  getWorkspaceMock,
  listProjectsForWorkspaceMock,
  listWorkspacesMock,
  readShallowDirectoryMock,
  setDefaultWorkspaceMock,
  useCookieSetterMock,
  fileManagerContextMock,
  workspaceInvalidateStandaloneProviderMock,
} = vi.hoisted(() => ({
  checkHandlePermissionMock: vi.fn(),
  getWorkspaceMock: vi.fn(),
  listProjectsForWorkspaceMock: vi.fn(),
  listWorkspacesMock: vi.fn(),
  readShallowDirectoryMock: vi.fn<ReadShallowDirectoryMock>(),
  setDefaultWorkspaceMock: vi.fn(),
  useCookieSetterMock: vi.fn(),
  fileManagerContextMock: {
    client: {
      getZippedDirectory: vi.fn(),
      readFile: vi.fn(),
      readShallowDirectory: vi.fn<ReadShallowDirectoryMock>(),
      rmdir: vi.fn(),
      unlink: vi.fn(),
    },
    workspace: {
      invalidateStandaloneProvider: vi.fn(),
    },
  },
  workspaceInvalidateStandaloneProviderMock: vi.fn(),
}));

vi.mock('#hooks/use-cookie.js', () => ({
  useCookie: (_name: string, defaultValue: unknown) => [defaultValue, useCookieSetterMock, vi.fn()],
}));

vi.mock('#components/ui/tooltip.js', () => ({
  TooltipProvider: ({ children }: ElementChildrenProps): React.JSX.Element => children,
  Tooltip: ({ children }: ElementChildrenProps): React.JSX.Element => children,
  TooltipTrigger: ({ children }: ElementChildrenProps): React.JSX.Element => children,
  TooltipContent: ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => <span>{children}</span>,
}));

vi.mock('#hooks/use-file-manager.js', () => ({
  useFileManager: () => fileManagerContextMock,
}));

vi.mock('#hooks/use-projects.js', () => ({
  useProjects: () => ({ projects: [] }),
}));

vi.mock('#filesystem/handle-store.js', () => ({
  checkHandlePermission: checkHandlePermissionMock,
  createWorkspace: vi.fn(),
  forgetWorkspace: vi.fn(),
  getWorkspace: getWorkspaceMock,
  listProjectsForWorkspace: listProjectsForWorkspaceMock,
  listWorkspaces: listWorkspacesMock,
  requestHandlePermission: vi.fn(),
  setDefaultWorkspace: setDefaultWorkspaceMock,
  updateWorkspaceHandle: vi.fn(),
}));

vi.mock('#utils/workspace-telemetry.utils.js', () => ({
  useWorkspaceTelemetry: () => ({
    workspaceConnected: vi.fn(),
    workspaceCreated: vi.fn(),
    workspaceOpenFailed: vi.fn(),
  }),
}));

vi.mock('#components/ui/sonner.js', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function FilesRouteHarness(): React.JSX.Element {
  return (
    <TooltipProvider>
      <FilesRoute />
    </TooltipProvider>
  );
}

function installBrowserStorageCapabilities(): void {
  Object.defineProperty(globalThis.navigator, 'storage', {
    configurable: true,
    value: {
      getDirectory: vi.fn(),
    },
  });
  Object.defineProperty(globalThis.window, 'showDirectoryPicker', {
    configurable: true,
    value: vi.fn(),
  });
}

describe('FilesRoute hydration-stable browser capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installBrowserStorageCapabilities();
    listWorkspacesMock.mockResolvedValue([]);
    getWorkspaceMock.mockResolvedValue(undefined);
    checkHandlePermissionMock.mockResolvedValue('granted');
    listProjectsForWorkspaceMock.mockResolvedValue([]);
    setDefaultWorkspaceMock.mockResolvedValue(undefined);
    workspaceInvalidateStandaloneProviderMock.mockResolvedValue(undefined);
    fileManagerContextMock.client.readShallowDirectory = readShallowDirectoryMock;
    fileManagerContextMock.workspace.invalidateStandaloneProvider = workspaceInvalidateStandaloneProviderMock;
    readShallowDirectoryMock.mockResolvedValue([]);
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis.navigator, 'storage');
    Reflect.deleteProperty(globalThis.window, 'showDirectoryPicker');
  });

  it('renders the server-safe OPFS fallback before hydration effects run', () => {
    const html = renderToString(<FilesRouteHarness />);

    expect(html).toContain('OPFS');
    expect(html).toContain('Not supported in this browser');
    expect(html).toContain('opacity-50');
    expect(html).not.toContain('Add Workspace');
  });

  it('enables browser-backed columns after hydration and loads OPFS', async () => {
    render(<FilesRouteHarness />);

    await waitFor(() => {
      expect(screen.getByText('Add Workspace')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(
        readShallowDirectoryMock.mock.calls.some(
          ([path, options]) => path === '/' && options?.scope?.backend === 'opfs',
        ),
      ).toBe(true);
    });

    expect(screen.queryByText('Not supported in this browser')).not.toBeInTheDocument();
  });
});
