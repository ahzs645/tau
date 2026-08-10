// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useEffect } from 'react';
import type { FileExtension, Geometry } from '@taucad/types';
import PlaygroundRoot, { loader as playgroundRootLoader } from '#routes/playground/route.js';
import { playgroundShareCodec } from '#routes/playground/share-codec.js';
import { KeyboardProvider } from '#hooks/use-keyboard.js';

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
  mockWriteProjectFile,
  mockWriteText,
  fileManagerCalls,
  providerMountCalls,
  providerCalls,
  viewerCalls,
  resetProviderCalls,
} = vi.hoisted(() => {
  const handlers: CadEventHandlers = {
    geometryExported: [],
    exportFailed: [],
  };

  // Mutable preview state the useCadPreview mock reads from; tests set fields to simulate preview changes.
  const state: { parameters: Record<string, unknown>; geometries: Geometry[] } = {
    parameters: {},
    geometries: [{ format: 'gltf', content: new Uint8Array([1]), hash: 'mock-geometry' }],
  };

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
    mockWriteProjectFile: vi.fn(async (_path: string, _data: Uint8Array, _options: { source: string }) => undefined),
    mockWriteText: vi.fn(async (_text: string) => 'copied'),
    fileManagerCalls: [] as Array<{
      projectId: string;
      rootDirectory: string;
    }>,
    providerCalls: [] as Array<{
      projectId: string;
      mainFile: string;
      files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
    }>,
    providerMountCalls: [] as Array<{
      projectId: string;
      mainFile: string;
      parameters: Record<string, unknown>;
      files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
    }>,
    viewerCalls: [] as Array<{
      graphicsOptions: { readonly enableLines?: boolean } | undefined;
      fallbackGeometries: readonly Geometry[] | undefined;
    }>,
    resetProviderCalls: () => {
      handlers.geometryExported.length = 0;
      handlers.exportFailed.length = 0;
      mockCadSend.mockClear();
      mockDownloadBlob.mockClear();
      mockSetParameters.mockClear();
      mockToastError.mockClear();
      mockToastSuccess.mockClear();
      mockWriteProjectFile.mockClear();
      mockWriteText.mockClear();
      fileManagerCalls.length = 0;
      providerCalls.length = 0;
      providerMountCalls.length = 0;
      viewerCalls.length = 0;
      state.parameters = {};
      state.geometries = [{ format: 'gltf', content: new Uint8Array([1]), hash: 'mock-geometry' }];
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

vi.mock('#hooks/use-theme.js', () => ({
  useTheme() {
    return {
      theme: 'light',
      ssrTheme: 'light',
      themeWithSystem: 'light',
      currentOption: {
        id: 'light',
        name: 'Light',
        description: 'A bright, clean look',
      },
      setTheme: vi.fn(),
      cycleTheme: vi.fn(),
    };
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
  StaticPreviewViewer({ staticPreviewUrl }: { readonly staticPreviewUrl: string }) {
    return (
      <div data-testid='static-preview-viewer' data-url={staticPreviewUrl}>
        static viewer
      </div>
    );
  },
}));

vi.mock('#components/model-viewer.js', () => ({
  ModelViewer({
    geometries,
    graphicsOptions,
  }: {
    readonly geometries: readonly Geometry[];
    readonly graphicsOptions?: { readonly enableLines?: boolean };
  }) {
    viewerCalls.push({ fallbackGeometries: geometries, graphicsOptions });
    return <div data-testid='cad-preview-viewer'>viewer</div>;
  },
  RenderStatusOverlay() {
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
    readonly [key: string]: unknown;
    readonly children: React.ReactNode;
    readonly disabled?: boolean;
    readonly onClick?: () => void;
    readonly title?: string;
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
  FileManagerProvider({
    children,
    projectId,
    rootDirectory,
  }: {
    readonly children: React.ReactNode;
    readonly projectId: string;
    readonly rootDirectory: string;
  }) {
    fileManagerCalls.push({ projectId, rootDirectory });
    return <div data-testid='file-manager-provider'>{children}</div>;
  },
  SharedWorkerGate({ children }: { readonly children: React.ReactNode }) {
    return <div data-testid='shared-worker-gate'>{children}</div>;
  },
  useFileManager() {
    return { writeFile: mockWriteProjectFile };
  },
}));

vi.mock('#hooks/use-cad-preview.js', () => ({
  CadPreviewProvider({
    children,
    files,
    mainFile,
    parameters,
    projectId,
  }: {
    readonly children: React.ReactNode;
    readonly files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
    readonly mainFile: string;
    readonly parameters: Record<string, unknown>;
    readonly projectId: string;
  }) {
    providerCalls.push({ files, mainFile, projectId });
    useEffect(() => {
      providerMountCalls.push({ files, mainFile, parameters, projectId });
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- Record only the props that started a provider actor.
    }, []);
    return <div data-testid='cad-preview-provider'>{children}</div>;
  },
  useCadPreview() {
    return {
      cadRef: {
        on<EventName extends CadEventName>(eventName: EventName, handler: (event: CadEventMap[EventName]) => void) {
          const handlers = cadEventHandlers[eventName] as Array<(event: CadEventMap[EventName]) => void>;
          handlers.push(handler);
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
      geometries: mockState.geometries,
      jsonSchema: { type: 'object', properties: {} },
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
  DropdownMenuTrigger({ children }: { readonly children: React.ReactElement; readonly asChild?: boolean }) {
    return children;
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
  DropdownMenuLabel({ children }: { readonly children: React.ReactNode }) {
    return <div>{children}</div>;
  },
  DropdownMenuSeparator() {
    return <hr />;
  },
  DropdownMenuRadioGroup({ children }: { readonly children: React.ReactNode }) {
    return <div>{children}</div>;
  },
  DropdownMenuRadioItem({ children }: { readonly children: React.ReactNode }) {
    return <div>{children}</div>;
  },
  DropdownMenuSwitchItem({
    children,
    isChecked,
    onIsCheckedChange,
  }: {
    readonly children: React.ReactNode;
    readonly isChecked?: boolean;
    readonly onIsCheckedChange?: (checked: boolean) => void;
  }) {
    return (
      <button
        type='button'
        onClick={() => {
          onIsCheckedChange?.(!isChecked);
        }}
      >
        {children}
      </button>
    );
  },
  DropdownMenuSelectItem({ children }: { readonly children: React.ReactNode }) {
    return <div>{children}</div>;
  },
  DropdownMenuToggleGroupItem({ children }: { readonly children: React.ReactNode }) {
    return <div>{children}</div>;
  },
  DropdownMenuSliderItem({ children }: { readonly children: React.ReactNode }) {
    return <div>{children}</div>;
  },
  DropdownMenuSub({ children }: { readonly children: React.ReactNode }) {
    return <div>{children}</div>;
  },
  DropdownMenuSubTrigger({ children }: { readonly children: React.ReactNode }) {
    return <div>{children}</div>;
  },
  DropdownMenuSubContent({ children }: { readonly children: React.ReactNode }) {
    return <div>{children}</div>;
  },
}));

vi.mock('#routes/projects_.$id_.preview/preview-parameters.js', () => ({
  PreviewParameters({ headerActions }: { readonly headerActions?: React.ReactNode }) {
    return (
      <div data-testid='preview-parameters'>
        parameters
        {headerActions}
      </div>
    );
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
    globalThis.history.replaceState({}, '', '/?editor=on');

    renderPlaygroundRoot();

    // The header leads with the model itself; the app name lives on the gallery.
    expect(screen.getByRole('heading', { name: 'OpenSCAD bracket' })).toBeDefined();
    expect(screen.getAllByRole('link', { name: 'Gallery' })[0]!.getAttribute('href')).toBe('/');
    expect(screen.getAllByRole('button', { name: 'Code' })[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByLabelText('Code editor')).toBeNull();
    expect(screen.getByTestId('cad-preview-viewer')).toBeDefined();
    expect(await screen.findByTestId('preview-parameters')).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Wide' })).toBeDefined();

    fireEvent.click(screen.getAllByRole('button', { name: 'Code' })[0]!);
    expect(await screen.findByLabelText('Code editor')).toBeDefined();
  });

  it('hides the code editor and run controls by default until ?editor=on opts in', async () => {
    renderPlaygroundRoot();

    expect(screen.getByRole('heading', { name: 'OpenSCAD bracket' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Code' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
    // The rest of the playground stays interactive: viewer and parameters still render.
    expect(screen.getByTestId('cad-preview-viewer')).toBeDefined();
    await waitFor(() => {
      expect(screen.getByTestId('preview-parameters')).toBeDefined();
    });
  });

  it('keeps legacy kiosk links (?editor=off) on the default editor-less view', async () => {
    globalThis.history.replaceState({}, '', '/?editor=off');

    renderPlaygroundRoot();

    expect(screen.getByRole('heading', { name: 'OpenSCAD bracket' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Code' })).toBeNull();
    expect(screen.getByTestId('cad-preview-viewer')).toBeDefined();
    await waitFor(() => {
      expect(screen.getByTestId('preview-parameters')).toBeDefined();
    });
  });

  it('opens a model from the URL and replaces the preview project and main file', async () => {
    globalThis.history.replaceState({}, '', '/?model=opencascade-box');

    renderPlaygroundRoot();

    expect(await screen.findByRole('heading', { name: 'OpenCascade direct' })).toBeDefined();
    await waitFor(() => {
      expect(providerCalls.at(-1)?.projectId).toBe('root-playground-opencascade-box');
    });
    expect(fileManagerCalls.at(-1)).toEqual({
      projectId: 'root-playground-opencascade-box',
      rootDirectory: '/projects/root-playground-opencascade-box',
    });
    expect(providerCalls.at(-1)?.mainFile).toBe('main.ts');
    expect(providerCalls.at(-1)?.files['main.ts']).toBeDefined();
  });

  it('loads the pre-chamber project with the OpenCascade variant as the default', async () => {
    globalThis.history.replaceState({}, '', '/?model=pre-chamber-nozzle-insert');

    renderPlaygroundRoot();

    expect(await screen.findByRole('heading', { name: 'Pre-Chamber Nozzle Insert' })).toBeDefined();
    await waitFor(() => {
      expect(providerCalls.at(-1)?.projectId).toBe('root-playground-pre-chamber-nozzle-insert');
    });
    expect(providerCalls.at(-1)?.mainFile).toBe('main.occt.ts');
    expect(providerMountCalls).toHaveLength(1);
    expect(providerMountCalls[0]?.projectId).toBe('root-playground-pre-chamber-nozzle-insert');
    expect(providerMountCalls[0]?.mainFile).toBe('main.occt.ts');
    expect(new TextDecoder().decode(providerMountCalls[0]?.files['main.occt.ts']?.content)).toContain('opencascade.js');
    await waitFor(() => {
      expect(viewerCalls.at(-1)?.graphicsOptions?.enableLines).toBe(true);
    });
  });

  it('mounts each switched kernel once with that variant source already synchronized', async () => {
    globalThis.history.replaceState({}, '', '/?model=vane-trap');

    renderPlaygroundRoot();

    await waitFor(() => {
      expect(providerMountCalls).toHaveLength(1);
    });
    expect(providerMountCalls[0]?.projectId).toBe('root-playground-vane-trap');
    expect(providerMountCalls[0]?.mainFile).toBe('main.scad');

    fireEvent.click(screen.getByRole('button', { name: 'OpenCASCADE' }));

    await waitFor(() => {
      expect(providerMountCalls).toHaveLength(2);
    });
    const openCascadeMount = providerMountCalls[1];
    expect(openCascadeMount?.projectId).toBe('root-playground-vane-trap-opencascade');
    expect(openCascadeMount?.mainFile).toBe('main.occt.ts');
    expect(new TextDecoder().decode(openCascadeMount?.files['main.occt.ts']?.content)).toContain('opencascade.js');
  });

  it('preserves independently edited source for each kernel variant', async () => {
    globalThis.history.replaceState({}, '', '/?model=vane-trap&editor=on');

    renderPlaygroundRoot();

    const codeButtons = await screen.findAllByRole('button', { name: 'Code' });
    fireEvent.click(codeButtons[0]!);
    const editor = await screen.findByLabelText('Code editor');
    fireEvent.change(editor, { target: { value: 'cube([11, 12, 13]);' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    fireEvent.click(screen.getByRole('button', { name: 'OpenCASCADE' }));
    await waitFor(() => {
      expect(readCodeEditorValue()).not.toBe('cube([11, 12, 13]);');
    });
    fireEvent.change(screen.getByLabelText('Code editor'), {
      target: { value: "import opencascade from 'opencascade.js';\n// edited OCCT" },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    fireEvent.click(screen.getByRole('button', { name: 'OpenSCAD' }));
    await waitFor(() => {
      expect(readCodeEditorValue()).toBe('cube([11, 12, 13]);');
    });

    fireEvent.click(screen.getByRole('button', { name: 'OpenCASCADE' }));
    await waitFor(() => {
      expect(readCodeEditorValue()).toBe("import opencascade from 'opencascade.js';\n// edited OCCT");
    });
  });

  it('restores each variant parameters before mounting its provider', async () => {
    globalThis.history.replaceState({}, '', '/?model=vane-trap');
    mockState.parameters = { slotClearance: 0.3 };

    renderPlaygroundRoot();

    await waitFor(() => {
      expect(new URL(globalThis.location.href).searchParams.get('p')).toBeTruthy();
    });

    mockState.parameters = {};
    fireEvent.click(screen.getByRole('button', { name: 'OpenCASCADE' }));
    await waitFor(() => {
      expect(providerMountCalls.at(-1)?.projectId).toBe('root-playground-vane-trap-opencascade');
    });

    fireEvent.click(screen.getByRole('button', { name: 'OpenSCAD' }));
    await waitFor(() => {
      expect(providerMountCalls.at(-1)?.projectId).toBe('root-playground-vane-trap');
    });
    expect(providerMountCalls.at(-1)?.parameters).toEqual({ slotClearance: 0.3 });
  });

  it('shows cached variant geometry immediately when switching back', async () => {
    globalThis.history.replaceState({}, '', '/?model=vane-trap');
    mockState.geometries = [{ format: 'gltf', content: new Uint8Array([1, 2, 3]), hash: 'openscad-render' }];

    renderPlaygroundRoot();

    expect(await screen.findByRole('heading', { name: 'Vane Trap Device' })).toBeDefined();
    await waitFor(() => {
      expect(providerCalls.at(-1)?.projectId).toBe('root-playground-vane-trap');
    });

    mockState.geometries = [{ format: 'gltf', content: new Uint8Array([4, 5, 6]), hash: 'opencascade-render' }];
    fireEvent.click(screen.getByRole('button', { name: 'OpenCASCADE' }));

    await waitFor(() => {
      expect(providerCalls.at(-1)?.projectId).toBe('root-playground-vane-trap-opencascade');
    });

    mockState.geometries = [];
    fireEvent.click(screen.getByRole('button', { name: 'OpenSCAD' }));

    await waitFor(() => {
      expect(viewerCalls.at(-1)?.fallbackGeometries?.[0]?.hash).toBe('openscad-render');
    });
  });

  it('updates the active model when route loader data changes on client navigation', async () => {
    const { rerender } = render(
      <MemoryRouter key='3d-rack-scad' initialEntries={['/?model=3d-rack-scad']}>
        <KeyboardProvider>
          <PlaygroundRoot loaderData={{ activeExampleId: '3d-rack-scad' }} />
        </KeyboardProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: '3D Rack System' })).toBeDefined();
    await waitFor(() => {
      expect(providerCalls.at(-1)?.projectId).toBe('root-playground-3d-rack-scad');
    });

    rerender(
      <MemoryRouter key='networking' initialEntries={['/?model=networking']}>
        <KeyboardProvider>
          <PlaygroundRoot loaderData={{ activeExampleId: 'networking' }} />
        </KeyboardProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Network Equipment Rack' })).toBeDefined();
    await waitFor(() => {
      expect(providerCalls.at(-1)?.projectId).toBe('root-playground-networking');
    });
  });

  it('uses the browser location search when static prerender loader data is the default model', async () => {
    render(
      <MemoryRouter initialEntries={['/?model=networking']}>
        <KeyboardProvider>
          <PlaygroundRoot loaderData={{ activeExampleId: 'openscad-bracket' }} />
        </KeyboardProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Network Equipment Rack' })).toBeDefined();
    await waitFor(() => {
      expect(providerCalls.at(-1)?.projectId).toBe('root-playground-networking');
    });
  });

  it('opens static gallery demos without editor, export controls, or parameter sidebar', async () => {
    globalThis.history.replaceState({}, '', '/?model=atmospheric-sampler');

    renderPlaygroundRoot();

    expect(await screen.findByRole('heading', { name: 'Atmospheric Sampler' })).toBeDefined();
    expect(screen.getByTestId('static-preview-viewer')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Code' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
    expect(screen.queryByText('Export')).toBeNull();
    expect(screen.queryByTestId('preview-parameters')).toBeNull();
    expect(screen.queryByTestId('file-manager-provider')).toBeNull();
    expect(screen.queryByTestId('cad-preview-provider')).toBeNull();
  });

  it('runs edited code through the preview provider', async () => {
    globalThis.history.replaceState({}, '', '/?editor=on');

    renderPlaygroundRoot();
    await waitFor(() => {
      expect(providerCalls.at(-1)?.projectId).toBe('root-playground-openscad-bracket');
    });
    const initialProjectId = providerCalls.at(-1)?.projectId;
    const initialRootDirectory = fileManagerCalls.at(-1)?.rootDirectory;

    fireEvent.click(screen.getAllByRole('button', { name: 'Code' })[0]!);
    const editor = await screen.findByLabelText('Code editor');
    fireEvent.change(editor, { target: { value: 'cube([10, 10, 10]);' } });
    expect(screen.getByText('edited')).toBeDefined();
    expect(screen.getByText('unrun')).toBeDefined();
    fireEvent.click(screen.getAllByRole('button', { name: 'Run' })[0]!);

    await waitFor(() => {
      const lastCall = providerCalls.at(-1);
      expect(lastCall?.projectId).toBe(initialProjectId);
      expect(lastCall?.mainFile).toBe('main.scad');
      expect(new TextDecoder().decode(lastCall?.files['main.scad']?.content)).toBe('cube([10, 10, 10]);');
    });
    expect(fileManagerCalls.at(-1)?.rootDirectory).toBe(initialRootDirectory);
  });

  it('supports source-style keyboard shortcuts for preview and export', async () => {
    globalThis.history.replaceState({}, '', '/?editor=on');

    renderPlaygroundRoot();

    fireEvent.click(screen.getAllByRole('button', { name: 'Code' })[0]!);
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
    expect(mockCadSend).toHaveBeenCalledTimes(1);
    expect(mockDownloadBlob).toHaveBeenCalledTimes(1);
  });

  it('copies share links using the same model URL behavior as the source app', async () => {
    renderPlaygroundRoot();

    fireEvent.click(screen.getAllByRole('button', { name: 'Share' })[0]!);

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith(expect.stringMatching(/\/\?model=openscad-bracket$/));
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Playground link copied');
  });

  it('embeds changed parameters in the shared link and round-trips them', async () => {
    mockState.parameters = { width: 99, style: 'hollow' };

    renderPlaygroundRoot();

    await waitFor(() => {
      expect(new URLSearchParams(globalThis.location.search).get('p')).toBeTruthy();
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Share' })[0]!);

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalled();
    });

    const sharedUrl = mockWriteText.mock.calls.at(-1)?.[0];
    expect(sharedUrl).toBeDefined();
    const url = new URL(sharedUrl ?? '');
    expect(url.searchParams.get('model')).toBe('openscad-bracket');

    const token = url.searchParams.get('p');
    expect(token).toBeTruthy();

    const decoded = await playgroundShareCodec.tryDecompress(token ?? '', {});
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
    const decoded = await playgroundShareCodec.tryDecompress(token ?? '', {});
    expect(decoded).toEqual({ width: 42, depth: 17 });
  });

  it('keeps ?p= out of the address bar when parameters match the baseline', async () => {
    renderPlaygroundRoot();

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Share' })[0]).toBeDefined();
    });

    expect(new URLSearchParams(globalThis.location.search).get('p')).toBeNull();
  });

  it('applies model presets through Tau preview parameters', async () => {
    globalThis.history.replaceState({}, '', '/?model=replicad-tray');

    renderPlaygroundRoot();
    fireEvent.click(await screen.findByRole('button', { name: 'Solid block' }));

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

    // Export controls render twice (desktop header portal + mobile viewer overlay); either works.
    const glbButtons = await screen.findAllByRole('button', { name: 'GLB' });
    fireEvent.click(glbButtons[0]!);

    await waitFor(() => {
      expect(mockCadSend).toHaveBeenCalledWith({
        type: 'exportGeometry',
        format: 'glb',
      });
      expect(mockDownloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'openscad-bracket.glb');
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Downloaded openscad-bracket.glb');
  });

  it('renders an artwork drop zone for a project that declares an upload, and feeds the file to the render', async () => {
    globalThis.history.replaceState({}, '', '/?model=stamp');

    const { container } = renderPlaygroundRoot();

    // The slot opens on the artwork the project ships, previewable as the image
    // it is, rather than on an empty state that implies there is none. The
    // preview opens on click rather than hover, because this pane is a phone
    // surface too.
    expect(await screen.findByText('yaa.svg')).toBeDefined();
    const previewButton = screen.getByRole('button', { name: 'Preview yaa.svg' });
    expect(previewButton.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,/u);

    const fileInput = container.querySelector('input[type="file"]');
    if (!(fileInput instanceof HTMLInputElement)) {
      throw new TypeError('Expected the artwork drop zone to render a file input');
    }

    const artwork = '<svg xmlns="http://www.w3.org/2000/svg"><line x1="0" y1="0" x2="10" y2="10"/></svg>';
    const artworkFile = new File([artwork], 'my-logo.svg', { type: 'image/svg+xml' });
    // Jsdom's Blob implements neither `text()` nor `arrayBuffer()`, so the
    // picked file carries the reader every browser provides.
    Object.defineProperty(artworkFile, 'text', { value: async () => artwork });
    fireEvent.change(fileInput, { target: { files: [artworkFile] } });

    // Both stamp variants read the artwork as `yaa.svg` — the OpenSCAD
    // `svg_file` default and the OpenCASCADE `?raw` import — so the upload
    // reaches the render by replacing that file in the live preview
    // filesystem, which is what makes the kernel treat it as a change.
    await waitFor(() => {
      expect(mockWriteProjectFile).toHaveBeenCalled();
    });
    const [writtenPath, writtenBytes, writeOptions] = mockWriteProjectFile.mock.calls.at(-1)!;
    expect(writtenPath).toBe('yaa.svg');
    expect(new TextDecoder().decode(writtenBytes)).toBe(artwork);
    expect(writeOptions).toStrictEqual({ source: 'user' });

    // …and it is recorded on the session too, so a remount (a variant switch,
    // a reload of the same session) still carries the viewer's artwork.
    await waitFor(() => {
      const { files } = providerCalls.at(-1)!;
      expect(new TextDecoder().decode(files['yaa.svg']?.content)).toBe(artwork);
    });

    // The row reports what is loaded, and the name survives the remount the new
    // render forces.
    expect(await screen.findByText('my-logo.svg')).toBeDefined();
    expect(mockToastSuccess).toHaveBeenCalledWith('Loaded my-logo.svg');

    // Replacing the artwork marks the row modified, exactly as overriding a
    // parameter does, and the same indicator puts the project's file back.
    fireEvent.click(screen.getByRole('button', { name: 'Reset to yaa.svg' }));

    await waitFor(() => {
      expect(screen.getByText('yaa.svg')).toBeDefined();
    });
    const [resetPath, resetBytes] = mockWriteProjectFile.mock.calls.at(-1)!;
    expect(resetPath).toBe('yaa.svg');
    expect(new TextDecoder().decode(resetBytes).startsWith('<?xml')).toBe(true);
    expect(screen.queryByText('my-logo.svg')).toBeNull();
    expect(mockToastSuccess).toHaveBeenCalledWith('Restored yaa.svg');
  });

  it('dispatches direct OpenCascade exports through the same preview actor', async () => {
    globalThis.history.replaceState({}, '', '/?model=opencascade-box');

    renderPlaygroundRoot();
    const stepButtons = await screen.findAllByRole('button', { name: 'STEP' });
    fireEvent.click(stepButtons[0]!);

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
      <KeyboardProvider>
        <PlaygroundRoot loaderData={loaderData} />
      </KeyboardProvider>
    </MemoryRouter>,
  );
}

function readCodeEditorValue(): string {
  const editor = screen.getByLabelText('Code editor');
  if (!(editor instanceof HTMLTextAreaElement)) {
    throw new TypeError('Expected the code editor mock to render a textarea');
  }
  return editor.value;
}
