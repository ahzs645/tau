// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import jsonUrl from '@firstform/json-url';
import type { FileExtension } from '@taucad/types';
import PlaygroundRoot, { loader as playgroundRootLoader } from '#routes/_index/route.js';

type CadEventMap = {
  geometryExported: { blob: Blob; format: FileExtension };
  exportFailed: { errors: Array<{ message: string }> };
};

type CadEventName = keyof CadEventMap;

type CadEventHandlers = {
  [K in CadEventName]: Array<(event: CadEventMap[K]) => void>;
};

const {
  cadEventHandlers,
  mockCadSend,
  mockDownloadBlob,
  mockSetParameters,
  mockState,
  mockToastError,
  mockToastSuccess,
  mockWriteText,
  providerCalls,
  resetProviderCalls,
} = vi.hoisted(() => {
  const handlers: CadEventHandlers = {
    geometryExported: [],
    exportFailed: [],
  };

  // Mutable preview state the useCadPreview mock reads from; tests set `parameters` to simulate overrides.
  const state: { parameters: Record<string, unknown> } = { parameters: {} };

  return {
    cadEventHandlers: handlers,
    mockState: state,
    mockCadSend: vi.fn((event: { readonly type: string; readonly format?: FileExtension }) => {
      if (event.type === 'exportGeometry' && event.format) {
        const blob = new Blob([`export:${event.format}`], {
          type: 'model/mock',
        });
        for (const handler of handlers.geometryExported) {
          handler({ blob, format: event.format });
        }
      }
    }),
    mockDownloadBlob: vi.fn(),
    mockSetParameters: vi.fn(),
    mockToastError: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockWriteText: vi.fn(async (_text: string) => 'copied'),
    providerCalls: [] as Array<{
      projectId: string;
      mainFile: string;
      files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
    }>,
    resetProviderCalls: () => {
      handlers.geometryExported.length = 0;
      handlers.exportFailed.length = 0;
      mockCadSend.mockClear();
      mockDownloadBlob.mockClear();
      mockSetParameters.mockClear();
      mockToastError.mockClear();
      mockToastSuccess.mockClear();
      mockWriteText.mockClear();
      providerCalls.length = 0;
      state.parameters = {};
    },
  };
});

vi.mock('@taucad/utils/file', () => ({
  downloadBlob: mockDownloadBlob,
}));

vi.mock('#components/ui/sonner.js', () => ({
  toast: {
    error: mockToastError,
    success: mockToastSuccess,
  },
}));

vi.mock('#components/code/code-editor.client.js', () => ({
  CodeEditor({ value, onChange }: { readonly value: string; readonly onChange: (value: string | undefined) => void }) {
    return (
      <textarea
        aria-label='Code editor'
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    );
  },
}));

vi.mock('#components/cad-preview.js', () => ({
  CadPreviewViewer() {
    return <div data-testid='cad-preview-viewer'>viewer</div>;
  },
  CadPreviewStatus() {
    return <div data-testid='cad-preview-status'>status</div>;
  },
}));

vi.mock('#components/ui/button.js', () => ({
  buttonVariants() {
    return '';
  },
  Button({
    children,
    disabled,
    onClick,
    title,
    ...props
  }: {
    readonly children: React.ReactNode;
    readonly disabled?: boolean;
    readonly onClick?: () => void;
    readonly title?: string;
    readonly [key: string]: unknown;
  }) {
    return (
      <button type='button' disabled={disabled} title={title} onClick={onClick} {...props}>
        {children}
      </button>
    );
  },
}));

vi.mock('#components/ui/utils/client-only.js', () => ({
  ClientOnly({ children }: { readonly children: React.ReactNode }) {
    return <div data-testid='client-only'>{children}</div>;
  },
}));

vi.mock('#hooks/use-file-manager.js', () => ({
  FileManagerProvider({ children }: { readonly children: React.ReactNode }) {
    return <div data-testid='file-manager-provider'>{children}</div>;
  },
  SharedWorkerGate({ children }: { readonly children: React.ReactNode }) {
    return <div data-testid='shared-worker-gate'>{children}</div>;
  },
}));

vi.mock('#hooks/use-cad-preview.js', () => ({
  CadPreviewProvider({
    children,
    files,
    mainFile,
    projectId,
  }: {
    readonly children: React.ReactNode;
    readonly files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
    readonly mainFile: string;
    readonly projectId: string;
  }) {
    providerCalls.push({ files, mainFile, projectId });
    return <div data-testid='cad-preview-provider'>{children}</div>;
  },
  useCadPreview() {
    return {
      cadRef: {
        on<EventName extends CadEventName>(eventName: EventName, handler: (event: CadEventMap[EventName]) => void) {
          cadEventHandlers[eventName].push(handler as never);
          return {
            unsubscribe() {
              const handlers = cadEventHandlers[eventName] as Array<typeof handler>;
              const index = handlers.indexOf(handler);
              if (index !== -1) {
                handlers.splice(index, 1);
              }
            },
          };
        },
        send: mockCadSend,
      },
      defaultParameters: {
        width: 90,
        depth: 55,
      },
      error: undefined,
      geometries: [{}],
      parameters: mockState.parameters,
      setParameters: mockSetParameters,
      status: 'ready',
    };
  },
}));

vi.mock('#components/ui/dropdown-menu.js', () => ({
  DropdownMenu({ children }: { readonly children: React.ReactNode }) {
    return <div>{children}</div>;
  },
  DropdownMenuTrigger({ children }: { readonly children: React.ReactNode; readonly asChild?: boolean }) {
    return <>{children}</>;
  },
  DropdownMenuContent({ children }: { readonly children: React.ReactNode; readonly align?: string }) {
    return <div>{children}</div>;
  },
  DropdownMenuItem({ children, onSelect }: { readonly children: React.ReactNode; readonly onSelect?: () => void }) {
    return (
      <button type='button' onClick={onSelect}>
        {children}
      </button>
    );
  },
}));

vi.mock('#routes/projects_.$id_.preview/preview-parameters.js', () => ({
  PreviewParameters() {
    return <div data-testid='preview-parameters'>parameters</div>;
  },
}));

describe('PlaygroundRoot', () => {
  beforeEach(() => {
    globalThis.history.replaceState({}, '', '/');
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: mockWriteText,
      },
    });
    resetProviderCalls();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the production playground shell with gallery navigation and parameters', async () => {
    renderPlaygroundRoot();

    expect(screen.getByRole('heading', { name: 'Tau CAD Playground' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Gallery' }).getAttribute('href')).toBe('/gallery');
    expect(screen.getByText('OpenSCAD bracket · OpenSCAD')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Code' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByLabelText('Code editor')).toBeNull();
    expect(screen.getByTestId('cad-preview-viewer')).toBeDefined();
    expect(screen.getByTestId('preview-parameters')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Wide' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(await screen.findByLabelText('Code editor')).toBeDefined();
  });

  it('opens a model from the URL and replaces the preview project and main file', async () => {
    globalThis.history.replaceState({}, '', '/?model=opencascade-box');

    renderPlaygroundRoot();

    expect(await screen.findByText('OpenCascade direct · OpenCascade')).toBeDefined();
    await waitFor(() => {
      expect(providerCalls.at(-1)?.projectId).toContain('root-playground-opencascade-box');
    });
    expect(providerCalls.at(-1)?.mainFile).toBe('main.ts');
    expect(providerCalls.at(-1)?.files['main.ts']).toBeDefined();
  });

  it('updates the active model when route loader data changes on client navigation', async () => {
    const { rerender } = render(
      <MemoryRouter key='3d-rack-scad' initialEntries={['/?model=3d-rack-scad']}>
        <PlaygroundRoot loaderData={{ activeExampleId: '3d-rack-scad' }} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('3D Rack System · OpenSCAD')).toBeDefined();
    await waitFor(() => {
      expect(providerCalls.at(-1)?.projectId).toContain('root-playground-3d-rack-scad');
    });

    rerender(
      <MemoryRouter key='networking' initialEntries={['/?model=networking']}>
        <PlaygroundRoot loaderData={{ activeExampleId: 'networking' }} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Network Equipment Rack · OpenSCAD')).toBeDefined();
    await waitFor(() => {
      expect(providerCalls.at(-1)?.projectId).toContain('root-playground-networking');
    });
  });

  it('uses the browser location search when static prerender loader data is the default model', async () => {
    render(
      <MemoryRouter initialEntries={['/?model=networking']}>
        <PlaygroundRoot loaderData={{ activeExampleId: 'openscad-bracket' }} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Network Equipment Rack · OpenSCAD')).toBeDefined();
    await waitFor(() => {
      expect(providerCalls.at(-1)?.projectId).toContain('root-playground-networking');
    });
  });

  it('runs edited code through the preview provider', async () => {
    renderPlaygroundRoot();

    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    const editor = await screen.findByLabelText('Code editor');
    fireEvent.change(editor, { target: { value: 'cube([10, 10, 10]);' } });
    expect(screen.getByText('edited')).toBeDefined();
    expect(screen.getByText('unrun')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => {
      const lastCall = providerCalls.at(-1);
      expect(lastCall?.mainFile).toBe('main.scad');
      expect(new TextDecoder().decode(lastCall?.files['main.scad']?.content)).toBe('cube([10, 10, 10]);');
    });
  });

  it('supports source-style keyboard shortcuts for preview and export', async () => {
    renderPlaygroundRoot();

    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    const editor = await screen.findByLabelText('Code editor');
    fireEvent.change(editor, { target: { value: 'sphere(10);' } });
    fireEvent.keyDown(globalThis.window, { key: 'F5' });

    await waitFor(() => {
      expect(new TextDecoder().decode(providerCalls.at(-1)?.files['main.scad']?.content)).toBe('sphere(10);');
    });

    fireEvent.keyDown(globalThis.window, { key: 'F7' });

    await waitFor(() => {
      expect(mockCadSend).toHaveBeenCalledWith({
        type: 'exportGeometry',
        format: 'glb',
      });
      expect(mockDownloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'openscad-bracket.glb');
    });
  });

  it('copies share links using the same model URL behavior as the source app', async () => {
    renderPlaygroundRoot();

    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith(expect.stringMatching(/\/\?model=openscad-bracket$/));
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Playground link copied');
  });

  it('embeds changed parameters in the shared link and round-trips them', async () => {
    mockState.parameters = { width: 99, style: 'hollow' };

    renderPlaygroundRoot();

    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalled();
    });

    const sharedUrl = mockWriteText.mock.calls.at(-1)?.[0];
    expect(sharedUrl).toBeDefined();
    const url = new URL(sharedUrl ?? '');
    expect(url.searchParams.get('model')).toBe('openscad-bracket');

    const token = url.searchParams.get('p');
    expect(token).toBeTruthy();

    const decoded = await jsonUrl.createWebShareEngine().tryDecompress(token ?? '', {});
    expect(decoded).toEqual({ width: 99, style: 'hollow' });
    expect(mockToastSuccess).toHaveBeenCalledWith('Playground link copied with your changes');
  });

  it('live-syncs the address bar ?p= token as parameters change', async () => {
    mockState.parameters = { width: 42, depth: 17 };

    renderPlaygroundRoot();

    await waitFor(() => {
      expect(new URLSearchParams(globalThis.location.search).get('p')).toBeTruthy();
    });

    const token = new URLSearchParams(globalThis.location.search).get('p');
    const decoded = await jsonUrl.createWebShareEngine().tryDecompress(token ?? '', {});
    expect(decoded).toEqual({ width: 42, depth: 17 });
  });

  it('keeps ?p= out of the address bar when parameters match the baseline', async () => {
    renderPlaygroundRoot();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Share' })).toBeDefined();
    });

    expect(new URLSearchParams(globalThis.location.search).get('p')).toBeNull();
  });

  it('applies model presets through Tau preview parameters', async () => {
    globalThis.history.replaceState({}, '', '/?model=replicad-tray');

    renderPlaygroundRoot();
    fireEvent.click(screen.getByRole('button', { name: 'Solid block' }));

    expect(mockSetParameters).toHaveBeenCalledWith({
      width: 70,
      depth: 45,
      height: 18,
      wall: 3,
      radius: 5,
      style: 'solid',
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Applied Solid block');
  });

  it('exports through the active CadPreview actor and downloads the returned blob', async () => {
    renderPlaygroundRoot();

    fireEvent.click(screen.getByRole('button', { name: 'GLB' }));

    await waitFor(() => {
      expect(mockCadSend).toHaveBeenCalledWith({
        type: 'exportGeometry',
        format: 'glb',
      });
      expect(mockDownloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'openscad-bracket.glb');
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Downloaded openscad-bracket.glb');
  });

  it('dispatches direct OpenCascade exports through the same preview actor', async () => {
    globalThis.history.replaceState({}, '', '/?model=opencascade-box');

    renderPlaygroundRoot();
    fireEvent.click(screen.getByRole('button', { name: 'STEP' }));

    await waitFor(() => {
      expect(mockCadSend).toHaveBeenCalledWith({
        type: 'exportGeometry',
        format: 'step',
      });
      expect(mockDownloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'opencascade-box.step');
    });
  });
});

function renderPlaygroundRoot(): ReturnType<typeof render> {
  const loaderData = playgroundRootLoader({
    request: new Request(globalThis.location.href),
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- tests only need request for this loader.
  } as Parameters<typeof playgroundRootLoader>[0]);

  return render(
    <MemoryRouter initialEntries={[`${globalThis.location.pathname}${globalThis.location.search}`]}>
      <PlaygroundRoot loaderData={loaderData} />
    </MemoryRouter>,
  );
}
